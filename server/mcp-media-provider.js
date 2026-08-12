import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function safeName(value) {
  return String(value || 'media').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'media';
}

function parseRpcBody(text, contentType) {
  if (/text\/event-stream/i.test(contentType || '')) {
    const events = String(text || '').split(/\n\n+/).flatMap(block => block.split('\n'))
      .filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
    for (let index = events.length - 1; index >= 0; index--) {
      try { return JSON.parse(events[index]); } catch {}
    }
    throw new Error('MCP server returned an unreadable event stream');
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error('MCP server returned non-JSON content'); }
}

function toolValue(result) {
  if (!result || result.isError) {
    const message = (result?.content || []).find(row => row?.type === 'text')?.text;
    throw new Error(message || 'MCP media tool returned an error');
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const item of result.content || []) {
    if (item?.type === 'image' && item.data) return { imageDataUrl: `data:${item.mimeType || 'image/png'};base64,${item.data}` };
    if (item?.type === 'text' && item.text) {
      try { return JSON.parse(item.text); } catch {}
    }
    if (item?.type === 'resource_link' && item.uri) return { mediaUrl: item.uri, mimeType: item.mimeType || '' };
  }
  throw new Error('MCP media tool returned no structured artifact');
}

async function rpcSession(endpoint, token) {
  let sessionId = '';
  let nextId = 1;
  const post = async (payload, expectResponse = true) => {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`MCP server returned HTTP ${response.status}`);
    sessionId = response.headers.get('mcp-session-id') || sessionId;
    const text = await response.text();
    if (!expectResponse || !text) return {};
    const body = parseRpcBody(text, response.headers.get('content-type'));
    if (body.error) throw new Error(body.error.message || 'MCP request failed');
    return body.result || {};
  };
  await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Agentic Movie Studio', version: '0.3.0' }
  }});
  await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false);
  return async (toolName, args) => post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: toolName, arguments: args || {} }});
}

async function downloadRemote(url, token, filePath) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`MCP media download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('MCP media download was empty');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes, { mode: 0o600 });
  return { filePath, bytes: bytes.length, mimeType: response.headers.get('content-type') || '' };
}

export async function createMcpMediaProvider(context) {
  const id = 'mcp-media';
  const cache = new Map();
  const config = () => context.getProviderConfig(id);
  const call = async (toolField, args) => {
    const values = await config();
    const endpoint = String(values.endpoint || '').trim();
    const tool = String(values[toolField] || '').trim();
    if (!endpoint || !tool) throw new Error(`Configure the MCP endpoint and ${toolField} in Studio Settings`);
    const invoke = await rpcSession(endpoint, String(values.token || '').trim());
    return toolValue(await invoke(tool, args));
  };
  const materialize = async (value, key, fallbackExt = '.mp4') => {
    if (value.filePath) return { filePath: value.filePath, mimeType: value.mimeType || '' };
    const values = await config();
    const ext = /png/i.test(value.mimeType || '') ? '.png' : /jpe?g/i.test(value.mimeType || '') ? '.jpg' : fallbackExt;
    const filePath = path.join(context.generatedDir, `mcp-${safeName(key)}${ext}`);
    if (value.mediaDataBase64) {
      await fs.writeFile(filePath, Buffer.from(value.mediaDataBase64, 'base64'), { mode: 0o600 });
      return { filePath, mimeType: value.mimeType || '' };
    }
    if (!value.mediaUrl) throw new Error('MCP media tool returned neither mediaUrl nor mediaDataBase64');
    return downloadRemote(value.mediaUrl, String(values.token || '').trim(), filePath);
  };
  return {
    id,
    async describe() {
      const values = await config();
      return {
        name: 'MCP media server', kind: 'mcp', mediaKinds: ['image', 'video'],
        configured: Boolean(values.endpoint && values['image-tool'] && values['video-submit-tool'] && values['video-status-tool'] && values['video-media-tool'] && values['assemble-tool']),
        requiresBillingApproval: true, allowsCustomModel: true, models: [],
        capabilities: { textToImage: true, referenceImages: true, textToVideo: true, imageToVideo: true, asynchronous: true, localDurableMedia: true },
        credentials: { configured: Boolean(values.token), fields: [
          { id: 'token', label: 'Bearer token (optional)', secret: true, required: false, help: 'Stored only in PitchDeck private settings with file mode 0600.' }
        ]},
        configuration: { fields: [
          { id: 'endpoint', label: 'Streamable HTTP MCP endpoint', type: 'url', required: true, placeholder: 'https://media.example.com/mcp' },
          { id: 'image-tool', label: 'Image generation tool', required: true, placeholder: 'generate_image' },
          { id: 'video-submit-tool', label: 'Video submission tool', required: true, placeholder: 'queue_video_batch' },
          { id: 'video-status-tool', label: 'Video status tool', required: true, placeholder: 'get_video_jobs' },
          { id: 'video-media-tool', label: 'Video media tool', required: true, placeholder: 'get_video_media' },
          { id: 'assemble-tool', label: 'Movie assembly tool', required: true, placeholder: 'assemble_video' }
        ]}
      };
    },
    async generateImage({ body }) {
      const value = await call('image-tool', body);
      if (value.imageDataUrl) {
        const saved = await context.writeImageDataUrl(value.imageDataUrl, `mcp-${body.label || Date.now()}`);
        return { ok: true, imageDataUrl: value.imageDataUrl, outputPath: saved.filePath, providerId: id, model: body.model || '' };
      }
      const media = await materialize(value, body.label || Date.now(), '.png');
      const bytes = await fs.readFile(media.filePath);
      return { ok: true, imageDataUrl: `data:${media.mimeType || 'image/png'};base64,${bytes.toString('base64')}`, outputPath: media.filePath, providerId: id, model: body.model || '' };
    },
    async queueBatch({ body }) { return call('video-submit-tool', body); },
    async getJobs({ body }) { return call('video-status-tool', body); },
    async getMedia({ id: jobId }) {
      if (cache.has(jobId)) return cache.get(jobId);
      const localPath = path.join(context.generatedDir, `mcp-${safeName(jobId)}.mp4`);
      try {
        const stat = await fs.lstat(localPath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) return { filePath: localPath, mimeType: 'video/mp4' };
      } catch {}
      const value = await call('video-media-tool', { id: jobId });
      const media = await materialize(value, jobId);
      cache.set(jobId, media); return media;
    },
    async assemble({ body }) {
      const value = await call('assemble-tool', body);
      const cutId = `assembly-${crypto.createHash('sha256').update(`${body.runId}\0${(body.ids || body.jobIds || []).join('\0')}`).digest('hex').slice(0, 24)}`;
      const media = await materialize(value, cutId);
      cache.set(cutId, media);
      return { ...value, ok: true, outputPath: media.filePath,
        mediaUrl: `/api/video/providers/${id}/jobs/${encodeURIComponent(cutId)}/media`, providerId: id };
    }
  };
}
