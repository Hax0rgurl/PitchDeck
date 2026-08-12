import fs from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let handle;
  let directoryHandle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    directoryHandle = await fs.open(directory, 'r');
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = null;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (directoryHandle) await directoryHandle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}
