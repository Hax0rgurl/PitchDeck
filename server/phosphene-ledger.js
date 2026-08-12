import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from './atomic-json.js';

const LEGACY_SCHEMAS = new Set([
  'pitchdeck/phosphene-job-ledger@1',
  'pitchdeck/phosphene-job-ledger@2'
]);
const SCHEMA = 'pitchdeck/phosphene-job-ledger@3';

function requiredId(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > 240) throw new Error(`${label} must be 240 characters or fewer`);
  return normalized;
}

export function normalizePhospheneAttempt(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('attempt must be a nonnegative integer');
  }
  return value;
}

function entryKey(runId, studioShotId, attempt) {
  return JSON.stringify([runId, studioShotId, attempt]);
}

export function phospheneIdempotencyMarker(runIdValue, studioShotIdValue, attemptValue) {
  const runId = requiredId(runIdValue, 'runId');
  const studioShotId = requiredId(studioShotIdValue, 'studioShotId');
  const attempt = normalizePhospheneAttempt(attemptValue);
  const digest = crypto.createHash('sha256')
    .update(entryKey(runId, studioShotId, attempt))
    .digest('hex');
  return `pitchdeck-idem-${digest}`;
}

export function phospheneSubmissionLabel(markerValue, displayLabel = '') {
  const marker = requiredId(markerValue, 'idempotency marker');
  const display = String(displayLabel || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  return display ? `${marker} · ${display}` : marker;
}

function jobLabel(job = {}) {
  return String(
    job.params?.label
      || job.params?.preset_label
      || job.label
      || job.preset_label
      || ''
  );
}

export function findPhospheneJobByMarker(snapshot = {}, markerValue = '') {
  const marker = requiredId(markerValue, 'idempotency marker');
  const candidates = [
    snapshot.current,
    ...(Array.isArray(snapshot.queue) ? snapshot.queue : []),
    ...(Array.isArray(snapshot.history) ? snapshot.history : [])
  ].filter(Boolean);
  const matches = new Map();
  for (const job of candidates) {
    const id = String(job?.id || '').trim();
    if (id && jobLabel(job).includes(marker)) matches.set(id, job);
  }
  if (matches.size > 1) {
    const error = new Error(`Multiple Phosphene jobs carry idempotency marker ${marker}`);
    error.code = 'PHOSPHENE_MARKER_AMBIGUOUS';
    throw error;
  }
  const [id, raw] = matches.entries().next().value || [];
  if (!id) return null;
  return {
    id,
    uploadedPath: String(raw?.params?.image || raw?.params?.image_path || ''),
    job: { ok: true, id, recovered: true }
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export class PhospheneSubmissionUnprovenError extends Error {
  constructor(record, detail = '') {
    super(
      `Phosphene submission ${record.marker} is pending but cannot be proven accepted; `
      + `refusing to resubmit the same attempt${detail ? ` (${detail})` : ''}`
    );
    this.name = 'PhospheneSubmissionUnprovenError';
    this.code = 'PHOSPHENE_SUBMISSION_UNPROVEN';
    this.marker = record.marker;
  }
}

export class PhospheneJobLedger {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.entries = new Map();
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
      throw new Error(`Cannot read Phosphene job ledger: ${error.message}`);
    }
    if (![...LEGACY_SCHEMAS, SCHEMA].includes(parsed?.schema) || !Array.isArray(parsed.entries)) {
      throw new Error('Cannot read Phosphene job ledger: unsupported or malformed schema');
    }
    const loaded = new Map();
    for (const raw of parsed.entries) {
      const runId = requiredId(raw?.runId, 'ledger runId');
      const studioShotId = requiredId(raw?.studioShotId, 'ledger studioShotId');
      const attempt = normalizePhospheneAttempt(raw?.attempt);
      const marker = String(raw?.marker || phospheneIdempotencyMarker(runId, studioShotId, attempt));
      const state = LEGACY_SCHEMAS.has(parsed.schema) ? 'accepted' : String(raw?.state || '');
      const base = {
        state,
        runId,
        studioShotId,
        attempt,
        marker,
        pendingAt: String(raw?.pendingAt || raw?.acceptedAt || '')
      };
      let record;
      if (state === 'pending') {
        record = base;
      } else if (state === 'accepted') {
        const id = requiredId(raw?.id, 'ledger job id');
        record = {
          ...base,
          id,
          uploadedPath: String(raw?.uploadedPath || ''),
          job: clone(raw?.job || { id }),
          acceptedAt: String(raw?.acceptedAt || '')
        };
      } else {
        throw new Error(`Cannot read Phosphene job ledger: invalid state for ${marker}`);
      }
      loaded.set(entryKey(runId, studioShotId, attempt), record);
    }
    this.entries = loaded;
    this.loaded = true;
  }

  async #persist() {
    await atomicWriteJson(this.filePath, {
      schema: SCHEMA,
      updatedAt: new Date().toISOString(),
      entries: [...this.entries.values()]
        .sort((a, b) => entryKey(a.runId, a.studioShotId, a.attempt)
          .localeCompare(entryKey(b.runId, b.studioShotId, b.attempt)))
    });
  }

  #acceptedRecord(pending, accepted) {
    const id = requiredId(accepted?.job?.id || accepted?.id, 'accepted Phosphene job id');
    return {
      ...pending,
      state: 'accepted',
      id,
      uploadedPath: String(accepted?.uploadedPath || ''),
      job: clone(accepted?.job || { id }),
      acceptedAt: new Date().toISOString()
    };
  }

  async #commitAccepted(key, pending, accepted) {
    const record = this.#acceptedRecord(pending, accepted);
    this.entries.set(key, record);
    try {
      await this.#persist();
    } catch (error) {
      this.entries.set(key, pending);
      throw new Error(
        `Phosphene accepted job ${record.id}, but its acceptance could not be committed; `
        + `pending marker ${pending.marker} will be reconciled on retry: ${error.message}`
      );
    }
    return record;
  }

  async getOrCreate(runIdValue, studioShotIdValue, attemptValue, handlersValue) {
    const runId = requiredId(runIdValue, 'runId');
    const studioShotId = requiredId(studioShotIdValue, 'studioShotId');
    const compatibilityCall = typeof attemptValue === 'function' && handlersValue === undefined;
    const attempt = normalizePhospheneAttempt(compatibilityCall ? undefined : attemptValue);
    const handlers = compatibilityCall
      ? { createJob: attemptValue, reconcile: async () => null }
      : (typeof handlersValue === 'function'
          ? { createJob: handlersValue, reconcile: async () => null }
          : handlersValue || {});
    if (typeof handlers.createJob !== 'function') throw new TypeError('createJob must be a function');
    if (typeof handlers.reconcile !== 'function') throw new TypeError('reconcile must be a function');

    return this.#withLock(async () => {
      await this.#load();
      const key = entryKey(runId, studioShotId, attempt);
      const existing = this.entries.get(key);
      if (existing?.state === 'accepted') {
        return { record: clone(existing), reused: true, recovered: false };
      }
      if (existing?.state === 'pending') {
        const recovered = await handlers.reconcile(clone(existing), { phase: 'pending-retry' });
        if (!recovered) throw new PhospheneSubmissionUnprovenError(existing);
        const record = await this.#commitAccepted(key, existing, recovered);
        return { record: clone(record), reused: true, recovered: true };
      }

      const pending = {
        state: 'pending',
        runId,
        studioShotId,
        attempt,
        marker: phospheneIdempotencyMarker(runId, studioShotId, attempt),
        pendingAt: new Date().toISOString()
      };
      this.entries.set(key, pending);
      try {
        await this.#persist();
      } catch (error) {
        this.entries.delete(key);
        throw new Error(`Cannot persist Phosphene submission intent: ${error.message}`);
      }

      let accepted;
      try {
        accepted = await handlers.createJob(clone(pending));
      } catch (submissionError) {
        const recovered = await handlers.reconcile(clone(pending), {
          phase: 'submission-error',
          submissionError
        });
        if (!recovered) {
          throw new PhospheneSubmissionUnprovenError(pending, submissionError.message);
        }
        const record = await this.#commitAccepted(key, pending, recovered);
        return { record: clone(record), reused: true, recovered: true };
      }
      const record = await this.#commitAccepted(key, pending, accepted);
      return { record: clone(record), reused: false, recovered: false };
    });
  }

  async get(runIdValue, studioShotIdValue, attemptValue) {
    const runId = requiredId(runIdValue, 'runId');
    const studioShotId = requiredId(studioShotIdValue, 'studioShotId');
    const attempt = normalizePhospheneAttempt(attemptValue);
    return this.#withLock(async () => {
      await this.#load();
      return clone(this.entries.get(entryKey(runId, studioShotId, attempt)) || null);
    });
  }
}
