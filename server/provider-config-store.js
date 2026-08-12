import fs from 'node:fs/promises';
import { atomicWriteJson } from './atomic-json.js';

const SCHEMA = 'pitchdeck/provider-config@1';
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const FIELD_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

function cleanId(value, pattern, label) {
  const id = String(value || '').trim();
  if (!pattern.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

export function normalizeConfigFields(descriptor = {}) {
  const credentialFields = Array.isArray(descriptor.credentials?.fields)
    ? descriptor.credentials.fields : [];
  const settingFields = Array.isArray(descriptor.configuration?.fields)
    ? descriptor.configuration.fields : [];
  const seen = new Set();
  return [...credentialFields, ...settingFields].map(field => {
    const id = cleanId(field?.id, FIELD_ID, 'Provider configuration field id');
    if (seen.has(id)) throw new Error(`Provider configuration field ${id} is duplicated`);
    seen.add(id);
    return {
      id,
      label: String(field?.label || id).trim().slice(0, 160),
      secret: field?.secret !== false,
      required: field?.required !== false,
      type: ['text', 'url', 'password'].includes(field?.type) ? field.type : (field?.secret === false ? 'text' : 'password'),
      placeholder: String(field?.placeholder || '').slice(0, 300),
      help: String(field?.help || '').slice(0, 600)
    };
  });
}

function emptyDocument() {
  return { schema: SCHEMA, providers: {}, updatedAt: '' };
}

export class ProviderConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.document = null;
  }

  async load() {
    if (this.document) return this.document;
    let parsed = emptyDocument();
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (parsed?.schema !== SCHEMA || !parsed.providers || typeof parsed.providers !== 'object') {
      throw new Error('Provider configuration file has an unsupported schema');
    }
    this.document = parsed;
    return parsed;
  }

  async values(providerId) {
    const id = cleanId(providerId, PROVIDER_ID, 'Provider id').toLowerCase();
    const document = await this.load();
    return { ...(document.providers[id]?.values || {}) };
  }

  async publicConfiguration(descriptor) {
    const id = cleanId(descriptor?.id, PROVIDER_ID, 'Provider id').toLowerCase();
    const fields = normalizeConfigFields(descriptor);
    const values = await this.values(id);
    return {
      schema: 'pitchdeck/provider-public-config@1',
      providerId: id,
      configured: fields.every(field => !field.required || Boolean(String(values[field.id] || '').trim())),
      fields: fields.map(field => ({
        ...field,
        configured: Boolean(String(values[field.id] || '').trim()),
        value: field.secret ? '' : String(values[field.id] || '')
      }))
    };
  }

  async update(descriptor, request = {}) {
    const id = cleanId(descriptor?.id, PROVIDER_ID, 'Provider id').toLowerCase();
    const fields = normalizeConfigFields(descriptor);
    if (!fields.length) throw new Error('This provider does not declare configurable fields');
    const allowed = new Map(fields.map(field => [field.id, field]));
    const values = await this.values(id);
    const supplied = request.values && typeof request.values === 'object' ? request.values : {};
    for (const [fieldId, raw] of Object.entries(supplied)) {
      const field = allowed.get(fieldId);
      if (!field) throw new Error(`Unknown provider configuration field: ${fieldId}`);
      const value = String(raw ?? '').trim();
      if (value.length > 16_000) throw new Error(`Provider configuration field ${fieldId} is too long`);
      // A blank secret means "leave the existing secret alone". Non-secret
      // values may intentionally be cleared with a blank value.
      if (field.secret && !value) continue;
      if (value) values[fieldId] = value;
      else delete values[fieldId];
    }
    for (const fieldId of Array.isArray(request.clearFields) ? request.clearFields : []) {
      if (!allowed.has(fieldId)) throw new Error(`Unknown provider configuration field: ${fieldId}`);
      delete values[fieldId];
    }
    const document = await this.load();
    document.providers[id] = { values, updatedAt: new Date().toISOString() };
    document.updatedAt = document.providers[id].updatedAt;
    await atomicWriteJson(this.filePath, document);
    await fs.chmod(this.filePath, 0o600);
    return this.publicConfiguration(descriptor);
  }
}

