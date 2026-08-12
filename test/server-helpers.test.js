import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFfmpegConcatList,
  isAllowedLocalOrigin,
  mfluxBinaryCandidates,
  modelStorageStatus,
  normalizePhospheneJobs,
  qwenModelCandidates,
  resolveGeneratedMediaPath,
  selectExistingCandidate
} from '../server/helpers.js';

test('allows only Tauri and loopback browser origins', () => {
  for (const origin of [
    'tauri://localhost',
    'http://localhost:1420',
    'https://localhost:5173',
    'http://127.0.0.1:5173',
    'http://[::1]:5173',
    'http://tauri.localhost'
  ]) {
    assert.equal(isAllowedLocalOrigin(origin), true, origin);
  }
  for (const origin of [
    'https://example.com',
    'http://localhost.example.com',
    'file:///tmp/index.html',
    'not a URL'
  ]) {
    assert.equal(isAllowedLocalOrigin(origin), false, origin);
  }
});

test('selects the first existing candidate without duplicate probes', async () => {
  const probes = [];
  const selected = await selectExistingCandidate(
    ['/missing', '/missing', '/ready', '/later'],
    async candidate => {
      probes.push(candidate);
      return candidate === '/ready';
    }
  );
  assert.equal(selected, '/ready');
  assert.deepEqual(probes, ['/missing', '/ready']);
});

test('discovers the existing Pinokio image binary and Compiled Apps model before legacy fallbacks', () => {
  const binaries = mfluxBinaryCandidates({ userRoot: '/Users/test', pinokioRoot: '/pinokio' });
  assert.ok(binaries.includes('/pinokio/api/phosphene.git/ltx-2-mlx/env/bin/mflux-generate-qwen-edit'));

  const models = qwenModelCandidates({
    configured: '/configured/q4',
    root: '/repo',
    userRoot: '/Users/test'
  });
  assert.equal(models[0], '/configured/q4');
  assert.ok(models.includes('/Users/test/Documents/ CODEX BRAIN/Compiled Apps/directors-console-local/models/qwen-image-edit-2511-q4/q4'));
  assert.ok(models.indexOf('/Users/test/Documents/ CODEX BRAIN/Compiled Apps/directors-console-local/models/qwen-image-edit-2511-q4/q4')
    < models.indexOf('/Users/test/Documents/New project/directors-console-local/models/qwen-image-edit-2511-q4/q4'));
});

test('distinguishes a logical iCloud placeholder from locally allocated model weights', () => {
  const requiredBytes = 20 * 1024 ** 3;
  assert.deepEqual(modelStorageStatus({
    logicalBytes: 25 * 1024 ** 3,
    allocatedBytes: 0,
    requiredBytes
  }), { present: true, hydrated: false });
  assert.deepEqual(modelStorageStatus({
    logicalBytes: 25 * 1024 ** 3,
    allocatedBytes: 21 * 1024 ** 3,
    requiredBytes
  }), { present: true, hydrated: true });
});

test('normalizes Phosphene queue, current, history, cancellation, and missing jobs in requested order', () => {
  const snapshot = {
    current: { id: 'running', status: 'running' },
    queue: [{ id: 'queued', status: 'queued' }],
    history: [
      { id: 'done', status: 'done', output_path: '/outputs/done.mp4' },
      { id: 'failed', status: 'failed', error: 'render exploded' },
      { id: 'cancelled', status: 'cancelled' }
    ]
  };
  const result = normalizePhospheneJobs(snapshot, ['queued', 'running', 'done', 'failed', 'cancelled', 'missing']);
  assert.deepEqual(result.jobs.map(job => [job.id, job.status]), [
    ['queued', 'queued'],
    ['running', 'running'],
    ['done', 'done'],
    ['failed', 'failed'],
    ['cancelled', 'failed']
  ]);
  assert.equal(result.jobs.find(job => job.id === 'done').outputPath, '/outputs/done.mp4');
  assert.equal(result.jobs.find(job => job.id === 'failed').error, 'render exploded');
  assert.equal(result.jobs.find(job => job.id === 'cancelled').error, 'Job was cancelled');
  assert.deepEqual(result.missingIds, ['missing']);
});

test('builds an ordered, safely quoted ffmpeg concat list', () => {
  assert.equal(
    buildFfmpegConcatList(['/tmp/one.mp4', "/tmp/director's-cut.mp4"]),
    "file '/tmp/one.mp4'\nfile '/tmp/director'\\''s-cut.mp4'\n"
  );
  assert.throws(() => buildFfmpegConcatList(['/tmp/one.mp4\nfile /etc/passwd']), /Invalid media path/);
  assert.throws(() => buildFfmpegConcatList([]), /At least one media file/);
});

test('resolves only simple MP4 names inside the generated-media root', () => {
  assert.equal(
    resolveGeneratedMediaPath('/tmp/pitchdeck-generated', 'my-film-1234.mp4'),
    '/tmp/pitchdeck-generated/my-film-1234.mp4'
  );
  assert.throws(
    () => resolveGeneratedMediaPath('/tmp/pitchdeck-generated', '../outside.mp4'),
    /Invalid generated media filename/
  );
  assert.throws(
    () => resolveGeneratedMediaPath('/tmp/pitchdeck-generated', 'notes.json'),
    /Invalid generated media filename/
  );
});
