import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from './atomic-json.js';

const SCHEMA = 'pitchdeck/phosphene-terminal-jobs@1';
const TERMINAL_STATUSES = new Set(['done', 'failed']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function requiredJobId(value) {
  const id = String(value || '').trim();
  if (!id) throw new Error('Terminal Phosphene job id is required');
  if (id.length > 240) throw new Error('Terminal Phosphene job id must be 240 characters or fewer');
  return id;
}

function uniqueJobIds(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function normalizeTerminalOutputPath(value) {
  const outputPath = String(value || '').trim();
  if (!outputPath) return '';
  if (outputPath.includes('\0') || !path.isAbsolute(outputPath)) {
    throw new Error('Terminal Phosphene output path must be an absolute local path');
  }
  const normalized = path.normalize(outputPath);
  if (path.extname(normalized).toLowerCase() !== '.mp4') {
    throw new Error('Terminal Phosphene output path must reference an MP4 file');
  }
  return normalized;
}

function normalizedTerminalRecord(raw) {
  const id = requiredJobId(raw?.id);
  const status = String(raw?.status || '').trim().toLowerCase();
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error(`Phosphene job ${id} is not terminal`);
  }
  return {
    id,
    status,
    outputPath: status === 'done' ? normalizeTerminalOutputPath(raw?.outputPath) : '',
    error: status === 'failed' ? String(raw?.error || 'Render failed').slice(0, 16000) : '',
    observedAt: String(raw?.observedAt || '')
  };
}

export function mergePhospheneJobResults(ids, liveResult = {}, durableJobs = []) {
  const liveById = new Map((liveResult.jobs || []).map(job => [String(job.id), job]));
  const durableById = new Map((durableJobs || []).map(job => [String(job.id), job]));
  const jobs = [];
  const missingIds = [];
  for (const id of uniqueJobIds(ids)) {
    const live = liveById.get(id);
    const durable = durableById.get(id);
    const job = live && TERMINAL_STATUSES.has(live.status) ? (durable || live) : (live || durable);
    if (job) jobs.push(clone(job));
    else missingIds.push(id);
  }
  return { jobs, missingIds };
}

export class PhospheneTerminalStore {
  constructor(filePath, { allowedOutputRoots = [] } = {}) {
    this.filePath = path.resolve(filePath);
    this.allowedOutputRoots = [...new Set(
      allowedOutputRoots.map(value => String(value || '').trim()).filter(Boolean).map(value => path.resolve(value))
    )];
    this.records = new Map();
    this.loaded = false;
    this.operationTail = Promise.resolve();
    this.resolvedRootsPromise = null;
  }

  async #withLock(operation) {
    const pending = this.operationTail.then(operation, operation);
    this.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #resolvedRoots() {
    if (!this.resolvedRootsPromise) {
      this.resolvedRootsPromise = Promise.all(this.allowedOutputRoots.map(async root => (
        fs.realpath(root).catch(() => root)
      )));
    }
    return this.resolvedRootsPromise;
  }

  async #assertAllowedPath(outputPath) {
    if (!outputPath) return;
    const roots = await this.#resolvedRoots();
    if (roots.length && !roots.some(root => pathInside(root, outputPath))) {
      throw new Error('Terminal Phosphene output path is outside configured output roots');
    }
  }

  async #canonicalObservedPath(value) {
    const normalized = normalizeTerminalOutputPath(value);
    if (!normalized) return '';
    const canonical = await fs.realpath(normalized);
    if (path.extname(canonical).toLowerCase() !== '.mp4') {
      throw new Error('Terminal Phosphene output target must be an MP4 file');
    }
    await this.#assertAllowedPath(canonical);
    const stat = await fs.stat(canonical);
    if (!stat.isFile()) throw new Error('Terminal Phosphene output target is not a regular file');
    return canonical;
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
      throw new Error(`Cannot read terminal Phosphene job store: ${error.message}`);
    }
    if (parsed?.schema !== SCHEMA || !Array.isArray(parsed.jobs)) {
      throw new Error('Cannot read terminal Phosphene job store: unsupported or malformed schema');
    }
    const loaded = new Map();
    for (const raw of parsed.jobs) {
      const record = normalizedTerminalRecord(raw);
      if (loaded.has(record.id)) {
        throw new Error(`Cannot read terminal Phosphene job store: duplicate job id ${record.id}`);
      }
      await this.#assertAllowedPath(record.outputPath);
      loaded.set(record.id, record);
    }
    this.records = loaded;
    this.loaded = true;
  }

  async #persist() {
    await atomicWriteJson(this.filePath, {
      schema: SCHEMA,
      updatedAt: new Date().toISOString(),
      jobs: [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id))
    });
  }

  async observe(jobs = []) {
    return this.#withLock(async () => {
      await this.#load();
      const previous = new Map(this.records);
      let changed = false;
      try {
        for (const raw of jobs) {
          if (!TERMINAL_STATUSES.has(String(raw?.status || '').toLowerCase())) continue;
          const normalized = normalizedTerminalRecord(raw);
          if (normalized.status === 'done' && normalized.outputPath) {
            try {
              normalized.outputPath = await this.#canonicalObservedPath(normalized.outputPath);
            } catch (error) {
              // Phosphene can retain a terminal history row after its media was
              // manually removed. Preserve the terminal receipt without
              // inventing a playable file; a later observation can repair it.
              if (error?.code === 'ENOENT') normalized.outputPath = '';
              else throw error;
            }
          }
          const existing = this.records.get(normalized.id);
          if (normalized.status === 'done' && !normalized.outputPath && existing?.status === 'done') {
            normalized.outputPath = existing.outputPath;
          }
          const same = existing
            && existing.status === normalized.status
            && existing.outputPath === normalized.outputPath
            && existing.error === normalized.error;
          if (same) continue;
          normalized.observedAt = new Date().toISOString();
          this.records.set(normalized.id, normalized);
          changed = true;
        }
        if (changed) {
          await this.#persist();
        }
      } catch (error) {
        this.records = previous;
        throw error;
      }
      return clone([...this.records.values()]);
    });
  }

  async getMany(ids = []) {
    return this.#withLock(async () => {
      await this.#load();
      return uniqueJobIds(ids)
        .map(id => this.records.get(id))
        .filter(Boolean)
        .map(clone);
    });
  }

  async resolveOutputPath(value) {
    const normalized = normalizeTerminalOutputPath(value);
    if (!normalized) throw new Error('Completed Phosphene job has no output path');
    await this.#assertAllowedPath(normalized);
    const canonical = await fs.realpath(normalized);
    if (canonical !== normalized) {
      throw new Error('Persisted Phosphene output path no longer resolves to its observed file');
    }
    await this.#assertAllowedPath(canonical);
    const stat = await fs.stat(canonical);
    if (!stat.isFile()) throw new Error('Completed Phosphene output is not a regular file');
    return canonical;
  }
}
