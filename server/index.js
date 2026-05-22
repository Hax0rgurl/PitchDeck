import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const DATA_DIR = process.env.DIRECTORS_CONSOLE_DATA_DIR || path.join(ROOT, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const GENERATED_DIR = path.join(DATA_DIR, 'generated');
const LOG_DIR = path.join(DATA_DIR, 'logs');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const PHOSPHENE_URL = process.env.PHOSPHENE_URL || 'http://127.0.0.1:8198';
const MFLUX_BIN = process.env.MFLUX_BIN || '/Users/muse/.local/bin/mflux-generate-qwen-edit';
const MFLUX_QWEN_EDIT_MODEL = process.env.MFLUX_QWEN_EDIT_MODEL || path.join(ROOT, 'models', 'qwen-image-edit-2511-q4', 'q4');
const HF_BIN = process.env.HF_BIN || '/Users/muse/.local/bin/hf';
const UVX_BIN = process.env.UVX_BIN || '/opt/homebrew/bin/uvx';
const STATIC_FRONTEND = process.env.DIRECTORS_CONSOLE_STATIC === '1' || process.env.NODE_ENV === 'production';
const execFileAsync = promisify(execFile);

await fs.mkdir(PROJECTS_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });
await fs.mkdir(GENERATED_DIR, { recursive: true });
await fs.mkdir(LOG_DIR, { recursive: true });

const installJobs = new Map();

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

async function dirSizeBytes(targetPath) {
  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = path.join(targetPath, entry.name);
      if (entry.isDirectory()) total += await dirSizeBytes(fullPath);
      if (entry.isFile()) total += (await fs.stat(fullPath)).size;
    }
    return total;
  } catch {
    return 0;
  }
}

async function mfluxStatus() {
  const [binOk, modelOk, modelBytes] = await Promise.all([
    pathExists(MFLUX_BIN),
    pathExists(MFLUX_QWEN_EDIT_MODEL),
    dirSizeBytes(MFLUX_QWEN_EDIT_MODEL)
  ]);
  const minReadyBytes = 20 * 1024 * 1024 * 1024;
  return {
    ok: binOk && modelOk && modelBytes >= minReadyBytes,
    name: 'mflux qwen-image-edit-2511 q4',
    bin: MFLUX_BIN,
    modelPath: MFLUX_QWEN_EDIT_MODEL,
    modelSizeGb: Number((modelBytes / 1024 / 1024 / 1024).toFixed(2)),
    installed: binOk,
    modelPresent: modelOk,
    reason: !binOk
      ? 'mflux CLI is not installed'
      : !modelOk
        ? 'Qwen Image Edit model folder is not present yet'
        : modelBytes < minReadyBytes
          ? 'Qwen Image Edit model is still downloading'
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
    const bytes = await dirSizeBytes(model.modelPath);
    const job = installJobs.get(model.id) || null;
    return {
      ...model,
      installed: bytes >= model.requiredBytes,
      sizeGb: Number((bytes / 1024 / 1024 / 1024).toFixed(2)),
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

  const hasHf = fs.access(HF_BIN).then(() => true).catch(() => false);
  hasHf.then(async directHf => {
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

const app = express();
app.use(express.json({ limit: '60mb' }));

app.get('/api/status', async (_req, res) => {
  const [ollama, phosphene, imageBackend] = await Promise.all([ollamaTags(), phospheneStatus(), mfluxStatus()]);
  res.json({
    ollama,
    phosphene,
    imageBackend
  });
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

app.post('/api/image/mflux/generate', async (req, res) => {
  try {
    const status = await mfluxStatus();
    if (!status.ok) throw new Error(status.reason);
    const {
      prompt,
      imageDataUrls = [],
      label = 'storyboard-shot',
      width = 1024,
      height = 576,
      steps = 12,
      lowRam = true
    } = req.body || {};
    if (!prompt || !String(prompt).trim()) throw new Error('Missing image prompt');
    if (!Array.isArray(imageDataUrls) || imageDataUrls.length === 0) {
      throw new Error('Qwen Image Edit requires at least one reference image path. Attach a face, location, or previous still reference first.');
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
    const imageBuffer = await fs.readFile(outputPath);
    res.json({
      ok: true,
      outputPath,
      imageDataUrl: `data:image/png;base64,${imageBuffer.toString('base64')}`,
      stdout,
      stderr
    });
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

app.post('/api/video/phosphene/queue', async (req, res) => {
  try {
    const status = await phospheneStatus();
    if (!status.ok) throw new Error(`Phosphene is not reachable at ${PHOSPHENE_URL}: ${status.error}`);
    const {
      prompt,
      imageDataUrl,
      label = 'storyboard shot',
      quality = 'draft',
      frames = 121,
      steps = 8,
      width = 640,
      height = 352
    } = req.body;
    if (!prompt || !String(prompt).trim()) throw new Error('Missing video prompt');

    let uploadedPath = '';
    if (imageDataUrl) {
      const localImage = await writeImageDataUrl(imageDataUrl, label);
      const upload = await uploadImageToPhosphene(localImage);
      uploadedPath = upload.path;
    }

    const form = new URLSearchParams({
      mode: uploadedPath ? 'i2v' : 't2v',
      prompt,
      width: String(width),
      height: String(height),
      frames: String(frames),
      steps: String(Math.max(8, Number(steps) || 8)),
      seed: '-1',
      quality,
      preset_label: label,
      open_when_done: 'off'
    });
    if (uploadedPath) form.set('image', uploadedPath);

    const queued = await fetchJson(`${PHOSPHENE_URL}/queue/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    }, 60000);
    res.json({ ok: true, uploadedPath, job: queued });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
app.listen(port, () => {
  console.log(`PITCHDECK Local: http://127.0.0.1:${port}`);
});
