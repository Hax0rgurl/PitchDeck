import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createMcpMediaProvider } from '../server/mcp-media-provider.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}/mcp`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('configurable MCP media provider initializes, calls normalized tools, and materializes images', async () => {
  const calls = [];
  await withServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('Content-Type', 'application/json');
    if (body.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'test-session');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }));
      return;
    }
    if (body.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
    calls.push(body.params);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
      content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('test-png').toString('base64') }]
    }}));
  }, async endpoint => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-media-'));
    const values = { endpoint, token: '', 'image-tool': 'generate_image', 'video-submit-tool': 'queue_video',
      'video-status-tool': 'get_jobs', 'video-media-tool': 'get_media', 'assemble-tool': 'assemble_movie' };
    const provider = await createMcpMediaProvider({
      generatedDir: root,
      getProviderConfig: async () => values,
      writeImageDataUrl: async (dataUrl, label) => {
        const filePath = path.join(root, `${label}.png`);
        await fs.writeFile(filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
        return { filePath };
      }
    });
    const descriptor = await provider.describe();
    assert.equal(descriptor.kind, 'mcp');
    assert.deepEqual(descriptor.mediaKinds, ['image', 'video']);
    assert.equal(descriptor.configured, true);
    const result = await provider.generateImage({ body: { prompt: 'red sphere', label: 'shot-1', model: 'custom-model' } });
    assert.equal(result.ok, true);
    assert.match(result.imageDataUrl, /^data:image\/png;base64,/);
    assert.equal((await fs.readFile(result.outputPath)).toString(), 'test-png');
    assert.equal(calls[0].name, 'generate_image');
    assert.equal(calls[0].arguments.prompt, 'red sphere');
    await fs.rm(root, { recursive: true, force: true });
  });
});
