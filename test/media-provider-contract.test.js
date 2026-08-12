import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const server = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
const registry = await readFile(new URL('../server/video-provider-registry.js', import.meta.url), 'utf8');

test('media gateway exposes independent image and video provider catalogs', () => {
  assert.match(server, /app\.get\('\/api\/media\/providers'/);
  assert.match(server, /app\.get\('\/api\/image\/providers'/);
  assert.match(server, /app\.get\('\/api\/video\/providers'/);
  assert.match(server, /mediaKinds:\s*\['image'\]/);
  assert.match(server, /mediaKinds:\s*\['video'\]/);
  assert.match(registry, /mediaKinds/);
  assert.match(registry, /generateImage/);
});

test('neutral routes coexist with legacy Phosphene and mflux compatibility routes', () => {
  for (const route of [
    "app.post('/api/image/generate'",
    "app.post('/api/video/queue-batch'",
    "app.post('/api/video/jobs'",
    "app.post('/api/video/assemble'",
    "app.get('/api/video/providers/:providerId/jobs/:id/media'"
  ]) assert.ok(server.includes(route), `missing neutral route ${route}`);
  assert.match(server, /app\.post\('\/api\/image\/mflux\/generate'/);
  assert.match(server, /app\.post\('\/api\/video\/phosphene\/queue-batch'/);
});

test('paid providers and rejected creative work fail before provider dispatch', () => {
  assert.match(server, /VIDEO_REVIEW_BLOCKED/);
  assert.match(server, /MEDIA_REVIEW_BLOCKED/);
  assert.match(server, /MEDIA_REVIEW_REQUIRED/);
  assert.match(server, /requiresBillingApproval/);
  assert.match(server, /approval\?\.approved !== true/);
  assert.match(server, /res\.redirect\(307, compatibilityRoute\)/);
});

test('provider architecture is vendor-neutral and accepts trusted local plug-ins', () => {
  assert.match(registry, /createMediaProvider/);
  assert.match(registry, /providerDirectory/);
  assert.match(registry, /allowsCustomModel/);
  assert.doesNotMatch(server, /alibaba|dashscope|wan2/i);
  assert.doesNotMatch(registry, /alibaba|dashscope|wan2/i);
});
