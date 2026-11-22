import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PROJECTS = 64;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REMOTE = /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})$/i;

export interface EnrolledProject {
  id: string;
  name: string;
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

function canonicalRemote(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim()) return;
  const match = REMOTE.exec(value);
  const repo = match?.[2].replace(/\.git$/i, '');
  if (!match || !repo || /^\.+$/.test(repo) || /\.git$/i.test(repo)) return;
  return `https://github.com/${match[1].toLowerCase()}/${repo.toLowerCase()}.git`;
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
    const remote = canonicalRemote(project.remote);
    if (!remote || !validProjectId(project.id) || ids.has(project.id) ||
        typeof project.name !== 'string' || !project.name.trim() || project.name.length > 120 ||
        !validBranch(project.branch) ||
        (project.defaultDoc !== undefined &&
          (!validProjectFile(project.defaultDoc) || !project.defaultDoc.endsWith('.md'))) ||
        Object.keys(project).some((key) => !['id', 'name', 'remote', 'branch', 'defaultDoc'].includes(key))) {
      throw new Error(`Invalid managed project at enrollment index ${index}.`);
    }
    ids.add(project.id);
    return { id: project.id, name: project.name.trim(), remote, branch: project.branch, defaultDoc: project.defaultDoc };
  });
}

/** Returns only GitHub-managed enrolled projects (local entries are validated and skipped). */
export function loadEnrollment(file: string): EnrolledProject[] {
  return loadEnrollmentEntries(file).filter((entry): entry is EnrolledProject => !isLocalProject(entry));
}

export function enrollmentBinding(project: EnrolledProject): string {
  return createHash('sha256').update(JSON.stringify([project.id, project.remote, project.branch])).digest('hex');
}

export function directoriesOverlap(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  };
  return contains(a, b) || contains(b, a);
}
