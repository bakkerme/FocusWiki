import { constants, watch, type Dirent, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { DocTreeEntry, EmbedAssetEntry, ProjectConfig, SearchResultItem } from '../shared/types.js';
import { extractDocumentTitle } from '../shared/markdownCodec.js';
import { getCommentSidecarRelPath } from './commentStore.js';

const KiB = 1024;
const IGNORED_AGENT_DOC_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

export interface ScanLimits {
  entries: number;
  files: number;
  bytes: number;
  depth: number;
}

const PROJECT_LIMITS: ScanLimits = { entries: 4_000, files: 400, bytes: 4 * 1024 * KiB, depth: 16 };
export const BROWSE_LIMITS: ScanLimits = { ...PROJECT_LIMITS, entries: 12_000, files: 1_200, bytes: 12 * 1024 * KiB };
export const SEARCH_LIMITS: ScanLimits = { ...BROWSE_LIMITS, bytes: 16 * 1024 * KiB };

export class ScanBudget {
  incomplete = false;

  constructor(
    private remaining: ScanLimits = { ...PROJECT_LIMITS },
    readonly signal?: AbortSignal,
    private readonly deadline = performance.now() + 2_000,
    private readonly parent?: ScanBudget
  ) {
    this.remaining = { ...remaining };
  }

  child(limits = PROJECT_LIMITS): ScanBudget {
    return new ScanBudget(limits, this.signal, this.deadline, this);
  }

  check(): boolean {
    this.signal?.throwIfAborted();
    if (performance.now() >= this.deadline || (this.parent && !this.parent.check())) {
      this.incomplete = true;
      return false;
    }
    return true;
  }

  take(key: keyof Omit<ScanLimits, 'depth'>, amount = 1): boolean {
    if (!this.check() || this.remaining[key] < amount || (this.parent && !this.parent.take(key, amount))) {
      this.incomplete = true;
      return false;
    }
    this.remaining[key] -= amount;
    return true;
  }

  withinDepth(depth: number): boolean {
    if (depth <= this.remaining.depth) return true;
    this.incomplete = true;
    return false;
  }
}

function skipped(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name.includes('\\');
}

function markdownName(name: string): boolean {
  return !skipped(name) && name.endsWith('.md') && !IGNORED_AGENT_DOC_NAMES.has(name);
}

function expectedSkip(err: unknown): boolean {
  return ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '');
}

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const fdChild = (handle: FileHandle, name: string) => `${fdPath(handle)}/${name}`;

// Linux directory descriptors anchor each lookup, including when a writer
// replaces a previously enumerated path. Docker provides /proc/self/fd.
async function withRoot<T>(root: string, action: (dir: FileHandle) => Promise<T>): Promise<T | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const rootPath = path.resolve(root);
    if (await realpath(rootPath) !== rootPath) return undefined;
    const dir = await open(rootPath, directoryFlags);
    try {
      if (await realpath(fdPath(dir)) !== rootPath) return undefined;
      return await action(dir);
    } finally {
      await dir.close();
    }
  } catch (err) {
    if (expectedSkip(err)) return undefined;
    throw err;
  }
}

async function withChildDirectory<T>(dir: FileHandle, name: string, action: (child: FileHandle) => Promise<T>): Promise<T | undefined> {
  let child: FileHandle;
  try {
    child = await open(fdChild(dir, name), directoryFlags);
  } catch (err) {
    if (expectedSkip(err)) return undefined;
    throw err;
  }
  try {
    return await action(child);
  } finally {
    await child.close();
  }
}

async function eachEntry(
  dir: FileHandle,
  budget: ScanBudget,
  visit: (entry: Dirent) => Promise<boolean | void>
): Promise<void> {
  if (!budget.check()) return;
  const handle = await opendir(fdPath(dir), { bufferSize: 16 });
  try {
    while (budget.check()) {
      const entry = await handle.read();
      if (!entry || !budget.take('entries')) break;
      if (entry.isSymbolicLink() || skipped(entry.name)) continue;
      if (await visit(entry) === false) break;
    }
  } finally {
    await handle.close();
  }
}

async function readFile(
  dir: FileHandle, name: string, budget: ScanBudget, maxBytes: number, requireWhole = false
): Promise<{ stat: Stats; complete: boolean; buffer: Buffer } | undefined> {
  if (!budget.check()) return;
  let file: FileHandle;
  try {
    file = await open(fdChild(dir, name), fileFlags);
  } catch (err) {
    if (expectedSkip(err)) return;
    throw err;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return;
    const length = Math.min(stat.size, maxBytes);
    if ((requireWhole && stat.size > maxBytes) || !budget.take('bytes', length)) {
      return { stat, complete: false, buffer: Buffer.alloc(0) };
    }
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length && budget.check()) {
      const { bytesRead } = await file.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const final = await file.stat();
    const complete = length === stat.size && offset === length && final.size === stat.size && final.mtimeMs === stat.mtimeMs;
    return { stat, complete, buffer: buffer.subarray(0, offset) };
  } finally {
    await file.close();
  }
}

