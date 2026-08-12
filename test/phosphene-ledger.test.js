import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  findPhospheneJobByMarker,
  normalizePhospheneAttempt,
  phospheneIdempotencyMarker,
  phospheneSubmissionLabel,
  PhospheneJobLedger,
  PhospheneSubmissionUnprovenError
} from '../server/phosphene-ledger.js';

async function temporaryLedger(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchdeck-ledger-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'generated', 'phosphene-job-ledger.json');
}

const noRecovery = async () => null;
const accepted = id => ({ uploadedPath: '', job: { ok: true, id } });

test('persists a pending intent before external submission, then commits acceptance', async t => {
  const filePath = await temporaryLedger(t);
  const ledger = new PhospheneJobLedger(filePath);
  let pendingOnDisk;
  const result = await ledger.getOrCreate('run-1', 'shot-1', 0, {
    reconcile: noRecovery,
    createJob: async pending => {
      const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
      pendingOnDisk = disk.entries[0];
      assert.equal(disk.schema, 'pitchdeck/phosphene-job-ledger@3');
      assert.equal(pendingOnDisk.state, 'pending');
      assert.equal(pendingOnDisk.marker, pending.marker);
      return accepted('job-1');
    }
  });

  assert.equal(result.reused, false);
  assert.equal(result.recovered, false);
  assert.equal(result.record.state, 'accepted');
  assert.equal(result.record.id, 'job-1');
  const committed = JSON.parse(await fs.readFile(filePath, 'utf8')).entries[0];
  assert.equal(committed.state, 'accepted');
  assert.equal(committed.marker, pendingOnDisk.marker);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test('reconciles a crash-window pending marker after restart without resubmitting', async t => {
  const filePath = await temporaryLedger(t);
  const firstProcess = new PhospheneJobLedger(filePath);
  await assert.rejects(
    firstProcess.getOrCreate('crash-run', 'shot-4', 0, {
      createJob: async () => { throw new Error('response connection was lost'); },
      reconcile: noRecovery
    }),
    error => error instanceof PhospheneSubmissionUnprovenError
  );
  const pending = JSON.parse(await fs.readFile(filePath, 'utf8')).entries[0];
  assert.equal(pending.state, 'pending');

  let submissions = 0;
  const restarted = new PhospheneJobLedger(filePath);
  const recovered = await restarted.getOrCreate('crash-run', 'shot-4', 0, {
    createJob: async () => {
      submissions += 1;
      return accepted('duplicate');
    },
    reconcile: async record => {
      assert.equal(record.marker, pending.marker);
      return accepted('recovered-job');
    }
  });
  assert.equal(submissions, 0);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.record.id, 'recovered-job');
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).entries[0].state, 'accepted');
});

test('fails safely when a pending submission cannot be proven and permits a new attempt', async t => {
  const filePath = await temporaryLedger(t);
  const ledger = new PhospheneJobLedger(filePath);
  await assert.rejects(
    ledger.getOrCreate('uncertain-run', 'shot-1', 0, {
      createJob: async () => { throw new Error('timeout'); },
      reconcile: noRecovery
    }),
    /refusing to resubmit the same attempt/
  );

  const restarted = new PhospheneJobLedger(filePath);
  let sameAttemptSubmissions = 0;
  await assert.rejects(
    restarted.getOrCreate('uncertain-run', 'shot-1', 0, {
      createJob: async () => {
        sameAttemptSubmissions += 1;
        return accepted('duplicate');
      },
      reconcile: noRecovery
    }),
    error => error.code === 'PHOSPHENE_SUBMISSION_UNPROVEN'
  );
  const nextAttempt = await restarted.getOrCreate('uncertain-run', 'shot-1', 1, {
    createJob: async () => accepted('attempt-1-job'),
    reconcile: noRecovery
  });
  assert.equal(sameAttemptSubmissions, 0);
  assert.equal(nextAttempt.reused, false);
  assert.equal(nextAttempt.record.attempt, 1);
});

test('finds a deterministic marker in current, queue, or history without inferring terminality', () => {
  const marker = phospheneIdempotencyMarker('marker-run', 'shot-2', 3);
  assert.equal(marker, phospheneIdempotencyMarker('marker-run', 'shot-2', 3));
  assert.notEqual(marker, phospheneIdempotencyMarker('marker-run', 'shot-2', 4));
  const label = phospheneSubmissionLabel(marker, 'Scene 2 Shot 4');
  const failed = {
    id: 'failed-job',
    status: 'failed',
    params: { label, image: '/uploads/ref.png' }
  };
  assert.deepEqual(findPhospheneJobByMarker({ history: [failed] }, marker), {
    id: 'failed-job',
    uploadedPath: '/uploads/ref.png',
    job: { ok: true, id: 'failed-job', recovered: true }
  });
  assert.equal(findPhospheneJobByMarker({ current: null, queue: [], history: [] }, marker), null);
  assert.throws(
    () => findPhospheneJobByMarker({
      current: { id: 'one', params: { label } },
      queue: [{ id: 'two', params: { label } }]
    }, marker),
    error => error.code === 'PHOSPHENE_MARKER_AMBIGUOUS'
  );
});

test('keeps accepted shots durable when a later shot becomes uncertain', async t => {
  const filePath = await temporaryLedger(t);
  const ledger = new PhospheneJobLedger(filePath);
  await ledger.getOrCreate('partial-run', 'shot-1', 0, {
    createJob: async () => accepted('job-a'),
    reconcile: noRecovery
  });
  await assert.rejects(
    ledger.getOrCreate('partial-run', 'shot-2', 0, {
      createJob: async () => { throw new Error('lost response'); },
      reconcile: noRecovery
    }),
    /cannot be proven accepted/
  );

  const restarted = new PhospheneJobLedger(filePath);
  let duplicateSubmissions = 0;
  const first = await restarted.getOrCreate('partial-run', 'shot-1', 0, {
    createJob: async () => {
      duplicateSubmissions += 1;
      return accepted('duplicate');
    },
    reconcile: noRecovery
  });
  assert.equal(first.reused, true);
  assert.equal(first.record.id, 'job-a');
  assert.equal(duplicateSubmissions, 0);
});

test('serializes concurrent retries to one external submission', async t => {
  const filePath = await temporaryLedger(t);
  const ledger = new PhospheneJobLedger(filePath);
  let submissions = 0;
  const handlers = {
    reconcile: noRecovery,
    createJob: async () => {
      submissions += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return accepted('one-job');
    }
  };
  const results = await Promise.all([
    ledger.getOrCreate('same-run', 'same-shot', 0, handlers),
    ledger.getOrCreate('same-run', 'same-shot', 0, handlers)
  ]);
  assert.equal(submissions, 1);
  assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
});

test('loads legacy accepted records as attempt zero', async t => {
  const filePath = await temporaryLedger(t);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    schema: 'pitchdeck/phosphene-job-ledger@1',
    entries: [{
      runId: 'legacy-run',
      studioShotId: 'legacy-shot',
      id: 'legacy-job',
      job: { id: 'legacy-job' },
      acceptedAt: '2026-01-01T00:00:00.000Z'
    }]
  }));
  const ledger = new PhospheneJobLedger(filePath);
  const restored = await ledger.get('legacy-run', 'legacy-shot');
  assert.equal(restored.state, 'accepted');
  assert.equal(restored.attempt, 0);
  assert.equal(restored.id, 'legacy-job');
  assert.equal(normalizePhospheneAttempt(undefined), 0);
});
