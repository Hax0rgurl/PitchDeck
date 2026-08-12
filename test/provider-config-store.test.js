import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProviderConfigStore, normalizeConfigFields } from '../server/provider-config-store.js';

const descriptor = {
  id: 'remote-media',
  credentials: { fields: [{ id: 'api-key', label: 'API key', secret: true }] },
  configuration: { fields: [{ id: 'base-url', label: 'Endpoint', secret: false, type: 'url' }] }
};

test('normalizes declared provider settings without accepting duplicate field ids', () => {
  assert.deepEqual(normalizeConfigFields(descriptor).map(field => [field.id, field.secret]), [
    ['api-key', true], ['base-url', false]
  ]);
  assert.throws(() => normalizeConfigFields({
    credentials: { fields: [{ id: 'same' }] },
    configuration: { fields: [{ id: 'same' }] }
  }), /duplicated/);
});

test('stores provider secrets privately and never returns their values', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchdeck-provider-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'providers.json');
  const store = new ProviderConfigStore(filePath);
  const first = await store.update(descriptor, { values: { 'api-key': 'secret-value', 'base-url': 'https://api.example.test' } });
  assert.equal(first.configured, true);
  assert.equal(first.fields.find(field => field.id === 'api-key').value, '');
  assert.equal(first.fields.find(field => field.id === 'api-key').configured, true);
  assert.equal(first.fields.find(field => field.id === 'base-url').value, 'https://api.example.test');
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(filePath, 'utf8'), /secret-value/);

  const restarted = new ProviderConfigStore(filePath);
  await restarted.update(descriptor, { values: { 'api-key': '', 'base-url': 'https://new.example.test' } });
  assert.equal((await restarted.values('remote-media'))['api-key'], 'secret-value', 'blank secret preserves the saved value');
  await restarted.update(descriptor, { clearFields: ['api-key'] });
  assert.equal((await restarted.publicConfiguration(descriptor)).configured, false);
});