async function walkMarkdown(
  dir: FileHandle, budget: ScanBudget, visit: (dir: FileHandle, name: string, rel: string) => Promise<boolean | void>,
  prefix = '', depth = 0, skipPath = ''
): Promise<boolean> {
  let stopped = false;
  await eachEntry(dir, budget, async (entry) => {
    if (entry.name === 'embeds') return;
    const rel = prefix + entry.name;
    if (entry.isDirectory() && budget.withinDepth(depth + 1)) {
      stopped = (await withChildDirectory(dir, entry.name, (child) => walkMarkdown(child, budget, visit, rel + '/', depth + 1, skipPath))) === false;
    } else if (entry.isFile() && rel !== skipPath && markdownName(entry.name)) {
      stopped = !budget.take('files') || (await visit(dir, entry.name, rel)) === false;
    }
    if (stopped) return false;
  });
  return !stopped;
}

async function visitPreferred(
  dir: FileHandle, rel: string, budget: ScanBudget,
  visit: (dir: FileHandle, name: string, rel: string) => Promise<void>, depth = 0
): Promise<void> {
  const parts = rel.split('/');
  const name = parts[depth];
  if (!name || skipped(name) || name === 'embeds' || !budget.withinDepth(depth) || !budget.take('entries')) return;
  if (depth < parts.length - 1) {
    await withChildDirectory(dir, name, (child) => visitPreferred(child, rel, budget, visit, depth + 1));
  } else if (markdownName(name) && budget.take('files')) {
    await visit(dir, name, rel);
  }
}

export async function scanRepository(project: ProjectConfig, budget = new ScanBudget()) {
  budget.signal?.throwIfAborted();
  const docs: DocTreeEntry[] = [];
  const embeds: EmbedAssetEntry[] = [];
  async function document(dir: FileHandle, name: string, rel: string) {
    const markdown = await readFile(dir, name, budget, 16 * KiB);
    if (!markdown) return;
    const sidecar = await readFile(dir, path.basename(getCommentSidecarRelPath(rel)), budget, 64 * KiB);
    let openComments = 0;
    if (sidecar && !sidecar.complete) budget.incomplete = true;
    if (sidecar?.complete) {
      try {
        const parsed = JSON.parse(sidecar.buffer.toString('utf8'));
        if (Array.isArray(parsed?.threads)) {
          for (const thread of parsed.threads) if (thread?.status === 'open') openComments++;
        }
      } catch { /* Invalid sidecar, as in the document view. */ }
    }
    if (!markdown.complete) budget.incomplete = true;
    docs.push({
      path: rel,
      title: extractDocumentTitle(markdown.buffer.toString('utf8'), rel).slice(0, 256),
      updatedAt: markdown.stat.mtime.toISOString(),
      openComments
    });
  }
  try {
    const found = await withRoot(project.rootPath, async (root) => {
      // Keep the configured landing page available even when discovery is partial.
      await visitPreferred(root, project.defaultDoc, budget, document);
      const embedBudget = budget.child({ entries: 1_000, files: 0, bytes: 0, depth: 2 });
      await withChildDirectory(root, 'embeds', async (embedRoot) => {
        await eachEntry(embedRoot, embedBudget, async (entry) => {
          if (entry.isFile() && entry.name.endsWith('.html')) {
            embeds.push({ src: `embeds/${entry.name}`, name: entry.name.slice(0, -5), directory: 'embeds', files: [entry.name] });
          } else if (entry.isDirectory()) {
            const directory = `embeds/${entry.name}`;
            await withChildDirectory(embedRoot, entry.name, async (child) => {
              const files: string[] = [];
              await eachEntry(child, embedBudget, async (file) => {
                if (file.isFile()) files.push(file.name);
              });
              files.sort();
              const html = files.includes('index.html') ? 'index.html' : files.find((file) => file.endsWith('.html'));
              if (html) embeds.push({ src: `${directory}/${html}`, name: entry.name, directory, files });
            });
          }
        });
      });
      if (embedBudget.incomplete) budget.incomplete = true;
      await walkMarkdown(root, budget, document, '', 0, project.defaultDoc);
      return true;
    });
    if (!found) budget.incomplete = true;
  } catch {
    budget.signal?.throwIfAborted();
    budget.incomplete = true;
  }
  docs.sort((a, b) => Number(b.path === project.defaultDoc) - Number(a.path === project.defaultDoc) ||
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  embeds.sort((a, b) => a.src.localeCompare(b.src));
  return { docs, embeds, ...(budget.incomplete ? { scanIncomplete: true as const } : {}) };
}

export async function searchRepositories(projects: Iterable<ProjectConfig>, needle: string, budget: ScanBudget) {
  const results: SearchResultItem[] = [];
  for (const project of projects) {
    if (!budget.take('entries') || results.length >= 60) break;
    try {
      const found = await withRoot(project.rootPath, async (root) => {
        await walkMarkdown(root, budget, async (dir, name, rel) => {
          const file = await readFile(dir, name, budget, 2 * 1024 * KiB, true);
          if (!file) return;
          if (!file.complete) {
            budget.incomplete = true;
            return;
          }
          const text = file.buffer.toString('utf8');
          let title: string | undefined;
          let start = 0;
          for (let lineNumber = 1; start < text.length; lineNumber++) {
            const newline = text.indexOf('\n', start);
            const end = newline < 0 ? text.length : newline;
            const line = text.slice(start, end);
            start = end + 1;
            if (!line.toLowerCase().includes(needle)) continue;
            title ??= extractDocumentTitle(text.slice(0, 8 * KiB), rel).slice(0, 256);
            if (results.length === 60) {
              budget.incomplete = true;
              return false;
            }
            results.push({ projectId: project.id, projectName: project.name, path: rel, title, line: lineNumber, snippet: line.trim().slice(0, 180) });
          }
        });
        return true;
      });
      if (!found) budget.incomplete = true;
    } catch {
      budget.signal?.throwIfAborted();
      budget.incomplete = true;
    }
    if (results.length === 60) {
      budget.incomplete = true;
      break;
    }
  }
  return { results, ...(budget.incomplete ? { scanIncomplete: true as const } : {}) };
}

export async function listConflictCopies(root: string, docRelPath: string) {
  const prefix = docRelPath.replace(/[^a-zA-Z0-9._-]/g, '__') + '.';
  const budget = new ScanBudget({ entries: 500, files: 100, bytes: 0, depth: 2 });
  const conflicts: string[] = [];
  try {
    const found = await withRoot(root, async (dir) => {
      for (const metadata of ['.focuswiki', '.cairn']) {
        await withChildDirectory(dir, metadata, async (hidden) => {
          await withChildDirectory(hidden, 'conflicts', async (copies) => {
            await eachEntry(copies, budget, async (entry) => {
              if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) return;
              if (!budget.take('files')) return false;
              conflicts.push(`${metadata}/conflicts/${entry.name}`);
            });
          });
        });
      }
      return true;
    });
    if (!found) budget.incomplete = true;
  } catch {
    budget.incomplete = true;
  }
  return { conflicts: conflicts.sort().reverse(), ...(budget.incomplete ? { conflictsIncomplete: true as const } : {}) };
}

