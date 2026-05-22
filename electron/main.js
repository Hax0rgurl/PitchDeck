import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

let mainWindow;
let serverPort = 5179;
let phospheneProcess = null;

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findPort(start = 5179) {
  for (let port = start; port < start + 40; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('No free local port found for PITCHDECK');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function chooseQwenModelPath() {
  const userDataModel = path.join(app.getPath('userData'), 'models', 'qwen-image-edit-2511-q4', 'q4');
  const siblingModel = path.join(path.dirname(app.getAppPath()), 'models', 'qwen-image-edit-2511-q4', 'q4');
  const projectModel = path.join(ROOT, 'models', 'qwen-image-edit-2511-q4', 'q4');
  const currentMachineModel = '/Users/muse/Documents/New project/directors-console-local/models/qwen-image-edit-2511-q4/q4';
  const candidates = [
    process.env.MFLUX_QWEN_EDIT_MODEL,
    userDataModel,
    siblingModel,
    projectModel,
    currentMachineModel
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return userDataModel;
}

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Retry until timeout.
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

async function startLocalBackend() {
  serverPort = await findPort(5179);
  process.env.PORT = String(serverPort);
  process.env.DIRECTORS_CONSOLE_STATIC = '1';
  process.env.DIRECTORS_CONSOLE_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.MFLUX_QWEN_EDIT_MODEL = await chooseQwenModelPath();
  await import('../server/index.js');
  const ready = await waitForHttp(`http://127.0.0.1:${serverPort}/api/status`, 20000);
  if (!ready) throw new Error('PITCHDECK backend did not become ready');
}

async function startPhospheneIfPresent() {
  const phospheneRoot = process.env.PHOSPHENE_ROOT || '/Users/muse/pinokio/api/phosphene.git';
  const script = path.join(phospheneRoot, 'mlx_ltx_panel.py');
  const python = path.join(phospheneRoot, 'ltx-2-mlx', 'env', 'bin', 'python');
  if (!(await pathExists(script)) || !(await pathExists(python))) return;
  if (await waitForHttp('http://127.0.0.1:8198/status', 1200)) return;
  phospheneProcess = spawn(python, [script], {
    cwd: phospheneRoot,
    env: { ...process.env },
    stdio: 'ignore',
    detached: false
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: 'PITCHDECK',
    backgroundColor: '#11110f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
}

app.whenReady().then(async () => {
  await startLocalBackend();
  await startPhospheneIfPresent();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (phospheneProcess && !phospheneProcess.killed) {
    phospheneProcess.kill('SIGTERM');
  }
});
