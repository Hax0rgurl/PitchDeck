import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const FORBIDDEN_PUBLIC_KEYS = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|authorization|bearer|credentialvalue|secretvalue)/i;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function requiredProviderId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!PROVIDER_ID.test(id)) {
    throw new Error('Video provider id must use 1-80 lowercase letters, numbers, dots, underscores, or dashes');
  }
  return id;
}

function assertNoPublicSecrets(value, trail = 'provider') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.test(key)) {
      throw new Error(`${trail}.${key} may not expose credential material`);
    }
    assertNoPublicSecrets(nested, `${trail}.${key}`);
  }
}

function safePublicDescriptor(raw, fallbackId) {
  const descriptor = clone(raw || {});
  descriptor.id = requiredProviderId(descriptor.id || fallbackId);
  descriptor.name = String(descriptor.name || descriptor.id).trim().slice(0, 120);
  descriptor.kind = ['local', 'api', 'mcp'].includes(descriptor.kind) ? descriptor.kind : 'api';
  descriptor.configured = descriptor.configured !== false;
  descriptor.requiresBillingApproval = descriptor.requiresBillingApproval === true;
  descriptor.mediaKinds = Array.isArray(descriptor.mediaKinds)
    ? [...new Set(descriptor.mediaKinds.map(value => String(value || '').toLowerCase()).filter(value => ['image', 'video'].includes(value)))]
    : [];
  descriptor.models = Array.isArray(descriptor.models)
    ? descriptor.models.map(model => typeof model === 'string'
      ? { id: model, name: model }
      : {
          id: String(model?.id || '').trim(),
          name: String(model?.name || model?.id || '').trim(),
          ...(model?.capabilities ? { capabilities: clone(model.capabilities) } : {})
        }).filter(model => model.id)
    : [];
  descriptor.allowsCustomModel = descriptor.allowsCustomModel !== false;
  descriptor.capabilities = descriptor.capabilities && typeof descriptor.capabilities === 'object'
    ? descriptor.capabilities : {};
  descriptor.credentials = descriptor.credentials && typeof descriptor.credentials === 'object'
    ? {
        configured: descriptor.credentials.configured === true,
        fields: Array.isArray(descriptor.credentials.fields)
          ? descriptor.credentials.fields.map(field => ({
              id: String(field?.id || '').trim(),
              label: String(field?.label || field?.id || '').trim(),
              secret: field?.secret !== false,
              required: field?.required !== false,
              type: ['text', 'url', 'password'].includes(field?.type) ? field.type : (field?.secret === false ? 'text' : 'password'),
              placeholder: String(field?.placeholder || '').slice(0, 300),
              help: String(field?.help || '').slice(0, 600)
            })).filter(field => field.id)
          : []
      }
    : { configured: descriptor.configured, fields: [] };
  descriptor.configuration = descriptor.configuration && typeof descriptor.configuration === 'object'
    ? {
        fields: Array.isArray(descriptor.configuration.fields)
          ? descriptor.configuration.fields.map(field => ({
              id: String(field?.id || '').trim(),
              label: String(field?.label || field?.id || '').trim(),
              secret: field?.secret === true,
              required: field?.required !== false,
              type: ['text', 'url', 'password'].includes(field?.type) ? field.type : 'text',
              placeholder: String(field?.placeholder || '').slice(0, 300),
              help: String(field?.help || '').slice(0, 600)
            })).filter(field => field.id)
          : []
      }
    : { fields: [] };
  assertNoPublicSecrets(descriptor);
  return descriptor;
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export class MediaProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.loadErrors = [];
  }

  register(adapter, { source = 'runtime' } = {}) {
    if (!adapter || typeof adapter !== 'object') throw new TypeError('Video provider adapter must be an object');
    const id = requiredProviderId(adapter.id);
    if (this.providers.has(id)) throw new Error(`Video provider ${id} is already registered`);
    const supported = ['generateImage', 'queueBatch', 'getJobs', 'getMedia', 'assemble']
      .some(operation => typeof adapter[operation] === 'function');
    const routed = adapter.routes && typeof adapter.routes === 'object';
    if (!supported && !routed) {
      throw new Error(`Video provider ${id} supplies neither operations nor compatibility routes`);
    }
    this.providers.set(id, { ...adapter, id, source });
    return this.providers.get(id);
  }

  get(value) {
    return this.providers.get(requiredProviderId(value)) || null;
  }

  require(value) {
    const provider = this.get(value);
    if (!provider) {
      const error = new Error(`Unknown video provider: ${String(value || '').trim() || '(none)'}`);
      error.code = 'VIDEO_PROVIDER_NOT_FOUND';
      throw error;
    }
    return provider;
  }

  noteLoadError(filePath, error) {
    const row = {
      file: path.basename(filePath),
      error: String(error?.message || error).slice(0, 500)
    };
    if (!this.loadErrors.some(existing => existing.file === row.file && existing.error === row.error)) {
      this.loadErrors.push(row);
    }
  }

  async describe(adapter) {
    const dynamic = typeof adapter.describe === 'function' ? await adapter.describe() : adapter.descriptor;
    const descriptor = safePublicDescriptor({
      ...(dynamic || {}),
      id: adapter.id,
      source: adapter.source === 'built-in' ? 'built-in' : 'plug-in'
    }, adapter.id);
    if (!descriptor.mediaKinds.length) {
      if (typeof adapter.generateImage === 'function' || adapter.routes?.generateImage) descriptor.mediaKinds.push('image');
      if (['queueBatch', 'getJobs', 'getMedia', 'assemble'].some(operation => (
        typeof adapter[operation] === 'function' || adapter.routes?.[operation]
      ))) descriptor.mediaKinds.push('video');
    }
    return descriptor;
  }

  async catalog(kind = '') {
    const filterKind = String(kind || '').toLowerCase();
    const providers = [];
    for (const adapter of this.providers.values()) {
      try {
        const descriptor = await this.describe(adapter);
        if (!filterKind || descriptor.mediaKinds.includes(filterKind)) providers.push(descriptor);
      } catch (error) {
        this.noteLoadError(adapter.source || adapter.id, error);
      }
    }
    return {
      schema: 'pitchdeck/media-providers@1',
      providers,
      loadErrors: clone(this.loadErrors)
    };
  }
}

