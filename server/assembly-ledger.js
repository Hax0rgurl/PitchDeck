import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from './atomic-json.js';

const LEGACY_SCHEMA = 'pitchdeck/phosphene-assembly-receipts@1';
const SCHEMA = 'pitchdeck/phosphene-assembly-receipts@2';
export const MAX_ASSEMBLY_JOB_IDS = 5000;

function requiredRunId(value) {
  const runId = String(value || '').trim();
  if (!runId) throw new Error('runId is required for idempotent assembly');
  if (runId.length > 240) throw new Error('runId must be 240 characters or fewer');
  return runId;
}

export function normalizeAssemblyIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ASSEMBLY_JOB_IDS) {
    throw new Error(`ids must be an array containing 1 to ${MAX_ASSEMBLY_JOB_IDS} job ids in playback order`);
  }
  return value.map((rawId, index) => {
    const id = String(rawId || '').trim();
    if (!id) throw new Error(`ids[${index}] must be a non-empty job id`);
    if (id.length > 240) throw new Error(`ids[${index}] must be 240 characters or fewer`);
    return id;
  });
}

function sameOrderedIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function deterministicAssemblyIntent(runIdValue, idsValue, generatedRoot) {
  const runId = requiredRunId(runIdValue);
  const ids = normalizeAssemblyIds(idsValue);
  const root = path.resolve(String(generatedRoot || ''));
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([runId, ids]))
    .digest('hex');
  const fileName = `pitchdeck-assembly-${digest}.mp4`;
  return {
    identity: digest,
    outputPath: path.join(root, fileName),
    partialPath: path.join(root, `.${fileName}.partial.mp4`),
    fileName
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizedIntent(value) {
  const identity = String(value?.identity || '').trim();
  const outputPath = String(value?.outputPath || '').trim();
  const partialPath = String(value?.partialPath || '').trim();
  const fileName = String(value?.fileName || '').trim();
  if (!identity || !outputPath || !partialPath || !fileName) {
    throw new Error('Assembly intent is incomplete');
  }
  return { identity, outputPath, partialPath, fileName };
}

export class AssemblyRunConflictError extends Error {
  constructor(runId) {
    super(`Assembly run ${runId} is already locked to a different ordered job list`);
    this.name = 'AssemblyRunConflictError';
    this.code = 'ASSEMBLY_RUN_CONFLICT';
  }
}

export class AssemblyReceiptLedger {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.receipts = new Map();
    this.loaded = false;
    this.operationTail = Promise.resolve();
  }

  async #withLock(operation) {
    const pending = this.operationTail.then(operation, operation);
    this.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #load() {
    if (this.loaded) return;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      throw new Error(`Cannot read assembly receipt ledger: ${error.message}`);
    }
    if (![LEGACY_SCHEMA, SCHEMA].includes(parsed?.schema) || !Array.isArray(parsed.receipts)) {
      throw new Error('Cannot read assembly receipt ledger: unsupported or malformed schema');
    }
    const loaded = new Map();
    for (const raw of parsed.receipts) {
      const runId = requiredRunId(raw?.runId);
      if (loaded.has(runId)) throw new Error(`Cannot read assembly receipt ledger: duplicate runId ${runId}`);
      const ids = normalizeAssemblyIds(raw?.ids);
      const state = parsed.schema === LEGACY_SCHEMA ? 'completed' : String(raw?.state || '');
      const outputPath = String(raw?.outputPath || '').trim();
      const fileName = String(raw?.fileName || '').trim();
      const partialPath = String(raw?.partialPath || `${outputPath}.partial.mp4`).trim();
      const identity = String(raw?.identity || crypto.createHash('sha256')
        .update(JSON.stringify([runId, ids]))
        .digest('hex'));
      if (!outputPath || !fileName || !partialPath || !identity) {
        throw new Error(`Cannot read assembly receipt ledger: malformed intent for ${runId}`);
      }
      const base = {
        state,
        runId,
        ids,
        identity,
        outputPath,
        partialPath,
        fileName,
        pendingAt: String(raw?.pendingAt || raw?.completedAt || '')
      };
      let receipt;
      if (state === 'pending') {
        receipt = base;
      } else if (state === 'completed') {
        const bytes = Number(raw?.bytes);
        const mode = String(raw?.mode || '').trim();
        if (!Number.isSafeInteger(bytes) || bytes < 1 || !mode) {
          throw new Error(`Cannot read assembly receipt ledger: malformed completion for ${runId}`);
        }
        receipt = {
          ...base,
          bytes,
          mode,
          completedAt: String(raw?.completedAt || '')
        };
      } else {
        throw new Error(`Cannot read assembly receipt ledger: invalid state for ${runId}`);
      }
      loaded.set(runId, receipt);
    }
    this.receipts = loaded;
    this.loaded = true;
  }

  async #persist() {
    await atomicWriteJson(this.filePath, {
      schema: SCHEMA,
      updatedAt: new Date().toISOString(),
      receipts: [...this.receipts.values()].sort((a, b) => a.runId.localeCompare(b.runId))
    });
  }

  #completedRecord(pending, result) {
    const bytes = Number(result?.bytes);
    const mode = String(result?.mode || '').trim();
    if (!Number.isSafeInteger(bytes) || bytes < 1 || !mode) {
      throw new Error('Assembly completed without valid size and mode metadata');
    }
    if (result?.outputPath && path.resolve(result.outputPath) !== path.resolve(pending.outputPath)) {
      throw new Error('Assembly callback returned a different output path than its durable intent');
    }
    return {
      ...pending,
      state: 'completed',
      bytes,
      mode,
      completedAt: new Date().toISOString()
    };
  }

  async #commitCompleted(runId, pending, result) {
    const completed = this.#completedRecord(pending, result);
    this.receipts.set(runId, completed);
    try {
      await this.#persist();
    } catch (error) {
      this.receipts.set(runId, pending);
      throw new Error(
        `Assembly output exists but its completion receipt could not be committed; `
        + `pending intent will recover it on retry: ${error.message}`
      );
    }
    return completed;
  }

  async getOrCreate(runIdValue, idsValue, intentValue, handlers = {}) {
    const runId = requiredRunId(runIdValue);
    const ids = normalizeAssemblyIds(idsValue);
    const intent = normalizedIntent(intentValue);
    if (typeof handlers.recover !== 'function') throw new TypeError('recover must be a function');
    if (typeof handlers.createReceipt !== 'function') throw new TypeError('createReceipt must be a function');

    return this.#withLock(async () => {
      await this.#load();
      let record = this.receipts.get(runId);
      let repaired = false;
      if (record && !sameOrderedIds(record.ids, ids)) throw new AssemblyRunConflictError(runId);

      if (!record) {
        record = {
          state: 'pending',
          runId,
          ids,
          ...intent,
          pendingAt: new Date().toISOString()
        };
        this.receipts.set(runId, record);
        try {
          await this.#persist();
        } catch (error) {
          this.receipts.delete(runId);
          throw new Error(`Cannot persist assembly intent: ${error.message}`);
        }
      }

      const recovered = await handlers.recover(clone(record));
      if (recovered) {
        const unchanged = record.state === 'completed'
          && Number(recovered.bytes) === record.bytes
          && String(recovered.mode || record.mode) === record.mode;
        if (unchanged) {
          return { receipt: clone(record), reused: true, recovered: false, repaired: false };
        }
        const completed = await this.#commitCompleted(runId, record, {
          ...recovered,
          mode: recovered.mode || record.mode || 'recovered'
        });
        return {
          receipt: clone(completed),
          reused: true,
          recovered: record.state === 'pending',
          repaired: record.state === 'completed'
        };
      }

      if (record.state === 'completed') {
        record = {
          state: 'pending',
          runId,
          ids,
          identity: record.identity,
          outputPath: record.outputPath,
          partialPath: record.partialPath,
          fileName: record.fileName,
          pendingAt: new Date().toISOString(),
          invalidatedAt: new Date().toISOString()
        };
        this.receipts.set(runId, record);
        await this.#persist();
        repaired = true;
      }

      const created = await handlers.createReceipt(clone(record));
      const completed = await this.#commitCompleted(runId, record, created);
      return {
        receipt: clone(completed),
        reused: false,
        recovered: false,
        repaired
      };
    });
  }
}
