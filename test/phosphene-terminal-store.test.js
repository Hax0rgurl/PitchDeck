import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  mergePhospheneJobResults,
  PhospheneTerminalStore
} from '../server/phosphene-terminal-store.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchdeck-terminal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputs = path.join(root, 'outputs');
  const state = path.join(root, 'state', 'terminal.json');
  await fs.mkdir(outputs, { recursive: true });
  return { root, outputs, state };
}

test('terminal Phosphene jobs survive a fresh server store and retain 0600 state', async t => {
  const { outputs, state } = await fixture(t);
  const clip = path.join(outputs, 'finished.mp4');
  await fs.writeFile(clip, 'finished clip');

  const first = new PhospheneTerminalStore(state, { allowedOutputRoots: [outputs] });
  await first.observe([
    { id: 'done-1', status: 'done', outputPath: clip },
    { id: 'failed-1', status: 'failed', error: 'render failed' },
    { id: 'queued-1', status: 'queued' }
  ]);

  const second = new PhospheneTerminalStore(state, { allowedOutputRoots: [outputs] });
  const restored = await second.getMany(['failed-1', 'done-1', 'queued-1']);
  assert.deepEqual(restored.map(job => [job.id, job.status]), [
    ['failed-1', 'failed'],
    ['done-1', 'done']
  ]);
  const restoredClip = restored.find(job => job.id === 'done-1').outputPath;
  assert.equal(await second.resolveOutputPath(restoredClip), restoredClip);
  assert.equal((await fs.stat(state)).mode & 0o777, 0o600);
});

test('durable terminal jobs fill Phosphene history eviction without replacing live work', () => {
  const merged = mergePhospheneJobResults(
    ['old-done', 'running', 'missing'],
    { jobs: [{ id: 'running', status: 'running', outputPath: '', error: '' }] },
    [{ id: 'old-done', status: 'done', outputPath: '/outputs/old.mp4', error: '' }]
  );
  assert.deepEqual(merged.jobs.map(job => [job.id, job.status]), [
    ['old-done', 'done'],
    ['running', 'running']
  ]);
  assert.deepEqual(merged.missingIds, ['missing']);
});

test('terminal output paths cannot escape configured roots or turn into symlinks', async t => {
  const { root, outputs, state } = await fixture(t);
  const outside = path.join(root, 'outside.mp4');
  const linked = path.join(outputs, 'linked.mp4');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, linked);
  const store = new PhospheneTerminalStore(state, { allowedOutputRoots: [outputs] });
  await assert.rejects(
    store.observe([{ id: 'outside', status: 'done', outputPath: outside }]),
    /outside configured output roots/
  );
  await assert.rejects(
    store.observe([{ id: 'linked', status: 'done', outputPath: linked }]),
    /outside configured output roots/
  );
});

test('a missing completed file keeps the terminal receipt without fabricating playable media', async t => {
  const { outputs, state } = await fixture(t);
  const store = new PhospheneTerminalStore(state, { allowedOutputRoots: [outputs] });
  await store.observe([{ id: 'gone', status: 'done', outputPath: path.join(outputs, 'gone.mp4') }]);
  const [gone] = await store.getMany(['gone']);
  assert.equal(gone.status, 'done');
  assert.equal(gone.outputPath, '');
  await assert.rejects(() => store.resolveOutputPath(gone.outputPath), /no output path/);
});

test('an unsafe observation rolls the whole in-memory update back before persistence', async t => {
  const { root, outputs, state } = await fixture(t);
  const valid = path.join(outputs, 'valid.mp4');
  const outside = path.join(root, 'outside.mp4');
  await fs.writeFile(valid, 'valid');
  await fs.writeFile(outside, 'outside');
  const store = new PhospheneTerminalStore(state, { allowedOutputRoots: [outputs] });
  await assert.rejects(
    store.observe([
      { id: 'valid', status: 'done', outputPath: valid },
      { id: 'unsafe', status: 'done', outputPath: outside }
    ]),
    /outside configured output roots/
  );
  assert.deepEqual(await store.getMany(['valid', 'unsafe']), []);
  await assert.rejects(fs.stat(state), error => error?.code === 'ENOENT');
});
