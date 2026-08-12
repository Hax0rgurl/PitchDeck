import path from 'node:path';

function compactUnique(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

export function isAllowedLocalOrigin(origin = '') {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'tauri:' && parsed.hostname === 'localhost') return true;
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return ['localhost', '127.0.0.1', '::1', '[::1]', 'tauri.localhost'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export async function selectExistingCandidate(candidates = [], exists) {
  if (typeof exists !== 'function') throw new TypeError('selectExistingCandidate requires an exists function');
  for (const candidate of compactUnique(candidates)) {
    if (await exists(candidate)) return candidate;
  }
  return '';
}

export function mfluxBinaryCandidates({ configured = '', userRoot = '/Users/muse', pinokioRoot = '' } = {}) {
  const pinokio = pinokioRoot || path.join(userRoot, 'pinokio');
  return compactUnique([
    configured,
    path.join(userRoot, '.local', 'bin', 'mflux-generate-qwen-edit'),
    path.join(pinokio, 'api', 'phosphene.git', 'ltx-2-mlx', 'env', 'bin', 'mflux-generate-qwen-edit'),
    path.join(pinokio, 'bin', 'miniforge', 'bin', 'mflux-generate-qwen-edit')
  ]);
}

export function hfBinaryCandidates({ configured = '', userRoot = '/Users/muse', pinokioRoot = '' } = {}) {
  const pinokio = pinokioRoot || path.join(userRoot, 'pinokio');
  return compactUnique([
    configured,
    path.join(userRoot, '.local', 'bin', 'hf'),
    path.join(pinokio, 'bin', 'miniforge', 'bin', 'hf'),
    path.join(pinokio, 'api', 'phosphene.git', 'ltx-2-mlx', 'env', 'bin', 'hf'),
    '/opt/homebrew/bin/hf',
    '/usr/local/bin/hf'
  ]);
}

export function uvxBinaryCandidates({ configured = '', userRoot = '/Users/muse', pinokioRoot = '' } = {}) {
  const pinokio = pinokioRoot || path.join(userRoot, 'pinokio');
  return compactUnique([
    configured,
    path.join(pinokio, 'bin', 'miniforge', 'bin', 'uvx'),
    '/opt/homebrew/bin/uvx',
    '/usr/local/bin/uvx'
  ]);
}

export function ffmpegBinaryCandidates({ configured = '', userRoot = '/Users/muse', pinokioRoot = '' } = {}) {
  const pinokio = pinokioRoot || path.join(userRoot, 'pinokio');
  return compactUnique([
    configured,
    path.join(pinokio, 'bin', 'homebrew', 'bin', 'ffmpeg'),
    path.join(pinokio, 'bin', 'miniforge', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ]);
}

export function qwenModelCandidates({ configured = '', root = '', userRoot = '/Users/muse' } = {}) {
  const suffix = ['models', 'qwen-image-edit-2511-q4', 'q4'];
  return compactUnique([
    configured,
    root ? path.join(root, ...suffix) : '',
    path.join(userRoot, 'Documents', ' CODEX BRAIN', 'Compiled Apps', 'directors-console-local', ...suffix),
    path.join(userRoot, 'Documents', 'CODEX BRAIN', 'Compiled Apps', 'directors-console-local', ...suffix),
    path.join(userRoot, 'Documents', 'New project', 'directors-console-local', ...suffix)
  ]);
}

function jobOutputPath(job = {}) {
  return job.output_path
    || job.outputPath
    || job.params?.output_path
    || job.params?.outputPath
    || '';
}

export function resolvePhospheneJob(snapshot = {}, id = '') {
  const wanted = String(id || '');
  if (!wanted) return null;

  const current = snapshot.current;
  if (current && String(current.id || '') === wanted) {
    return { raw: current, status: 'running' };
  }

  const queued = Array.isArray(snapshot.queue)
    ? snapshot.queue.find(job => String(job?.id || '') === wanted)
    : null;
  if (queued) return { raw: queued, status: 'queued' };

  const completed = Array.isArray(snapshot.history)
    ? snapshot.history.find(job => String(job?.id || '') === wanted)
    : null;
  if (!completed) return null;
  return {
    raw: completed,
    status: completed.status === 'done' ? 'done' : 'failed'
  };
}

export function normalizePhospheneJobs(snapshot = {}, ids = []) {
  const jobs = [];
  const missingIds = [];
  for (const id of compactUnique(ids)) {
    const hit = resolvePhospheneJob(snapshot, id);
    if (!hit) {
      missingIds.push(id);
      continue;
    }
    jobs.push({
      id,
      status: hit.status,
      outputPath: jobOutputPath(hit.raw),
      error: hit.status === 'failed'
        ? String(hit.raw.error || (hit.raw.status === 'cancelled' ? 'Job was cancelled' : 'Render failed'))
        : ''
    });
  }
  return { jobs, missingIds };
}

export function modelStorageStatus({ logicalBytes = 0, allocatedBytes = 0, requiredBytes = 0 } = {}) {
  const present = Number(logicalBytes) >= Number(requiredBytes) && Number(requiredBytes) > 0;
  const hydrated = present && Number(allocatedBytes) >= Number(requiredBytes) * 0.8;
  return { present, hydrated };
}

export function buildFfmpegConcatList(filePaths = []) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('At least one media file is required');
  }
  return `${filePaths.map(filePath => {
    const value = String(filePath || '');
    if (!value || /[\0\r\n]/.test(value)) throw new Error('Invalid media path');
    return `file '${value.replace(/'/g, "'\\''")}'`;
  }).join('\n')}\n`;
}

export function resolveGeneratedMediaPath(generatedRoot, fileName) {
  const root = path.resolve(String(generatedRoot || ''));
  const value = String(fileName || '');
  if (!value || value !== path.basename(value) || !/^[a-z0-9_-]+\.mp4$/i.test(value)) {
    throw new Error('Invalid generated media filename');
  }
  const target = path.resolve(root, value);
  if (path.dirname(target) !== root) throw new Error('Generated media path escapes its root');
  return target;
}
