import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  loadMediaProviderPlugins,
  publicVideoProviderDescriptor,
  VideoProviderRegistry
} from '../server/video-provider-registry.js';

test('catalog exposes capabilities and credential state without exposing secrets', async () => {
  const registry = new VideoProviderRegistry();
  registry.register({
    id: 'local-one',
    routes: { queueBatch: '/legacy/queue' },
    descriptor: {
      name: 'Local One',
      kind: 'local',
      configured: true,
      allowsCustomModel: true,
      models: ['model-a'],
      capabilities: { textToVideo: true, imageToVideo: true },
      credentials: { configured: true, fields: [] }
    }
  });
  const catalog = await registry.catalog();
  assert.equal(catalog.schema, 'pitchdeck/media-providers@1');
  assert.deepEqual(catalog.providers[0].models, [{ id: 'model-a', name: 'model-a' }]);
  assert.equal(catalog.providers[0].credentials.configured, true);
  assert.doesNotMatch(JSON.stringify(catalog), /token|password|apiKey/i);

  assert.throws(() => publicVideoProviderDescriptor({
    id: 'bad-provider',
    apiKey: 'must-not-leak'
  }), /may not expose credential material/);
});

test('registry rejects duplicates and invalid ids', () => {
  const registry = new VideoProviderRegistry();
  registry.register({ id: 'provider-a', routes: { jobs: '/jobs' } });
  assert.throws(() => registry.register({ id: 'provider-a', routes: { jobs: '/other' } }), /already registered/);
  assert.throws(() => registry.register({ id: '../escape', routes: { jobs: '/jobs' } }), /provider id/i);
});

test('trusted plug-in directory discovers a provider without editing PitchDeck core', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchdeck-provider-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'custom.mjs'), `
    export async function createVideoProvider(context) {
      return {
        id: 'custom-api',
        descriptor: {
          name: 'Custom API', kind: 'api', configured: Boolean(context.flag),
          mediaKinds: ['image', 'video'],
          requiresBillingApproval: true, allowsCustomModel: true,
          models: [], capabilities: { textToVideo: true }
        },
        async queueBatch() { return { ok: true, jobs: [] }; }
      };
    }
  `, { mode: 0o600 });
  const registry = new VideoProviderRegistry();
  await loadMediaProviderPlugins(registry, [root], { flag: true });
  const catalog = await registry.catalog();
  assert.equal(catalog.providers[0].id, 'custom-api');
  assert.equal(catalog.providers[0].configured, true);
  assert.deepEqual(catalog.providers[0].mediaKinds, ['image', 'video']);
  assert.equal(catalog.providers[0].requiresBillingApproval, true);
  assert.equal(catalog.providers[0].allowsCustomModel, true);
  assert.deepEqual(catalog.loadErrors, []);
});

test('broken plug-ins are reported without preventing healthy providers from loading', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchdeck-provider-broken-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'broken.mjs'), 'throw new Error("broken adapter")', { mode: 0o600 });
  const registry = new VideoProviderRegistry();
  registry.register({ id: 'healthy', routes: { jobs: '/jobs' } });
  await loadMediaProviderPlugins(registry, [root], {});
  const catalog = await registry.catalog();
  assert.equal(catalog.providers.length, 1);
  assert.equal(catalog.providers[0].id, 'healthy');
  assert.equal(catalog.loadErrors.length, 1);
  assert.match(catalog.loadErrors[0].error, /broken adapter/);
});
