import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  AssemblyReceiptLedger,
  AssemblyRunConflictError,
  deterministicAssemblyIntent,
  MAX_ASSEMBLY_JOB_IDS,
  normalizeAssemblyIds
} from '../server/assembly-ledger.js';

async function temporaryLedger(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchdeck-assembly-ledger-test-'));
  const generated = path.join(directory, 'generated');
  await fs.mkdir(generated, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    generated,
    filePath: path.join(generated, 'phosphene-assembly-receipts.json')
  };
}

async function recoverFile(record) {
  const stat = await fs.stat(record.outputPath).catch(() => null);
  if (!stat?.isFile() || stat.size < 1) return null;
  return { outputPath: record.outputPath, bytes: stat.size, mode: record.mode || 'recovered' };
}

test('persists deterministic pending intent before local assembly work', async t => {
  const { generated, filePath } = await temporaryLedger(t);
  const ids = ['job-a', 'job-b'];
  const intent = deterministicAssemblyIntent('run-one', ids, generated);
  assert.deepEqual(intent, deterministicAssemblyIntent('run-one', ids, generated));
  assert.notEqual(intent.outputPath, deterministicAssemblyIntent('run-one', [...ids].reverse(), generated).outputPath);

  let pendingOnDisk;
  const ledger = new AssemblyReceiptLedger(filePath);
  const result = await ledger.getOrCreate('run-one', ids, intent, {
    recover: recoverFile,
    createReceipt: async record => {
      const disk = JSON.parse(await fs.readFile(filePath, 'utf8'));
      pendingOnDisk = disk.receipts[0];
      assert.equal(disk.schema, 'pitchdeck/phosphene-assembly-receipts@2');
      assert.equal(pendingOnDisk.state, 'pending');
      assert.equal(pendingOnDisk.outputPath, intent.outputPath);
      await fs.writeFile(record.outputPath, 'assembled bytes');
      return { outputPath: record.outputPath, bytes: 15, mode: 'copy' };
    }
  });
  assert.equal(result.reused, false);
  assert.equal(result.receipt.state, 'completed');
  assert.equal(result.receipt.bytes, 15);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await fs.readdir(generated)).sort(),
    [intent.fileName, 'phosphene-assembly-receipts.json'].sort()
  );
});

test('recovers a deterministic final created before a crash could commit its receipt', async t => {
  const { generated, filePath } = await temporaryLedger(t);
  const ids = ['job-crash'];
  const intent = deterministicAssemblyIntent('crash-run', ids, generated);
  const firstProcess = new AssemblyReceiptLedger(filePath);
  await assert.rejects(
    firstProcess.getOrCreate('crash-run', ids, intent, {
      recover: recoverFile,
      createReceipt: async record => {
        await fs.writeFile(record.outputPath, 'final survived crash');
        throw new Error('simulated crash before receipt commit');
      }
    }),
    /simulated crash/
  );
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).receipts[0].state, 'pending');

  let rerenders = 0;
  const restarted = new AssemblyReceiptLedger(filePath);
  const recovered = await restarted.getOrCreate('crash-run', ids, intent, {
    recover: recoverFile,
    createReceipt: async () => {
      rerenders += 1;
      throw new Error('must not rerender');
    }
  });
  assert.equal(rerenders, 0);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.receipt.state, 'completed');
  assert.equal(recovered.receipt.mode, 'recovered');
});

test('invalidates a missing completed output and repairs it instead of returning a permanent stale error', async t => {
  const { generated, filePath } = await temporaryLedger(t);
  const ids = ['job-repair'];
  const intent = deterministicAssemblyIntent('repair-run', ids, generated);
  const first = new AssemblyReceiptLedger(filePath);
  await first.getOrCreate('repair-run', ids, intent, {
    recover: recoverFile,
    createReceipt: async record => {
      await fs.writeFile(record.outputPath, 'first cut');
      return { outputPath: record.outputPath, bytes: 9, mode: 'copy' };
    }
  });
  await fs.rm(intent.outputPath);

  let repairs = 0;
  const restarted = new AssemblyReceiptLedger(filePath);
  const repaired = await restarted.getOrCreate('repair-run', ids, intent, {
    recover: recoverFile,
    createReceipt: async record => {
      repairs += 1;
      const content = 'repaired final cut';
      await fs.writeFile(record.outputPath, content);
      return { outputPath: record.outputPath, bytes: Buffer.byteLength(content), mode: 'transcode' };
    }
  });
  assert.equal(repairs, 1);
  assert.equal(repaired.reused, false);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.receipt.mode, 'transcode');
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).receipts[0].state, 'completed');
});

