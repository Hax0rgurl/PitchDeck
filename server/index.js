import express from 'express';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildFfmpegConcatList,
  ffmpegBinaryCandidates,
  hfBinaryCandidates,
  isAllowedLocalOrigin,
  mfluxBinaryCandidates,
  modelStorageStatus,
  normalizePhospheneJobs,
  qwenModelCandidates,
  resolveGeneratedMediaPath,
  selectExistingCandidate,
  uvxBinaryCandidates
} from './helpers.js';
import {
  findPhospheneJobByMarker,
  normalizePhospheneAttempt,
  phospheneSubmissionLabel,
  PhospheneJobLedger
} from './phosphene-ledger.js';
import {
  AssemblyReceiptLedger,
  AssemblyRunConflictError,
  deterministicAssemblyIntent,
  normalizeAssemblyIds
} from './assembly-ledger.js';
import {
  mergePhospheneJobResults,
  PhospheneTerminalStore
} from './phosphene-terminal-store.js';
import {
  loadMediaProviderPlugins,
  MediaProviderRegistry
} from './video-provider-registry.js';
import { ProviderConfigStore, normalizeConfigFields } from './provider-config-store.js';
import { createMcpMediaProvider } from './mcp-media-provider.js';
import { createRestMediaProvider } from './rest-media-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const DATA_DIR = process.env.DIRECTORS_CONSOLE_DATA_DIR || path.join(ROOT, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const GENERATED_DIR = path.join(DATA_DIR, 'generated');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const VIDEO_PROVIDER_PLUGIN_DIR = path.join(DATA_DIR, 'video-providers');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const PHOSPHENE_URL = process.env.PHOSPHENE_URL || 'http://127.0.0.1:8198';
const USER_ROOT = process.env.PITCHDECK_USER_ROOT || process.env.HOME || '/Users/muse';
const PINOKIO_ROOT = process.env.PINOKIO_ROOT || path.join(USER_ROOT, 'pinokio');
const STATIC_FRONTEND = process.env.DIRECTORS_CONSOLE_STATIC === '1' || process.env.NODE_ENV === 'production';
const execFileAsync = promisify(execFile);

async function pathExecutable(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const MFLUX_BIN_CANDIDATES = mfluxBinaryCandidates({
  configured: process.env.MFLUX_BIN,
  userRoot: USER_ROOT,
  pinokioRoot: PINOKIO_ROOT
});
const MODEL_CANDIDATES = qwenModelCandidates({
  configured: process.env.MFLUX_QWEN_EDIT_MODEL,
  root: ROOT,
  userRoot: USER_ROOT
});
const HF_BIN_CANDIDATES = hfBinaryCandidates({
  configured: process.env.HF_BIN,
  userRoot: USER_ROOT,
  pinokioRoot: PINOKIO_ROOT
});
const UVX_BIN_CANDIDATES = uvxBinaryCandidates({
  configured: process.env.UVX_BIN,
  userRoot: USER_ROOT,
  pinokioRoot: PINOKIO_ROOT
});
const FFMPEG_BIN_CANDIDATES = ffmpegBinaryCandidates({
  configured: process.env.FFMPEG_BIN,
  userRoot: USER_ROOT,
  pinokioRoot: PINOKIO_ROOT
});
const PHOSPHENE_OUTPUT_ROOTS = [
  process.env.PHOSPHENE_OUTPUT_DIR,
  process.env.LTX_OUTPUT_DIR,
  path.join(PINOKIO_ROOT, 'api', 'phosphene.git', 'mlx_outputs'),
  path.join(USER_ROOT, 'Documents', ' CODEX BRAIN', 'Compiled Apps', 'Phosphene', 'mlx_outputs'),
  path.join(USER_ROOT, 'Downloads', 'phosphene.git', 'mlx_outputs')
].filter(Boolean);

const MFLUX_BIN = await selectExistingCandidate(MFLUX_BIN_CANDIDATES, pathExecutable) || MFLUX_BIN_CANDIDATES[0];
const MFLUX_QWEN_EDIT_MODEL = await selectExistingCandidate(MODEL_CANDIDATES, pathExists) || MODEL_CANDIDATES[0];
const HF_BIN = await selectExistingCandidate(HF_BIN_CANDIDATES, pathExecutable) || HF_BIN_CANDIDATES[0];
const UVX_BIN = await selectExistingCandidate(UVX_BIN_CANDIDATES, pathExecutable) || UVX_BIN_CANDIDATES[0];
const FFMPEG_BIN = await selectExistingCandidate(FFMPEG_BIN_CANDIDATES, pathExecutable) || FFMPEG_BIN_CANDIDATES[0];

await fs.mkdir(PROJECTS_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });
await fs.mkdir(GENERATED_DIR, { recursive: true });
await fs.mkdir(LOG_DIR, { recursive: true });
await fs.mkdir(VIDEO_PROVIDER_PLUGIN_DIR, { recursive: true, mode: 0o700 });
const providerConfigStore = new ProviderConfigStore(path.join(DATA_DIR, 'provider-settings.json'));

const installJobs = new Map();
const phospheneJobLedger = new PhospheneJobLedger(path.join(GENERATED_DIR, 'phosphene-job-ledger.json'));
const terminalPhospheneStore = new PhospheneTerminalStore(
  path.join(GENERATED_DIR, 'phosphene-terminal-jobs.json'),
  { allowedOutputRoots: PHOSPHENE_OUTPUT_ROOTS }
);
const assemblyReceiptLedger = new AssemblyReceiptLedger(
  path.join(GENERATED_DIR, 'phosphene-assembly-receipts.json')
);
const mediaProviders = new MediaProviderRegistry();

function cleanId(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `project-${Date.now()}`;
}

function listify(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,;|]/).map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function extractJson(text = '') {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty model response');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Model response did not contain JSON: ${raw.slice(0, 220)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      throw new Error(body?.error || `${res.status} ${res.statusText}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaTags() {
  try {
    const data = await fetchJson(`${OLLAMA_URL}/api/tags`, {}, 2500);
    return {
      ok: true,
      url: OLLAMA_URL,
      models: Array.isArray(data.models) ? data.models.map(model => model.name || model.model).filter(Boolean) : []
    };
  } catch (error) {
    return { ok: false, url: OLLAMA_URL, models: [], error: error.message };
  }
}

function chooseModel(models = [], requested = '') {
  if (requested && models.includes(requested)) return requested;
  const preferred = ['qwen3.5:latest', 'qwen2.5:32b', 'qwen3:latest', 'llama3.1:latest'];
  return preferred.find(name => models.includes(name)) || models[0] || process.env.OLLAMA_MODEL || 'qwen3.5:latest';
}

async function ollamaChat({ messages, model, json = false, temperature = 0.35, numPredict = 2200 }) {
  const status = await ollamaTags();
  if (!status.ok) throw new Error(`Ollama is not reachable at ${OLLAMA_URL}: ${status.error}`);
  const selected = chooseModel(status.models, model);
  const payload = {
    model: selected,
    messages,
    stream: false,
    think: false,
    options: { temperature, num_predict: numPredict }
  };
  if (json) payload.format = 'json';
  const response = await fetchJson(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 180000);
  return {
    model: selected,
    content: response?.message?.content || ''
  };
}