/**
 * Load trusted local provider plug-ins. A module exports createVideoProvider(context),
 * a default factory, or a videoProvider object. Modules may return one adapter or an
 * array. Only explicit directories are scanned and a symlink may not escape its root.
 */
export async function loadMediaProviderPlugins(registry, directories, context = {}) {
  for (const configuredDir of directories || []) {
    if (!configuredDir) continue;
    const root = path.resolve(configuredDir);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!/\.(?:mjs|js)$/i.test(entry.name) || entry.name.startsWith('.')) continue;
      const candidate = path.join(root, entry.name);
      try {
        const realRoot = await fs.realpath(root);
        const realFile = await fs.realpath(candidate);
        if (!pathInside(realRoot, realFile)) throw new Error('Provider module escapes its configured directory');
        const stat = await fs.stat(realFile);
        if (!stat.isFile()) throw new Error('Provider module is not a regular file');
        const url = pathToFileURL(realFile);
        url.searchParams.set('mtime', String(stat.mtimeMs));
        const module = await import(url.href);
        const factory = module.createMediaProvider || module.createVideoProvider || module.default;
        const created = typeof factory === 'function'
          ? await factory(Object.freeze({ ...context, providerDirectory: root }))
          : module.videoProvider;
        const adapters = Array.isArray(created) ? created : [created];
        for (const adapter of adapters) registry.register(adapter, { source: realFile });
      } catch (error) {
        registry.noteLoadError(candidate, error);
      }
    }
  }
  return registry;
}

export function videoProviderId(value) {
  return requiredProviderId(value);
}

export const VideoProviderRegistry = MediaProviderRegistry;
export const loadVideoProviderPlugins = loadMediaProviderPlugins;

export function publicVideoProviderDescriptor(value) {
  return safePublicDescriptor(value, value?.id);
}
