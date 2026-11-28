import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PROJECTS = 64;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GITHUB_REMOTE = /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})$/i;
const FORGEJO_PATH = /^\/([a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?)\/([a-z0-9_.-]{1,100})$/i;

export type GitProvider = 'github' | 'forgejo';

export interface EnrolledProject {
  id: string;
  name: string;
  provider?: GitProvider;
  remote: string;
  branch: string;
  defaultDoc?: string;
}

export interface LocalEnrolledProject {
  id: string;
  name: string;
  local: true;
  defaultDoc?: string;
}

export type EnrollmentEntry = EnrolledProject | LocalEnrolledProject;

export function isLocalProject(entry: EnrollmentEntry): entry is LocalEnrolledProject {
  return 'local' in entry && entry.local === true;
}

export function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && PROJECT_ID.test(value) && !value.endsWith('.');
}

const CHECKOUT_FORBIDDEN_SEGMENT = /^(?:\.git|\.focuswiki|\.cairn|node_modules)$/i;
const PROJECT_FORBIDDEN_SEGMENT = /^(?:\.git|\.focuswiki|\.cairn|node_modules|\.env(?:\..*)?)$/i;

function hasSafeRelativeSegments(value: unknown, forbidden: RegExp): value is string {
  return typeof value === 'string' && value.length <= 1024 &&
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..' && !forbidden.test(part));
}

export function validProjectFile(value: unknown): value is string {
  return hasSafeRelativeSegments(value, PROJECT_FORBIDDEN_SEGMENT);
}

/** Validates tracked files during initial checkout; .env* templates stay checked out but remain blocked from web/proposal APIs. */
export function validCheckoutFile(value: unknown): value is string {
  return hasSafeRelativeSegments(value, CHECKOUT_FORBIDDEN_SEGMENT);
}

export function normalizeHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\s\\\x00-\x1f\x7f]/.test(value)) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/' || !parsed.hostname) {
    return undefined;
  }
  return parsed.origin.toLowerCase();
}

export function projectProvider(project: { provider?: GitProvider; remote: string }): GitProvider {
  if (project.provider === 'forgejo') return 'forgejo';
  if (project.provider === 'github') return 'github';
  return project.remote.startsWith('https://github.com/') ? 'github' : 'forgejo';
}

function canonicalRemote(value: unknown, provider: GitProvider): string | undefined {
  if (typeof value !== 'string' || value !== value.trim()) return;
  if (provider === 'github') {
    const match = GITHUB_REMOTE.exec(value);
    const repo = match?.[2].replace(/\.git$/i, '');
    if (!match || !repo || /^\.+$/.test(repo) || /\.git$/i.test(repo)) return;
    return `https://github.com/${match[1].toLowerCase()}/${repo.toLowerCase()}.git`;
  }
  if (/[%\\\s\x00-\x1f\x7f]/.test(value)) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !parsed.hostname || parsed.hostname.toLowerCase() === 'github.com') {
    return;
  }
  const match = FORGEJO_PATH.exec(parsed.pathname);
  const owner = match?.[1];
  const repo = match?.[2].replace(/\.git$/i, '');
  if (!owner || !repo || /^\.+$/.test(owner) || /^\.+$/.test(repo) || /\.git$/i.test(repo)) return;
  return `${parsed.origin.toLowerCase()}/${owner.toLowerCase()}/${repo.toLowerCase()}.git`;
}

function validBranch(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value) &&
    !value.includes('..') && !value.endsWith('.') && value !== 'HEAD' &&
    value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Both processes read an operator-managed file. Filesystem paths and credentials are not enrollment fields. */