async function phospheneStatus() {
  try {
    const data = await fetchJson(`${PHOSPHENE_URL}/status`, {}, 3500);
    return {
      ok: true,
      url: PHOSPHENE_URL,
      running: Boolean(data.running),
      paused: Boolean(data.paused),
      queueLength: Array.isArray(data.queue) ? data.queue.length : 0,
      historyCount: Array.isArray(data.history) ? data.history.length : 0,
      baseAvailable: Boolean(data.base_available),
      q8Available: Boolean(data.q8_available),
      reposReady: data.repos_ready,
      reposTotal: data.repos_total,
      tier: data.tier || null
    };
  } catch (error) {
    return { ok: false, url: PHOSPHENE_URL, error: error.message };
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function dirSizeMetrics(targetPath) {
  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const totals = { logicalBytes: 0, allocatedBytes: 0 };
    for (const entry of entries) {
      const fullPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        const nested = await dirSizeMetrics(fullPath);
        totals.logicalBytes += nested.logicalBytes;
        totals.allocatedBytes += nested.allocatedBytes;
      }
      if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        totals.logicalBytes += stat.size;
        totals.allocatedBytes += Number(stat.blocks || 0) * 512;
      }
    }
    return totals;
  } catch {
    return { logicalBytes: 0, allocatedBytes: 0 };
  }
}

async function mfluxStatus() {
  const [binOk, modelOk, modelMetrics] = await Promise.all([
    pathExecutable(MFLUX_BIN),
    pathExists(MFLUX_QWEN_EDIT_MODEL),
    dirSizeMetrics(MFLUX_QWEN_EDIT_MODEL)
  ]);
  const minReadyBytes = 20 * 1024 * 1024 * 1024;
  const storage = modelStorageStatus({
    logicalBytes: modelMetrics.logicalBytes,
    allocatedBytes: modelMetrics.allocatedBytes,
    requiredBytes: minReadyBytes
  });
  return {
    ok: binOk && modelOk && storage.hydrated,
    name: 'mflux qwen-image-edit-2511 q4',
    bin: MFLUX_BIN,
    modelPath: MFLUX_QWEN_EDIT_MODEL,
    modelSizeGb: Number((modelMetrics.logicalBytes / 1024 / 1024 / 1024).toFixed(2)),
    modelLocalSizeGb: Number((modelMetrics.allocatedBytes / 1024 / 1024 / 1024).toFixed(2)),
    installed: binOk,
    modelPresent: modelOk,
    modelHydrated: storage.hydrated,
    reason: !binOk
      ? 'mflux CLI is not installed'
      : !modelOk
        ? 'Qwen Image Edit model folder is not present yet'
        : !storage.present
          ? 'Qwen Image Edit model is still downloading'
          : !storage.hydrated
            ? 'Qwen Image Edit model exists in iCloud but is not downloaded locally'
            : 'Ready for reference-conditioned image generation'
  };
}

const modelRegistry = [
  {
    id: 'qwen-image-edit-2511-q4',
    name: 'Qwen Image Edit 2511 q4',
    backend: 'mflux',
    kind: 'reference image generation',
    repo: 'fcreait/Qwen-Image-Edit-mflux',
    include: ['q4/*', 'README.md'],
    targetDir: path.dirname(MFLUX_QWEN_EDIT_MODEL),
    modelPath: MFLUX_QWEN_EDIT_MODEL,
    requiredBytes: 20 * 1024 * 1024 * 1024
  }
];

async function getModelStatuses() {
  return Promise.all(modelRegistry.map(async model => {
    const metrics = await dirSizeMetrics(model.modelPath);
    const storage = modelStorageStatus({
      logicalBytes: metrics.logicalBytes,
      allocatedBytes: metrics.allocatedBytes,
      requiredBytes: model.requiredBytes
    });
    const job = installJobs.get(model.id) || null;
    return {
      ...model,
      installed: storage.hydrated,
      present: storage.present,
      hydrated: storage.hydrated,
      sizeGb: Number((metrics.allocatedBytes / 1024 / 1024 / 1024).toFixed(2)),
      logicalSizeGb: Number((metrics.logicalBytes / 1024 / 1024 / 1024).toFixed(2)),
      localSizeGb: Number((metrics.allocatedBytes / 1024 / 1024 / 1024).toFixed(2)),
      installing: Boolean(job && job.status === 'running'),
      installStatus: job ? {
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
        error: job.error,
        logPath: job.logPath
      } : null
    };
  }));
}

async function appendLog(filePath, text) {
  await fs.appendFile(filePath, text).catch(() => {});
}

