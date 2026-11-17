import crypto from 'node:crypto';
import fs from 'node:fs';

const tails = new Map<string, Promise<void>>();

/** Serializes in-process operations; a rejected operation never poisons its queue. */
export async function withKeyLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}

/** Publish complete files by renaming a uniquely created sibling on the same filesystem. */
export function writeFileAtomicSync(targetPath: string, content: string | Buffer, mode?: number): void {
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd: number | undefined;
  try {
    const effectiveMode = mode ?? (fs.existsSync(targetPath) ? fs.statSync(targetPath).mode & 0o777 : 0o660);
    fd = fs.openSync(tempPath, 'wx', effectiveMode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, targetPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}