/** Register nonrecursive watches directly on verified directory descriptors. */
export async function watchRepositoryDirectories(
  root: string, budget: ScanBudget,
  subscribe: (
    rel: string,
    openWatch: (handler: (event: string, name: string | null) => void) => ReturnType<typeof watch>,
    isCurrent: () => Promise<boolean>
  ) => boolean
): Promise<boolean> {
  async function visit(dir: FileHandle, rel: string, depth: number): Promise<boolean> {
    if (!budget.check()) return false;
    const identity = await dir.stat({ bigint: true });
    if (!subscribe(rel, (handler) => watch(fdPath(dir), { persistent: false }, handler), async () => {
      const current = await repositoryEntry(root, rel);
      return current?.isDirectory() === true && current.dev === identity.dev && current.ino === identity.ino;
    })) return false;
    let complete = true;
    await eachEntry(dir, budget, async (entry) => {
      if (!entry.isDirectory()) return;
      if (!budget.withinDepth(depth + 1)) return;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      if (await withChildDirectory(dir, entry.name, (child) => visit(child, childRel, depth + 1)) === false) {
        complete = false;
        return false;
      }
    });
    return complete;
  }
  return (await withRoot(root, (dir) => visit(dir, '', 0))) === true && !budget.incomplete;
}

export async function repositoryEntry(root: string, rel: string) {
  return withRoot(root, async (dir) => {
    if (!rel) return dir.stat({ bigint: true });
    async function check(parent: FileHandle, names: string[], depth: number): Promise<import('node:fs').BigIntStats | undefined> {
      const name = names[depth];
      if (!name || skipped(name)) return;
      if (depth === names.length - 1) {
        try { return await lstat(fdChild(parent, name), { bigint: true }); }
        catch (err) { if (expectedSkip(err)) return; throw err; }
      }
      return withChildDirectory(parent, name, (child) => check(child, names, depth + 1));
    }
    return check(dir, rel.split('/'), 0);
  });
}

/** Read a Git review input without following any working-tree symlinks. */
export async function readRepositoryFile(root: string, rel: string, maxBytes: number, signal: AbortSignal) {
  const names = rel.split('/');
  if (names.length > 64 || names.some((name) => !name || name === '.' || name === '..' || name.includes('\\'))) return;
  const budget = new ScanBudget({ bytes: maxBytes, entries: 0, files: 0, depth: 0 }, signal, Infinity);
  async function read(parent: FileHandle, depth: number): Promise<{ buffer: Buffer; complete: boolean } | undefined> {
    signal.throwIfAborted();
    const name = names[depth];
    if (depth < names.length - 1) return withChildDirectory(parent, name, (child) => read(child, depth + 1));
    const contents = await readFile(parent, name, budget, maxBytes, true);
    if (contents) return { buffer: contents.buffer, complete: contents.complete };
  }
  return withRoot(root, (dir) => read(dir, 0));
}