function startModelInstall(model) {
  const existing = installJobs.get(model.id);
  if (existing && existing.status === 'running') return existing;

  const logPath = path.join(LOG_DIR, `${model.id}-install.log`);
  const startedAt = new Date().toISOString();
  const job = {
    id: model.id,
    status: 'running',
    startedAt,
    finishedAt: null,
    exitCode: null,
    error: null,
    logPath
  };
  installJobs.set(model.id, job);

  const hasHf = pathExecutable(HF_BIN);
  hasHf.then(async directHf => {
    if (!directHf && !(await pathExecutable(UVX_BIN))) {
      throw new Error(`Neither hf nor uvx is executable. Checked: ${[...HF_BIN_CANDIDATES, ...UVX_BIN_CANDIDATES].join(', ')}`);
    }
    await fs.mkdir(model.targetDir, { recursive: true });
    await appendLog(logPath, `Started ${startedAt}\nTarget: ${model.targetDir}\n`);
    const args = directHf
      ? ['download', model.repo, ...model.include.flatMap(pattern => ['--include', pattern]), '--local-dir', model.targetDir]
      : ['--with', 'hf_xet', '--from', 'huggingface_hub', 'hf', 'download', model.repo, ...model.include.flatMap(pattern => ['--include', pattern]), '--local-dir', model.targetDir];
    const command = directHf ? HF_BIN : UVX_BIN;
    await appendLog(logPath, `$ ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, HF_XET_HIGH_PERFORMANCE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', data => appendLog(logPath, data.toString()));
    child.stderr.on('data', data => appendLog(logPath, data.toString()));
    child.on('error', error => {
      job.status = 'failed';
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
      appendLog(logPath, `\nERROR: ${error.message}\n`);
    });
    child.on('close', code => {
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      job.status = code === 0 ? 'done' : 'failed';
      appendLog(logPath, `\nFinished ${job.finishedAt} exit=${code}\n`);
    });
  }).catch(error => {
    job.status = 'failed';
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

function dataUrlToBuffer(dataUrl = '') {
  const match = String(dataUrl).match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/);
  if (!match) throw new Error('Expected data URL');
  const mime = match[1] || 'image/png';
  const buffer = Buffer.from(match[2], 'base64');
  const ext = mime.includes('jpeg') ? 'jpg' : mime.split('/')[1] || 'png';
  return { buffer, mime, ext };
}

async function writeImageDataUrl(dataUrl, basename = 'shot') {
  const { buffer, mime, ext } = dataUrlToBuffer(dataUrl);
  const filename = `${cleanId(basename)}-${Date.now()}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  await fs.writeFile(filePath, buffer);
  return { filePath, filename, mime };
}

async function uploadImageToPhosphene({ filePath, filename, mime }) {
  const blob = new Blob([await fs.readFile(filePath)], { type: mime });
  const form = new FormData();
  form.append('image', blob, filename);
  return fetchJson(`${PHOSPHENE_URL}/upload`, { method: 'POST', body: form }, 60000);
}

function normalizeCharacters(items = []) {
  return items.map((character, index) => {
    const physical = character.physical || {};
    const clothing = character.clothing || {};
    return {
      id: character.id || cleanId(character.name || `character-${index + 1}`),
      name: character.name || `Character ${index + 1}`,
      role: character.role || 'N/A',
      type: character.type || 'human',
      personality: character.personality || 'N/A',
      physical: {
        age: physical.age || 'N/A',
        sex: physical.sex || 'N/A',
        face: physical.face || 'N/A',
        hair: physical.hair || 'N/A',
        eyes: physical.eyes || 'N/A',
        nose: physical.nose || 'N/A',
        mouth: physical.mouth || 'N/A',
        body: physical.body || 'N/A',
        bodyType: physical.bodyType || 'N/A',
        skinTone: physical.skinTone || 'N/A'
      },
      clothing: {
        shirtColor: clothing.shirtColor || 'N/A',
        shirtType: clothing.shirtType || 'N/A',
        pants: clothing.pants || 'N/A',
        pantsColor: clothing.pantsColor || 'N/A',
        pantsType: clothing.pantsType || 'N/A',
        pantsLength: clothing.pantsLength || 'N/A',
        skirt: clothing.skirt || 'N/A',
        skirtColor: clothing.skirtColor || 'N/A',
        skirtType: clothing.skirtType || 'N/A',
        skirtLength: clothing.skirtLength || 'N/A',
        shorts: clothing.shorts || 'N/A',
        shortsColor: clothing.shortsColor || 'N/A',
        shortsType: clothing.shortsType || 'N/A',
        shortsLength: clothing.shortsLength || 'N/A',
        shoes: clothing.shoes || 'N/A',
        accessories: clothing.accessories || 'N/A',
        description: clothing.description || 'N/A'
      },
      faceRefDataUrl: character.faceRefDataUrl || '',
      avatarDataUrl: character.avatarDataUrl || ''
    };
  });
}

function profileCompletenessScore(character = {}) {
  const physical = character.physical || {};
  const clothing = character.clothing || {};
  const required = [
    character.name,
    character.role,
    physical.age,
    physical.sex,
    physical.face,
    physical.hair,
    physical.eyes,
    physical.nose,
    physical.mouth,
    physical.body,
    physical.bodyType,
    clothing.shirtColor,
    clothing.shirtType,
    clothing.shoes
  ];
  return required.filter(value => value && !/^N\/A$/i.test(String(value).trim())).length / required.length;
}

async function repairWeakCharacters({ project, characters, extras, model }) {
  if (characters.every(character => profileCompletenessScore(character) >= 0.75)) {
    return { characters, extras };
  }
  const response = await ollamaChat({
    model,
    json: true,
    numPredict: 2200,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: `You repair weak film character JSON. Return ONLY JSON {"characters":[...],"extras":[...]}.
Do not change character names or roles. Replace missing or N/A physical and wardrobe fields with concrete visual continuity details.
Every human character must have concrete age, sex, face, hair, eyes, nose, mouth, body, bodyType, skinTone, shirtColor, shirtType, shoes, and a wardrobe description.
Use N/A only for clothing categories that truly do not apply, such as skirt or shorts.`
      },
      {
        role: 'user',
        content: JSON.stringify({
          title: project.movieTitle,
          plot: project.plot,
          genre: project.genreIdea,
          eraSetting: project.eraSetting,
          weakCharacters: characters,
          extras
        })
      }
    ]
  });
  const repaired = extractJson(response.content);
  return {
    characters: repaired.characters || characters,
    extras: repaired.extras || extras
  };
}

const filmAgentFlow = {
  roles: [
    'Story Editor',
    'Casting and Continuity Supervisor',
    'Location Designer',
    'Storyboard Director',
    'Image Prompt Supervisor',
    'Video Producer',
    'Export Producer'
  ],
  nodes: [
    { id: 'story_bible', role: 'Story Editor', output: 'story_bible.md' },
    { id: 'characters', role: 'Casting and Continuity Supervisor', output: 'characters.json' },
    { id: 'locations', role: 'Location Designer', output: 'locations.json' },
    { id: 'screenplay', role: 'Story Editor', output: 'screenplay.txt' },
    { id: 'shotlist', role: 'Storyboard Director', output: 'shotlist.json' },
    { id: 'image_prompts', role: 'Image Prompt Supervisor', output: 'image_prompts.json' },
    { id: 'video_jobs', role: 'Video Producer', output: 'phosphene_jobs.json' },
    { id: 'pitch_deck', role: 'Export Producer', output: 'pitch_deck.zip' }
  ]
};

// Phosphene is the first provider, not the provider architecture. Its proven
// crash-safe routes stay intact while the neutral surface below lets trusted
// local adapters add any API or MCP-backed renderer without editing Studio.
mediaProviders.register({
  id: 'phosphene',
  routes: {
    queueBatch: '/api/video/phosphene/queue-batch',
    getJobs: '/api/video/phosphene/jobs',
    getMedia: id => `/api/video/phosphene/jobs/${encodeURIComponent(id)}/media`,
    assemble: '/api/video/phosphene/assemble'
  },
  async describe() {
    const health = await phospheneStatus();
    return {
      name: 'Phosphene',
      kind: 'local',
      mediaKinds: ['video'],
      configured: true,
      requiresBillingApproval: false,
      allowsCustomModel: false,
      models: [],
      capabilities: {
        textToVideo: true,
        imageToVideo: true,
        firstLastFrame: false,
        videoExtension: false,
        localDurableMedia: true,
        asynchronous: true
      },
      health: { ok: health.ok, running: health.running, tier: health.tier || '' },
      credentials: { configured: true, fields: [] }
    };
  }
}, { source: 'built-in' });

mediaProviders.register({
  id: 'pitchdeck-stills',
  routes: { generateImage: '/api/image/mflux/generate' },
  async describe() {
    const [health, phosphene, engineConfig, engineStatus] = await Promise.all([
      mfluxStatus(), phospheneStatus(),
      fetchJson(`${PHOSPHENE_URL}/agent/image/config`, {}, 3000).catch(() => null),
      fetchJson(`${PHOSPHENE_URL}/image/engine_status`, {}, 3000).catch(() => null)
    ]);
    const configured = Boolean(health.ok || phosphene.ok);
    const activeEngine = engineConfig?.image_engine || {};
    const activeModel = activeEngine.mflux_model || activeEngine.kind || health.name || '';
    const models = [{
      id: 'auto',
      name: `Auto — ${activeModel || 'Phosphene saved image engine'}`
    }, ...(Array.isArray(engineStatus?.engines) ? engineStatus.engines : []).map(engine => ({
      id: engine.engine,
      name: `${engine.engine}${engine.cached ? ' — installed' : engine.download_gb ? ` — needs ${engine.download_gb} GB` : ''}`
    }))];
    return {
      name: 'PitchDeck stills',
      kind: 'local',
      mediaKinds: ['image'],
      configured,
      requiresBillingApproval: false,
      allowsCustomModel: true,
      models,
      capabilities: {
        textToImage: true,
        referenceImages: true,
        maximumReferenceImages: 3,
        localDurableMedia: true,
        asynchronous: false
      },
      health: {
        ok: configured,
        backend: phosphene.ok ? `Phosphene · ${activeModel || 'saved image engine'}` : (health.ok ? health.name : ''),
        reason: configured ? '' : health.reason,
        activeModel
      },
      credentials: { configured: true, fields: [] }
    };
  }
}, { source: 'built-in' });

mediaProviders.register(await createMcpMediaProvider({
  dataDir: DATA_DIR,
  generatedDir: GENERATED_DIR,
  uploadsDir: UPLOADS_DIR,
  writeImageDataUrl,
  getProviderConfig: providerId => providerConfigStore.values(providerId)
}), { source: 'built-in' });
mediaProviders.register(await createRestMediaProvider({
  dataDir: DATA_DIR,
  generatedDir: GENERATED_DIR,
  uploadsDir: UPLOADS_DIR,
  writeImageDataUrl,
  getProviderConfig: providerId => providerConfigStore.values(providerId)
}), { source: 'built-in' });

const extraVideoProviderDirs = String(process.env.DIRECTORS_CONSOLE_VIDEO_PROVIDER_DIRS || '')
  .split(path.delimiter)
  .map(value => value.trim())
  .filter(Boolean);
await loadMediaProviderPlugins(
  mediaProviders,
  [...new Set([VIDEO_PROVIDER_PLUGIN_DIR, ...extraVideoProviderDirs])],
  {
    schema: 'pitchdeck/media-provider-context@1',
    dataDir: DATA_DIR,
    generatedDir: GENERATED_DIR,
    uploadsDir: UPLOADS_DIR,
    fetchJson,
    writeImageDataUrl,
    getProviderConfig: providerId => providerConfigStore.values(providerId)
  }
);

async function configuredProviderCatalog(kind = '') {
  const catalog = await mediaProviders.catalog(kind);
  for (const descriptor of catalog.providers) {
    const fields = normalizeConfigFields(descriptor);
    if (!fields.length) continue;
    const configuration = await providerConfigStore.publicConfiguration(descriptor);
    descriptor.configurationStatus = {
      configured: configuration.configured,
      fields: configuration.fields.map(field => ({ id: field.id, configured: field.configured }))
    };
    descriptor.credentials.configured = configuration.fields
      .filter(field => field.secret).every(field => !field.required || field.configured);
    // Declared required fields are the source of truth for whether an adapter
    // can receive paid work. Availability/health may be reported separately.
    descriptor.configured = configuration.configured && descriptor.available !== false;
  }
  return catalog;
}

async function providerDescriptor(providerId) {
  const adapter = mediaProviders.require(providerId);
  return mediaProviders.describe(adapter);
}

const app = express();
app.use((req, res, next) => {
  const origin = req.get('Origin') || '';
  if (origin && !isAllowedLocalOrigin(origin)) {
    res.status(403).json({ error: 'Origin is not allowed' });
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: '60mb' }));

app.get('/api/status', async (_req, res) => {
  const [ollama, phosphene, imageBackend] = await Promise.all([ollamaTags(), phospheneStatus(), mfluxStatus()]);
  res.json({
    ollama,
    phosphene,
    imageBackend
  });
});

app.get('/api/video/providers', async (_req, res) => {
  try {
    const catalog = await configuredProviderCatalog('video');
    res.json({
      ...catalog,
      schema: 'pitchdeck/video-providers@1',
      pluginDirectory: VIDEO_PROVIDER_PLUGIN_DIR
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/image/providers', async (_req, res) => {
  try {
    const catalog = await configuredProviderCatalog('image');
    res.json({ ...catalog, schema: 'pitchdeck/image-providers@1', pluginDirectory: VIDEO_PROVIDER_PLUGIN_DIR });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/media/providers', async (_req, res) => {
  try {
    res.json({ ...(await configuredProviderCatalog()), pluginDirectory: VIDEO_PROVIDER_PLUGIN_DIR });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/media/providers/:providerId/config', async (req, res) => {
  try {
    const descriptor = await providerDescriptor(req.params.providerId);
    res.json(await providerConfigStore.publicConfiguration(descriptor));
  } catch (error) {
    res.status(error?.code === 'VIDEO_PROVIDER_NOT_FOUND' ? 404 : 400).json({ error: error.message });
  }
});

app.post('/api/media/providers/:providerId/config', async (req, res) => {
  try {
    const descriptor = await providerDescriptor(req.params.providerId);
    const configuration = await providerConfigStore.update(descriptor, req.body || {});
    const refreshed = (await configuredProviderCatalog()).providers.find(provider => provider.id === descriptor.id) || descriptor;
    res.json({ ok: true, configuration, provider: refreshed });
  } catch (error) {
    res.status(error?.code === 'VIDEO_PROVIDER_NOT_FOUND' ? 404 : 400).json({ error: error.message });
  }
});

app.get('/api/models', async (_req, res) => {
  res.json({ models: await getModelStatuses() });
});

app.post('/api/models/install/:id', async (req, res) => {
  const model = modelRegistry.find(item => item.id === req.params.id);
  if (!model) {
    res.status(404).json({ error: 'Model not found' });
    return;
  }
  const job = startModelInstall(model);
  res.json({ ok: true, job });
});

function aspectForDimensions(width, height) {
  const ratio = Math.max(1, Number(width) || 1024) / Math.max(1, Number(height) || 576);
  if (ratio >= 1.7) return '16:9';
  if (ratio >= 1.25) return '4:3';
  if (ratio <= 0.6) return '9:16';
  if (ratio <= 0.8) return '3:4';
  return '1:1';
}

async function imageResult(outputPath, extra = {}) {
  const imageBuffer = await fs.readFile(outputPath);
  const ext = path.extname(outputPath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return {
    ok: true,
    outputPath,
    imageDataUrl: `data:${mime};base64,${imageBuffer.toString('base64')}`,
    stdout: '',
    stderr: '',
    ...extra
  };
}

async function generateImageViaPhosphene({ prompt, imageDataUrls, label, width, height, engineOverride }) {
  const refs = [];
  for (const [index, dataUrl] of imageDataUrls.slice(0, 3).entries()) {
    const localImage = await writeImageDataUrl(dataUrl, `${label}-ref-${index + 1}`);
    const uploaded = await uploadImageToPhosphene(localImage);
    if (!uploaded?.path) throw new Error('Phosphene did not return a reference image path');
    refs.push(uploaded.path);
  }

  const generated = await fetchJson(`${PHOSPHENE_URL}/image/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      n: 1,
      aspect: aspectForDimensions(width, height),
      seed: -1,
      refs,
      engine_override: engineOverride || (refs.length ? 'qwen_edit_inline' : 'auto')
    })
  }, 45 * 60 * 1000);
  const first = Array.isArray(generated?.candidates) ? generated.candidates[0] : null;
  const outputPath = first?.png_path || first?.path || '';
  if (!outputPath) throw new Error('Phosphene completed without returning an image path');
  return imageResult(outputPath, { backend: 'phosphene', phosphene: generated });
}

async function generateImageViaMflux({ prompt, imageDataUrls, label, width, height, steps, lowRam }) {
  const status = await mfluxStatus();
  if (!status.ok) throw new Error(status.reason);
  if (imageDataUrls.length === 0) {
    throw new Error('Direct Qwen Image Edit requires at least one reference image. Start Phosphene for text-to-image generation.');
  }

  const refPaths = [];
  for (const [index, dataUrl] of imageDataUrls.slice(0, 4).entries()) {
    const localImage = await writeImageDataUrl(dataUrl, `${label}-ref-${index + 1}`);
    refPaths.push(localImage.filePath);
  }

  const outputPath = path.join(GENERATED_DIR, `${cleanId(label)}-${Date.now()}.png`);
  const args = [
    '--model', MFLUX_QWEN_EDIT_MODEL,
    '--base-model', 'qwen',
    '--image-paths', ...refPaths,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--steps', String(Math.max(4, Number(steps) || 12)),
    '--output', outputPath,
    '--metadata'
  ];
  if (lowRam) args.unshift('--low-ram');

  const { stdout, stderr } = await execFileAsync(MFLUX_BIN, args, {
    cwd: ROOT,
    timeout: 45 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024
  });
  return imageResult(outputPath, { backend: 'mflux', stdout, stderr });
}

app.post('/api/image/mflux/generate', async (req, res) => {
  try {
    const {
      prompt,
      imageDataUrls = [],
      label = 'storyboard-shot',
      width = 1024,
      height = 576,
      steps = 12,
      lowRam = true,
      engineOverride = '',
      model = ''
    } = req.body || {};
    if (!prompt || !String(prompt).trim()) throw new Error('Missing image prompt');
    if (!Array.isArray(imageDataUrls)) throw new Error('imageDataUrls must be an array');

    const request = {
      prompt: String(prompt).trim(), imageDataUrls, label, width, height, steps, lowRam,
      engineOverride: String(engineOverride || model || '').trim()
    };
    const phosphene = await phospheneStatus();
    const result = phosphene.ok
      ? await generateImageViaPhosphene(request)
      : await generateImageViaMflux(request);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents/flow', (_req, res) => {
  res.json(filmAgentFlow);
});

app.post('/api/projects/save', async (req, res) => {
  const project = req.body?.project;
  if (!project || typeof project !== 'object') {
    res.status(400).json({ error: 'Missing project object' });
    return;
  }
  const id = cleanId(project.id || project.movieTitle || 'untitled-film');
  const filePath = path.join(PROJECTS_DIR, `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify({ ...project, id, savedAt: new Date().toISOString() }, null, 2));
  res.json({ ok: true, id, filePath });
});

app.get('/api/projects', async (_req, res) => {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(PROJECTS_DIR, entry.name);
    try {
      const project = JSON.parse(await fs.readFile(filePath, 'utf8'));
      projects.push({
        id: project.id || entry.name.replace(/\.json$/, ''),
        movieTitle: project.movieTitle || 'Untitled',
        savedAt: project.savedAt || null
      });
    } catch {
      // Ignore unreadable project files instead of blocking the app.
    }
  }
  res.json({ projects: projects.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))) });
});

app.get('/api/projects/:id', async (req, res) => {
  const filePath = path.join(PROJECTS_DIR, `${cleanId(req.params.id)}.json`);
  try {
    res.json({ project: JSON.parse(await fs.readFile(filePath, 'utf8')) });
  } catch {
    res.status(404).json({ error: 'Project not found' });
  }
});

app.post('/api/agents/characters', async (req, res) => {
  try {
    const { project, model } = req.body;
    const response = await ollamaChat({
      model,
      json: true,
      numPredict: 1800,
      messages: [
        {
          role: 'system',
          content: `You are a film casting and continuity supervisor creating locked reference records for AI filmmaking.
Return ONLY JSON with {"characters":[...],"extras":[...]}.
Invent concrete, filmable visual details when the plot does not specify them. Do not leave age, sex, face, hair, eyes, nose, mouth, body, bodyType, skinTone, shirtColor, shirtType, shoes, or clothing.description as N/A.
Use "N/A" only for clothing categories that truly do not apply, such as skirt or shorts.
Each character object must exactly follow:
{"id":"stable-slug","name":"Name","role":"story role","type":"human","personality":"specific","physical":{"age":"number or age phrase","sex":"male/female/nonbinary/etc","face":"specific facial structure","hair":"specific hair","eyes":"specific eyes","nose":"specific nose","mouth":"specific mouth","body":"specific body","bodyType":"specific body type","skinTone":"specific skin tone"},"clothing":{"shirtColor":"color","shirtType":"type","pants":"yes or N/A","pantsColor":"color or N/A","pantsType":"type or N/A","pantsLength":"length or N/A","skirt":"yes or N/A","skirtColor":"color or N/A","skirtType":"type or N/A","skirtLength":"length or N/A","shorts":"yes or N/A","shortsColor":"color or N/A","shortsType":"type or N/A","shortsLength":"length or N/A","shoes":"specific shoes","accessories":"specific accessories or N/A","description":"one locked wardrobe sentence"}}`
        },
        {
          role: 'user',
          content: JSON.stringify({
            title: project.movieTitle,
            plot: project.plot,
            genre: project.genreIdea,
            eraSetting: project.eraSetting,
            photoStyle: project.photoStyle,
            existingCharacters: project.characterProfiles || []
          })
        }
      ]
    });
    const parsed = extractJson(response.content);
    const repaired = await repairWeakCharacters({
      project,
      model: response.model,
      characters: parsed.characters || [],
      extras: parsed.extras || []
    });
    res.json({
      model: response.model,
      characters: normalizeCharacters(repaired.characters || []),
      extras: normalizeCharacters(repaired.extras || []).map(extra => ({ ...extra, isExtra: true }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agents/screenplay', async (req, res) => {
  try {
    const { project, model } = req.body;
    const minutes = Number(project.minutesToExtract || 1);
    const response = await ollamaChat({
      model,
      temperature: 0.45,
      numPredict: 3200,
      messages: [
        {
          role: 'system',
          content: `You are a professional short-film screenwriter. Write a ${minutes}-minute screenplay in proper screenplay format. Use scene headings, action lines, and dialogue. Preserve the supplied locked character identities.`
        },
        {
          role: 'user',
          content: JSON.stringify({
            title: project.movieTitle,
            plot: project.plot,
            genre: project.genreIdea,
            eraSetting: project.eraSetting,
            photoStyle: project.photoStyle,
            minutes,
            characters: project.characterProfiles || []
          })
        }
      ]
    });
    res.json({ model: response.model, screenplay: response.content.trim() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agents/minute', async (req, res) => {
  try {
    const { project, minuteNumber = 1, model } = req.body;
    const response = await ollamaChat({
      model,
      json: true,
      temperature: 0.25,
      numPredict: 2600,
      messages: [
        {
          role: 'system',
          content: `You are a storyboard director and continuity supervisor. Return ONLY JSON.
Schema: {"minuteNumber":number,"sceneCanon":[{"id":"scene-1","location":"string","interiorExterior":"interior|exterior","timeOfDay":"string","lighting":"string","environmentDetails":"string","props":["string"]}],"shots":[...]}.
You must create exactly 12 shots. Each shot is 5 seconds. Do not create 11 or 13.
Each shot requires: sceneId, shotNumber, location, interiorExterior, timeOfDay, lighting, visualStyle, camera, subjectAction, environmentDetails, charactersInShot, propsInShot.
The subjectAction can be concise, but it must be visible action only. Do not include dialogue or sound in subjectAction.`
        },
        {
          role: 'user',
          content: JSON.stringify({
            title: project.movieTitle,
            genre: project.genreIdea,
            eraSetting: project.eraSetting,
            photoStyle: project.photoStyle,
            minuteNumber,
            screenplay: project.finalScript,
            characters: project.characterProfiles || [],
            previousMinutes: project.minutes || []
          })
        }
      ]
    });
    const parsed = extractJson(response.content);
    let shots = Array.isArray(parsed.shots) ? parsed.shots : [];
    if (shots.length < 12) {
      const last = shots[shots.length - 1] || {};
      while (shots.length < 12) {
        shots.push({
          ...last,
          shotNumber: shots.length + 1,
          subjectAction: last.subjectAction || 'The visible story action continues from the screenplay beat.',
          charactersInShot: last.charactersInShot || []
        });
      }
    }
    shots = shots.slice(0, 12).map((shot, index) => ({
      id: shot.id || `m${minuteNumber}-s${index + 1}`,
      ...shot,
      shotNumber: index + 1,
      durationSeconds: 5,
      visualStyle: shot.visualStyle || project.photoStyle || 'cinematic',
      charactersInShot: listify(shot.charactersInShot || shot.cast?.characters),
      propsInShot: listify(shot.propsInShot || shot.objects || shot.props),
      prompt: shot.prompt || '',
      generationPrompt: shot.generationPrompt || '',
      imageDataUrl: shot.imageDataUrl || '',
      imageUrl: shot.imageUrl || ''
    }));
    res.json({
      model: response.model,
      minute: {
        minuteNumber,
        durationSeconds: 60,
        sceneCanon: Array.isArray(parsed.sceneCanon) ? parsed.sceneCanon : [],
        shots
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function phospheneSnapshot() {
  return fetchJson(`${PHOSPHENE_URL}/status`, {}, 10000);
}

async function normalizeAndRememberPhospheneJobs(snapshot, ids) {
  const live = normalizePhospheneJobs(snapshot, ids);
  await terminalPhospheneStore.observe(live.jobs);
  const durable = await terminalPhospheneStore.getMany(ids);
  return mergePhospheneJobResults(ids, live, durable);
}

async function phospheneJobsWithDurableFallback(ids) {
  let snapshot;
  try {
    snapshot = await phospheneSnapshot();
  } catch (error) {
    const durable = await terminalPhospheneStore.getMany(ids);
    const result = mergePhospheneJobResults(ids, {}, durable);
    if (result.missingIds.length) {
      const unavailable = new Error(`Phosphene is not reachable at ${PHOSPHENE_URL}: ${error.message}`);
      unavailable.code = 'PHOSPHENE_UNREACHABLE';
      unavailable.missingIds = result.missingIds;
      throw unavailable;
    }
    return result;
  }
  return normalizeAndRememberPhospheneJobs(snapshot, ids);
}

async function queuePhospheneJob(payload = {}, { verifyAvailable = true } = {}) {
  if (verifyAvailable) {
    try {
      await phospheneSnapshot();
    } catch (error) {
      throw new Error(`Phosphene is not reachable at ${PHOSPHENE_URL}: ${error.message}`);
    }
  }
  const {
    prompt,
    imageDataUrl,
    label = 'storyboard shot',
    quality = 'draft',
    frames = 121,
    steps = 8,
    width = 640,
    height = 352
  } = payload;
  if (!prompt || !String(prompt).trim()) throw new Error('Missing video prompt');

  let uploadedPath = '';
  if (imageDataUrl) {
    const localImage = await writeImageDataUrl(imageDataUrl, label);
    const upload = await uploadImageToPhosphene(localImage);
    if (!upload?.path) throw new Error('Phosphene did not return an uploaded image path');
    uploadedPath = upload.path;
  }

  const form = new URLSearchParams({
    mode: uploadedPath ? 'i2v' : 't2v',
    prompt: String(prompt).trim(),
    width: String(width),
    height: String(height),
    frames: String(frames),
    steps: String(Math.max(8, Number(steps) || 8)),
    seed: '-1',
    quality: String(quality || 'draft'),
    preset_label: String(label || 'storyboard shot'),
    open_when_done: 'off'
  });
  if (uploadedPath) form.set('image', uploadedPath);

  const job = await fetchJson(`${PHOSPHENE_URL}/queue/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  }, 60000);
  if (!job?.id) throw new Error('Phosphene accepted the request without returning a job id');
  return { uploadedPath, job };
}

function requestMediaProviderId(req) {
  return String(req.params?.providerId || req.body?.providerId || req.query?.providerId || 'phosphene').trim().toLowerCase();
}

function providerRoute(adapter, operation, req) {
  const route = adapter.routes?.[operation];
  return typeof route === 'function' ? route(req.params?.id || '', req) : route;
}

function videoProviderError(res, error) {
  const status = Number(error?.statusCode)
    || (error?.code === 'VIDEO_PROVIDER_NOT_FOUND' ? 404 : 500);
  res.status(status).json({
    error: String(error?.message || error),
    ...(error?.code ? { code: error.code } : {})
  });
}

async function checkedMediaProvider(req, operation) {
  const adapter = mediaProviders.require(requestMediaProviderId(req));
  const descriptor = await mediaProviders.describe(adapter);
  if (normalizeConfigFields(descriptor).length) {
    const configuration = await providerConfigStore.publicConfiguration(descriptor);
    descriptor.configured = configuration.configured && descriptor.available !== false;
  }
  if (!descriptor.configured) {
    const error = new Error(`${descriptor.name} is installed but its credentials or endpoint are not configured`);
    error.code = 'VIDEO_PROVIDER_NOT_CONFIGURED';
    error.statusCode = 409;
    throw error;
  }
  if (operation === 'queueBatch') {
    const shots = req.body?.shots;
    const unreviewed = Array.isArray(shots)
      ? shots.filter(shot => !shot?.review || !String(shot.review.schema || '').startsWith('studio/')
          || !['approved', 'blocked'].includes(shot.review.gate))
      : [];
    if (unreviewed.length) {
      const error = new Error(`${unreviewed.length} shot${unreviewed.length === 1 ? '' : 's'} lack a valid Studio canon/taste receipt`);
      error.code = 'MEDIA_REVIEW_REQUIRED';
      error.statusCode = 422;
      throw error;
    }
    const blocked = Array.isArray(shots)
      ? shots.filter(shot => shot?.review?.gate === 'blocked')
      : [];
    if (blocked.length) {
      const error = new Error(`${blocked.length} shot prompt${blocked.length === 1 ? '' : 's'} failed the canon/taste gate`);
      error.code = 'VIDEO_REVIEW_BLOCKED';
      error.statusCode = 422;
      throw error;
    }
  }
  if (operation === 'generateImage') {
    const review = req.body?.review;
    if (!review || !String(review.schema || '').startsWith('studio/')
        || !['approved', 'blocked'].includes(review.gate)) {
      const error = new Error('The still request lacks a valid Studio canon/taste receipt');
      error.code = 'MEDIA_REVIEW_REQUIRED';
      error.statusCode = 422;
      throw error;
    }
    if (review.gate === 'blocked') {
      const error = new Error('The still prompt failed the canon/taste gate');
      error.code = 'MEDIA_REVIEW_BLOCKED';
      error.statusCode = 422;
      throw error;
    }
  }
  if (['queueBatch', 'generateImage'].includes(operation) && descriptor.requiresBillingApproval) {
    const approval = req.body?.billingApproval;
    if (approval?.approved !== true || String(approval?.providerId || '') !== adapter.id) {
      const error = new Error(`Explicit billing approval is required before ${descriptor.name} can submit paid renders`);
      error.code = 'MEDIA_BILLING_APPROVAL_REQUIRED';
      error.statusCode = 402;
      throw error;
    }
  }
  return { adapter, descriptor };
}

async function dispatchMediaProviderJson(operation, req, res) {
  try {
    const { adapter, descriptor } = await checkedMediaProvider(req, operation);
    const compatibilityRoute = providerRoute(adapter, operation, req);
    if (compatibilityRoute) {
      res.redirect(307, compatibilityRoute);
      return;
    }
    const handler = adapter[operation];
    if (typeof handler !== 'function') {
      const error = new Error(`${descriptor.name} does not implement ${operation}`);
      error.code = 'VIDEO_PROVIDER_OPERATION_UNSUPPORTED';
      error.statusCode = 501;
      throw error;
    }
    const result = await handler({
      body: req.body || {},
      query: req.query || {},
      params: req.params || {},
      requestId: req.get('X-Request-Id') || ''
    });
    const status = Number(result?.httpStatus) || 200;
    const body = result && Object.hasOwn(result, 'body') ? result.body : result;
    res.status(status).json(body ?? { ok: true });
  } catch (error) {
    videoProviderError(res, error);
  }
}

app.post('/api/video/queue-batch', (req, res) => dispatchMediaProviderJson('queueBatch', req, res));
app.post('/api/video/jobs', (req, res) => dispatchMediaProviderJson('getJobs', req, res));
app.post('/api/video/assemble', (req, res) => dispatchMediaProviderJson('assemble', req, res));
app.post('/api/image/generate', (req, res) => dispatchMediaProviderJson('generateImage', req, res));
app.get('/api/video/providers/:providerId/jobs/:id/media', async (req, res) => {
  try {
    const { adapter, descriptor } = await checkedMediaProvider(req, 'getMedia');
    const compatibilityRoute = providerRoute(adapter, 'getMedia', req);
    if (compatibilityRoute) {
      res.redirect(307, compatibilityRoute);
      return;
    }
    if (typeof adapter.getMedia !== 'function') {
      const error = new Error(`${descriptor.name} does not implement getMedia`);
      error.code = 'VIDEO_PROVIDER_OPERATION_UNSUPPORTED';
      error.statusCode = 501;
      throw error;
    }
    const media = await adapter.getMedia({ id: req.params.id, requestId: req.get('X-Request-Id') || '' });
    if (!media?.filePath) {
      const error = new Error(`${descriptor.name} must materialize completed media to a local file before serving it`);
      error.code = 'VIDEO_PROVIDER_MEDIA_NOT_MATERIALIZED';
      error.statusCode = 409;
      throw error;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (media.mimeType) res.type(media.mimeType);
    res.sendFile(path.resolve(media.filePath));
  } catch (error) {
    if (!res.headersSent) videoProviderError(res, error);
  }
});

app.post('/api/video/phosphene/queue', async (req, res) => {
  try {
    const queued = await queuePhospheneJob(req.body || {});
    res.json({ ok: true, ...queued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/video/phosphene/queue-batch', async (req, res) => {
  const runId = String(req.body?.runId || '').trim();
  const shots = req.body?.shots;
  if (!runId) {
    res.status(400).json({ error: 'runId is required for idempotent batch queueing' });
    return;
  }
  if (runId.length > 240) {
    res.status(400).json({ error: 'runId must be 240 characters or fewer' });
    return;
  }
  if (!Array.isArray(shots) || shots.length === 0) {
    res.status(400).json({ error: 'shots must be a non-empty array' });
    return;
  }
  if (shots.length > 500) {
    res.status(400).json({ error: 'A batch may contain at most 500 shots' });
    return;
  }
  const seen = new Set();
  const normalizedShots = [];
  for (const shot of shots) {
    const studioShotId = String(shot?.studioShotId || '').trim();
    if (!studioShotId) {
      res.status(400).json({ error: 'Every shot requires a stable studioShotId' });
      return;
    }
    if (studioShotId.length > 240) {
      res.status(400).json({ error: `studioShotId must be 240 characters or fewer: ${studioShotId.slice(0, 80)}` });
      return;
    }
    let attempt;
    try {
      attempt = normalizePhospheneAttempt(shot?.attempt);
    } catch {
      res.status(400).json({ error: `Shot ${studioShotId} attempt must be a nonnegative integer` });
      return;
    }
    const idempotencyKey = JSON.stringify([studioShotId, attempt]);
    if (seen.has(idempotencyKey)) {
      res.status(400).json({ error: `Duplicate studioShotId/attempt: ${studioShotId}/${attempt}` });
      return;
    }
    if (!shot?.prompt || !String(shot.prompt).trim()) {
      res.status(400).json({ error: `Shot ${studioShotId} is missing a video prompt` });
      return;
    }
    seen.add(idempotencyKey);
    normalizedShots.push({ shot, studioShotId, attempt });
  }

  let preflightSnapshot = null;
  try {
    const existing = await Promise.all(normalizedShots.map(({ studioShotId, attempt }) => (
      phospheneJobLedger.get(runId, studioShotId, attempt)
    )));
    if (existing.some(record => record?.state !== 'accepted')) {
      preflightSnapshot = await phospheneSnapshot();
    }
  } catch (error) {
    res.status(503).json({ error: `Cannot prepare idempotent Phosphene batch: ${error.message}` });
    return;
  }

  const jobs = [];
  const errors = [];
  for (const { shot, studioShotId, attempt } of normalizedShots) {
    try {
      const { record, reused, recovered } = await phospheneJobLedger.getOrCreate(
        runId,
        studioShotId,
        attempt,
        {
          createJob: pending => queuePhospheneJob({
            ...shot,
            label: phospheneSubmissionLabel(pending.marker, shot.label || studioShotId)
          }, { verifyAvailable: false }),
          reconcile: async (pending, context) => {
            const snapshot = context.phase === 'pending-retry'
              ? preflightSnapshot
              : await phospheneSnapshot();
            return findPhospheneJobByMarker(snapshot, pending.marker);
          }
        }
      );
      jobs.push({
        studioShotId,
        attempt: record.attempt,
        id: record.id,
        uploadedPath: record.uploadedPath,
        job: record.job,
        reused,
        recovered
      });
    } catch (error) {
      errors.push({
        studioShotId,
        attempt,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.marker ? { marker: error.marker } : {})
      });
    }
  }
  res.json({ ok: errors.length === 0, jobs, errors });
});

app.post('/api/video/phosphene/jobs', async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
    res.status(400).json({ error: 'ids must be an array containing 1 to 500 job ids' });
    return;
  }
  try {
    res.json({ ok: true, ...await phospheneJobsWithDurableFallback(ids) });
  } catch (error) {
    const status = error.code === 'PHOSPHENE_UNREACHABLE' ? 503 : 500;
    res.status(status).json({
      error: error.message,
      ...(error.missingIds ? { missingIds: error.missingIds } : {})
    });
  }
});

app.get('/api/video/phosphene/jobs/:id/media', async (req, res) => {
  try {
    const normalized = (await phospheneJobsWithDurableFallback([req.params.id])).jobs[0];
    if (!normalized) {
      res.status(404).json({ error: 'Phosphene job was not found' });
      return;
    }
    if (normalized.status !== 'done') {
      res.status(409).json({ error: `Phosphene job is ${normalized.status}`, job: normalized });
      return;
    }
    if (!normalized.outputPath) {
      res.status(404).json({ error: 'Completed job has no output path' });
      return;
    }
    const outputPath = await terminalPhospheneStore.resolveOutputPath(normalized.outputPath);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(outputPath);
  } catch (error) {
    if (!res.headersSent) {
      const status = error.code === 'PHOSPHENE_UNREACHABLE' ? 503 : 404;
      res.status(status).json({ error: error.message });
    }
  }
});

async function runFfmpeg(args, timeout = 2 * 60 * 60 * 1000) {
  return execFileAsync(FFMPEG_BIN, args, {
    cwd: ROOT,
    timeout,
    maxBuffer: 16 * 1024 * 1024
  });
}

app.post('/api/video/phosphene/assemble', async (req, res) => {
  const runId = String(req.body?.runId || '').trim();
  if (!runId) {
    res.status(400).json({ error: 'runId is required for idempotent assembly' });
    return;
  }
  if (runId.length > 240) {
    res.status(400).json({ error: 'runId must be 240 characters or fewer' });
    return;
  }
  let ids;
  try {
    ids = normalizeAssemblyIds(req.body?.ids ?? req.body?.jobIds);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  const intent = deterministicAssemblyIntent(runId, ids, GENERATED_DIR);

  let tempDir = '';
  try {
    const { receipt, reused, recovered, repaired } = await assemblyReceiptLedger.getOrCreate(
      runId,
      ids,
      intent,
      {
        recover: async record => {
          const outputPath = resolveGeneratedMediaPath(GENERATED_DIR, record.fileName);
          if (path.resolve(record.outputPath) !== outputPath) {
            throw new Error('Persisted assembly intent points outside generated media');
          }
          const stat = await fs.stat(outputPath).catch(() => null);
          if (!stat?.isFile() || stat.size < 1) return null;
          return { outputPath, bytes: stat.size, mode: record.mode || 'recovered' };
        },
        createReceipt: async record => {
          if (!(await pathExecutable(FFMPEG_BIN))) {
            throw new Error(`ffmpeg is not executable. Checked: ${FFMPEG_BIN_CANDIDATES.join(', ')}`);
          }
          const normalizedById = new Map(
            (await phospheneJobsWithDurableFallback(ids)).jobs.map(job => [job.id, job])
          );
          const normalized = ids.map(id => normalizedById.get(id) || null);
          const unavailable = normalized
            .map((job, index) => ({ id: ids[index], job }))
            .filter(item => !item.job || item.job.status !== 'done' || !item.job.outputPath);
          if (unavailable.length) {
            const error = new Error('Every requested job must be complete and have an output path');
            error.code = 'ASSEMBLY_JOBS_UNAVAILABLE';
            error.unavailable = unavailable.map(item => ({
              id: item.id,
              status: item.job?.status || 'missing'
            }));
            throw error;
          }

          const inputPaths = await Promise.all(
            normalized.map(job => terminalPhospheneStore.resolveOutputPath(job.outputPath))
          );

          const outputPath = resolveGeneratedMediaPath(GENERATED_DIR, record.fileName);
          if (path.resolve(record.outputPath) !== outputPath) {
            throw new Error('Assembly output path does not match its durable intent');
          }
          const partialPath = path.resolve(record.partialPath);
          const expectedPartial = path.join(GENERATED_DIR, `.${record.fileName}.partial.mp4`);
          if (partialPath !== expectedPartial) {
            throw new Error('Assembly partial path does not match its durable intent');
          }

          tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pitchdeck-assemble-'));
          const concatPath = path.join(tempDir, 'clips.ffconcat');
          await fs.writeFile(concatPath, buildFfmpegConcatList(inputPaths), { mode: 0o600 });
          await fs.rm(partialPath, { force: true }).catch(() => {});

          let mode = 'copy';
          try {
            await runFfmpeg([
              '-y', '-hide_banner', '-loglevel', 'error',
              '-f', 'concat', '-safe', '0', '-i', concatPath,
              '-c', 'copy', '-movflags', '+faststart', partialPath
            ]);
          } catch {
            mode = 'transcode';
            await fs.rm(partialPath, { force: true }).catch(() => {});
            await runFfmpeg([
              '-y', '-hide_banner', '-loglevel', 'error',
              '-f', 'concat', '-safe', '0', '-i', concatPath,
              '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
              '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', partialPath
            ]);
          }

          const partialStat = await fs.stat(partialPath);
          if (!partialStat.isFile() || partialStat.size < 1) {
            throw new Error('ffmpeg completed without a valid partial assembly');
          }
          await fs.rename(partialPath, outputPath);
          const stat = await fs.stat(outputPath);
          return { outputPath, bytes: stat.size, mode };
        }
      }
    );

    const outputPath = resolveGeneratedMediaPath(GENERATED_DIR, receipt.fileName);
    if (path.resolve(receipt.outputPath) !== outputPath) {
      const error = new Error('Persisted assembly receipt points outside generated media');
      error.code = 'ASSEMBLY_RECEIPT_STALE';
      throw error;
    }
    const mediaUrl = `http://127.0.0.1:${port}/api/video/phosphene/assembled/${encodeURIComponent(receipt.fileName)}/media`;
    res.json({
      ok: true,
      ids: receipt.ids,
      outputPath,
      mediaUrl,
      bytes: receipt.bytes,
      mode: receipt.mode,
      reused,
      recovered,
      repaired
    });
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof AssemblyRunConflictError) {
      res.status(409).json({ error: error.message, code: error.code });
    } else if (error.code === 'ASSEMBLY_JOBS_UNAVAILABLE') {
      res.status(409).json({ error: error.message, unavailable: error.unavailable });
    } else {
      res.status(500).json({ error: error.message });
    }
  } finally {
    await fs.rm(intent.partialPath, { force: true }).catch(() => {});
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/api/video/phosphene/assembled/:fileName/media', async (req, res) => {
  let outputPath;
  try {
    outputPath = resolveGeneratedMediaPath(GENERATED_DIR, req.params.fileName);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  try {
    const stat = await fs.stat(outputPath);
    if (!stat.isFile()) throw new Error('Assembled cut is not a file');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(outputPath);
  } catch {
    res.status(404).json({ error: 'Assembled cut was not found' });
  }
});

if (STATIC_FRONTEND) {
  app.use(express.static(DIST_DIR));
  app.use((_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: ROOT,
    server: { middlewareMode: true },
    appType: 'spa'
  });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT || 5179);
app.listen(port, '127.0.0.1', () => {
  console.log(`PITCHDECK Local: http://127.0.0.1:${port}`);
});