test('repairs stale size metadata from a valid final without rerendering', async t => {
  const { generated, filePath } = await temporaryLedger(t);
  const ids = ['job-size'];
  const intent = deterministicAssemblyIntent('size-run', ids, generated);
  const first = new AssemblyReceiptLedger(filePath);
  await first.getOrCreate('size-run', ids, intent, {
    recover: recoverFile,
    createReceipt: async record => {
      await fs.writeFile(record.outputPath, 'small');
      return { outputPath: record.outputPath, bytes: 5, mode: 'copy' };
    }
  });
  await fs.writeFile(intent.outputPath, 'a valid but larger final');

  let rerenders = 0;
  const restarted = new AssemblyReceiptLedger(filePath);
  const repaired = await restarted.getOrCreate('size-run', ids, intent, {
    recover: recoverFile,
    createReceipt: async () => {
      rerenders += 1;
      throw new Error('must not rerender');
    }
  });
  assert.equal(rerenders, 0);
  assert.equal(repaired.reused, true);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.receipt.bytes, Buffer.byteLength('a valid but larger final'));
});

test('rejects changed or reordered IDs for an existing run before repair work', async t => {
  const { generated, filePath } = await temporaryLedger(t);
  const ids = ['job-a', 'job-b'];
  const intent = deterministicAssemblyIntent('locked-run', ids, generated);
  const ledger = new AssemblyReceiptLedger(filePath);
  await ledger.getOrCreate('locked-run', ids, intent, {
    recover: recoverFile,
    createReceipt: async record => {
      await fs.writeFile(record.outputPath, 'locked');
      return { outputPath: record.outputPath, bytes: 6, mode: 'copy' };
    }
  });
  let callbacks = 0;
  await assert.rejects(
    ledger.getOrCreate(
      'locked-run',
      ['job-b', 'job-a'],
      deterministicAssemblyIntent('locked-run', ['job-b', 'job-a'], generated),
      {
        recover: async () => { callbacks += 1; return null; },
        createReceipt: async () => { callbacks += 1; return null; }
      }
    ),
    error => error instanceof AssemblyRunConflictError && error.code === 'ASSEMBLY_RUN_CONFLICT'
  );
  assert.equal(callbacks, 0);
});

test('supports bounded assemblies above 500 IDs and serializes identical calls', async t => {
  const { generated, filePath } = await temporaryLedger(t);
  const ids = Array.from({ length: 501 }, (_, index) => `job-${index}`);
  const intent = deterministicAssemblyIntent('long-run', ids, generated);
  const ledger = new AssemblyReceiptLedger(filePath);
  let assemblies = 0;
  const handlers = {
    recover: recoverFile,
    createReceipt: async record => {
      assemblies += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      await fs.writeFile(record.outputPath, 'long');
      return { outputPath: record.outputPath, bytes: 4, mode: 'copy' };
    }
  };
  const results = await Promise.all([
    ledger.getOrCreate('long-run', ids, intent, handlers),
    ledger.getOrCreate('long-run', ids, intent, handlers)
  ]);
  assert.equal(assemblies, 1);
  assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
  assert.equal(normalizeAssemblyIds(Array(MAX_ASSEMBLY_JOB_IDS).fill('job')).length, MAX_ASSEMBLY_JOB_IDS);
  assert.throws(
    () => normalizeAssemblyIds(Array(MAX_ASSEMBLY_JOB_IDS + 1).fill('job')),
    new RegExp(`1 to ${MAX_ASSEMBLY_JOB_IDS}`)
  );
});
