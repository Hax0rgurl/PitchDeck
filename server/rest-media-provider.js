import fs from 'node:fs/promises';
import path from 'node:path';

function safeName(value) {
  return String(value || 'media').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'media';
}
function joined(base, route) {
  const root = new URL(String(base || ''));
  if (!['http:', 'https:'].includes(root.protocol)) throw new Error('REST media base URL must use HTTP or HTTPS');
  return new URL(String(route || '').replace(/^\//, ''), `${root.toString().replace(/\/+$/, '')}/`).toString();
}
async function jsonRequest(url, token, options = {}) {
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`REST media API returned non-JSON content from ${url}`); }
  if (!response.ok) throw new Error(body.error || body.message || `REST media API returned HTTP ${response.status}`);
  return body;
}
async function download(url, token, outputPath) {
  const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`REST media download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('REST media download was empty');
  await fs.writeFile(outputPath, bytes, { mode: 0o600 });
  return { filePath: outputPath, mimeType: response.headers.get('content-type') || '', bytes: bytes.length };
}

export async function createRestMediaProvider(context) {
  const id = 'rest-media';
  const config = () => context.getProviderConfig(id);
  const endpoint = async field => { const values = await config(); return { values, url: joined(values['base-url'], values[field]) }; };
  const durablePath = key => path.join(context.generatedDir, `rest-${safeName(key)}.mp4`);
  const materialize = async (value, key, extension = '.mp4') => {
    const values = await config();
    const outputPath = extension === '.mp4' ? durablePath(key) : path.join(context.generatedDir, `rest-${safeName(key)}${extension}`);
    if (value.mediaDataBase64) {
      await fs.writeFile(outputPath, Buffer.from(value.mediaDataBase64, 'base64'), { mode: 0o600 });
      return { filePath: outputPath, mimeType: value.mimeType || '' };
    }
    if (!value.mediaUrl) throw new Error('REST media API returned neither mediaUrl nor mediaDataBase64');
    return download(value.mediaUrl, String(values.token || '').trim(), outputPath);
  };
  return {
    id,
    async describe() {
      const values = await config();
      const required = ['base-url', 'image-path', 'video-submit-path', 'video-status-path', 'video-media-path', 'assemble-path'];
      return {
        name: 'Custom REST media API', kind: 'api', mediaKinds: ['image', 'video'],
        configured: required.every(field => String(values[field] || '').trim()), requiresBillingApproval: true,
        allowsCustomModel: true, models: [],
        capabilities: { textToImage: true, referenceImages: true, textToVideo: true, imageToVideo: true, asynchronous: true, localDurableMedia: true },
        credentials: { configured: Boolean(values.token), fields: [
          { id: 'token', label: 'Bearer token (optional)', secret: true, required: false, help: 'Stored only in PitchDeck private settings with file mode 0600.' }
        ]},
        configuration: { fields: [
          { id: 'base-url', label: 'API base URL', type: 'url', required: true, placeholder: 'https://media.example.com/v1/' },
          { id: 'image-path', label: 'Image POST path', required: true, placeholder: 'images/generate' },
          { id: 'video-submit-path', label: 'Video batch POST path', required: true, placeholder: 'videos/queue-batch' },
          { id: 'video-status-path', label: 'Video status POST path', required: true, placeholder: 'videos/jobs' },
          { id: 'video-media-path', label: 'Video media path template', required: true, placeholder: 'videos/jobs/{id}/media' },
          { id: 'assemble-path', label: 'Movie assembly POST path', required: true, placeholder: 'videos/assemble' }
        ]}
      };
    },
    async generateImage({ body }) {
      const { values, url } = await endpoint('image-path');
      const value = await jsonRequest(url, values.token, { method: 'POST', body: JSON.stringify(body) });
      if (value.imageDataUrl) {
        const saved = await context.writeImageDataUrl(value.imageDataUrl, `rest-${body.label || Date.now()}`);
        return { ...value, ok: true, outputPath: saved.filePath, providerId: id };
      }
      const media = await materialize(value, body.label || Date.now(), '.png');
      const bytes = await fs.readFile(media.filePath);
      return { ...value, ok: true, imageDataUrl: `data:${media.mimeType || 'image/png'};base64,${bytes.toString('base64')}`, outputPath: media.filePath, providerId: id };
    },
    async queueBatch({ body }) {
      const { values, url } = await endpoint('video-submit-path');
      return jsonRequest(url, values.token, { method: 'POST', body: JSON.stringify(body) });
    },
    async getJobs({ body }) {
      const { values, url } = await endpoint('video-status-path');
      return jsonRequest(url, values.token, { method: 'POST', body: JSON.stringify(body) });
    },
    async getMedia({ id: jobId }) {
      const local = durablePath(jobId);
      try { const stat = await fs.lstat(local); if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) return { filePath: local, mimeType: 'video/mp4' }; } catch {}
      const values = await config();
      const url = joined(values['base-url'], String(values['video-media-path']).replaceAll('{id}', encodeURIComponent(jobId)));
      return download(url, values.token, local);
    },
    async assemble({ body }) {
      const { values, url } = await endpoint('assemble-path');
      const value = await jsonRequest(url, values.token, { method: 'POST', body: JSON.stringify(body) });
      const key = value.id || value.jobId || `assembly-${body.runId}`;
      const media = await materialize(value, key);
      return { ...value, ok: true, outputPath: media.filePath,
        mediaUrl: `/api/video/providers/${id}/jobs/${encodeURIComponent(key)}/media`, providerId: id };
    }
  };
}