export function loadEnrollmentEntries(file: string): EnrollmentEntry[] {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let decoded: unknown;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid enrollment file.');
    const bytes = Buffer.alloc(128 * 1024 + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count === bytes.length) throw new Error('Invalid enrollment file.');
    decoded = JSON.parse(bytes.toString('utf8', 0, count));
  } finally {
    fs.closeSync(fd);
  }

  const projects = (decoded as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS) {
    throw new Error('Enrollment must contain a bounded projects list.');
  }

  const ids = new Set<string>();
  return projects.map((raw, index): EnrollmentEntry => {
    const project = raw as Partial<EnrolledProject & LocalEnrolledProject> | null;
    if (!project || typeof project !== 'object') {
      throw new Error(`Invalid managed project at enrollment index ${index}.`);
    }
    if (project.local === true) {
      if (!validProjectId(project.id) || ids.has(project.id) ||
          typeof project.name !== 'string' || !project.name.trim() || project.name.length > 120 ||
          (project.defaultDoc !== undefined &&
            (!validProjectFile(project.defaultDoc) || !project.defaultDoc.endsWith('.md'))) ||
          Object.keys(project).some((key) => !['id', 'name', 'local', 'defaultDoc'].includes(key))) {
        throw new Error(`Invalid local project at enrollment index ${index}.`);
      }
      ids.add(project.id);
      return { id: project.id, name: project.name.trim(), local: true, defaultDoc: project.defaultDoc };
    }
    const rawProvider = project.provider;
    if (rawProvider !== undefined && rawProvider !== 'github' && rawProvider !== 'forgejo') {
      throw new Error(`Invalid managed project at enrollment index ${index}.`);
    }
    const provider: GitProvider = rawProvider ?? 'github';
    const remote = canonicalRemote(project.remote, provider);
    if (!remote || !validProjectId(project.id) || ids.has(project.id) ||
        typeof project.name !== 'string' || !project.name.trim() || project.name.length > 120 ||
        !validBranch(project.branch) ||
        (project.defaultDoc !== undefined &&
          (!validProjectFile(project.defaultDoc) || !project.defaultDoc.endsWith('.md'))) ||
        Object.keys(project).some((key) => !['id', 'name', 'provider', 'remote', 'branch', 'defaultDoc'].includes(key))) {
      throw new Error(`Invalid managed project at enrollment index ${index}.`);
    }
    ids.add(project.id);
    return provider === 'forgejo'
      ? { id: project.id, name: project.name.trim(), provider: 'forgejo', remote, branch: project.branch, defaultDoc: project.defaultDoc }
      : { id: project.id, name: project.name.trim(), remote, branch: project.branch, defaultDoc: project.defaultDoc };
  });
}

/** Returns only Git-managed enrolled projects (local entries are validated and skipped). */
export function loadEnrollment(file: string): EnrolledProject[] {
  return loadEnrollmentEntries(file).filter((entry): entry is EnrolledProject => !isLocalProject(entry));
}

export function enrollmentBinding(project: EnrolledProject): string {
  const fields = project.provider === 'forgejo'
    ? [project.id, project.remote, project.branch, 'forgejo']
    : [project.id, project.remote, project.branch];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function directoriesOverlap(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  };
  return contains(a, b) || contains(b, a);
}

export const DEFAULT_ENROLLMENT_POLL_MS = 2_000;

export interface EnrollmentWatchHandle {
  reloadNow(): Promise<boolean>;
  close(): void;
}

export interface WatchEnrollmentOptions {
  initialEntries?: EnrollmentEntry[];
  pollIntervalMs?: number;
  onReload: (entries: EnrollmentEntry[]) => void | Promise<void>;
  onError?: (reason: string) => void;
}

function statSignature(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Polls an operator-managed enrollment.json file and invokes onReload only when
 * the validated enrollment entries change. Invalid edits keep the previous config active.
 */
export function watchEnrollmentFile(file: string, options: WatchEnrollmentOptions): EnrollmentWatchHandle {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ENROLLMENT_POLL_MS;
  let lastStat = statSignature(file);
  let lastFingerprint = options.initialEntries ? JSON.stringify(options.initialEntries) : undefined;
  let lastError: string | undefined;
  let closed = false;
  let activeCheck: Promise<boolean> | undefined;

  const check = (force = false): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    if (activeCheck) return activeCheck;
    const run = (async () => {
      try {
        const currentStat = statSignature(file);
        if (!force && !lastError && currentStat !== null && currentStat === lastStat) {
          return false;
        }
        const entries = loadEnrollmentEntries(file);
        const fingerprint = JSON.stringify(entries);
        if (fingerprint === lastFingerprint) {
          lastStat = currentStat;
          lastError = undefined;
          return false;
        }
        if (closed) return false;
        await options.onReload(entries);
        lastStat = currentStat;
        lastFingerprint = fingerprint;
        lastError = undefined;
        return true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown error.';
        if (reason !== lastError) {
          lastError = reason;
          options.onError?.(reason);
        }
        return false;
      }
    })();
    activeCheck = run;
    void run.finally(() => {
      if (activeCheck === run) activeCheck = undefined;
    });
    return run;
  };

  let timer: NodeJS.Timeout | undefined;
  if (pollIntervalMs > 0) {
    timer = setInterval(() => {
      void check(false);
    }, pollIntervalMs);
    timer.unref();
  }

  return {
    reloadNow: () => check(true),
    close: () => {
      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  };
}
