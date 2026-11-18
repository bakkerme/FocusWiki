import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCodeFileReview,
  buildCommentSidecarReview,
  buildMarkdownFileReview,
  deriveHumanLabelForChangedPath,
  type ChangeFileSummary,
  type GitChangeReviewPayload
} from '../shared/changeReview.js';
import { withKeyLock } from './fileLock.js';
import { buildGitEnv } from './gitService.js';

export interface ProposalContext {
  projectId: string;
  workTree: string;
  gitDir: string;
  remote: string;
  branch: string;
}

export interface PublishProposalInput {
  reviewId: string;
  message: string;
  paths: string[];
}

type TokenMode = 'read' | 'write';
type FileMode = '100644' | '100755';
type Fingerprint = { mode: FileMode; digest: string };
type ReviewedPath = { path: string; after: Fingerprint | null };
type Review = { projectId: string; remote: string; branch: string; workTree: string; base: string; baseBranch: string; files: ReviewedPath[] };
type Prepared = { paths: string[]; messageDigest: string; baseBranch: string; sha: string };
type Proposal = { url: string; sha: string };
type BlobEntry = { mode: string; sha: string; size: number };
type FileBytes = { mode: FileMode; bytes: Buffer };
type Capture = { path: string; before: FileBytes | null; after: FileBytes | null };

const MAX_FILE_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_PATHS = 2500;
const MAX_REVIEW_FILES = 32;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_API_BYTES = 1024 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const enforcesManagedBase = true;

class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalError';
  }
}

function parseRemote(remote: string) {
  const match = /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]{1,100})$/i.exec(remote);
  const owner = match?.[1];
  const name = match?.[2].replace(/\.git$/i, '');
  if (!owner || !name || name === '.' || name === '..' || name.toLowerCase().endsWith('.git') || remote.trim() !== remote ||
      !remote.startsWith('https://github.com/')) {
    throw new ProposalError('Expected an enrolled https://github.com/OWNER/REPO remote.');
  }
  return {
    owner, name,
    slug: `${owner}/${name}`,
    api: `/repos/${owner}/${name}`,
    url: `https://github.com/${owner}/${name}.git`
  };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'));
}

function validBranch(branch: unknown): branch is string {
  return typeof branch === 'string' && branch.length <= 200 && branch.trim() === branch &&
    /^[a-zA-Z0-9_-][a-zA-Z0-9._/-]*$/.test(branch) && !branch.includes('..') &&
    branch.split('/').every((segment) => segment && !segment.startsWith('.') &&
      !segment.endsWith('.') && !segment.endsWith('.lock'));
}

function enrollment(ctx: ProposalContext) {
  const repo = parseRemote(ctx.remote);
  if (!ctx.projectId || !validBranch(ctx.branch) || !ctx.branch.startsWith('focuswiki/') ||
      !path.isAbsolute(ctx.gitDir) || !path.isAbsolute(ctx.workTree)) {
    throw new ProposalError('Invalid worker enrollment or proposal branch.');
  }
  const workTree = fs.realpathSync(ctx.workTree);
  const gitDir = fs.realpathSync(ctx.gitDir);
  if (inside(workTree, gitDir) || inside(gitDir, workTree)) {
    throw new ProposalError('Git metadata and the worktree must reside in separate directories.');
  }
  return { ...ctx, workTree, gitDir, remote: repo.url, repo };
}

type Enrollment = ReturnType<typeof enrollment>;

async function github<T>(endpoint: string, token: string, body?: object, optional = false): Promise<T | null> {
  try {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (optional && response.status === 404) return null;
      throw new ProposalError(`GitHub request failed (HTTP ${response.status}).`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProposalError('GitHub returned an empty response.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_API_BYTES) {
        await reader.cancel();
        throw new ProposalError('GitHub response exceeded the size limit.');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch (error) {
    if (error instanceof ProposalError) throw error;
    throw new ProposalError('GitHub request could not be completed.');
  }
}

function appJwt(ctx: Enrollment): { jwt: string; installation: string } {
  const { FOCUSWIKI_GITHUB_APP_ID: app, FOCUSWIKI_GITHUB_INSTALLATION_ID: installation,
    FOCUSWIKI_GITHUB_APP_KEY_FILE: keyFile } = process.env;
  if (!app || !installation || app.trim() !== app || installation.trim() !== installation ||
      !/^\d{1,20}$/.test(app) || !/^\d{1,20}$/.test(installation) ||
      !keyFile || !path.isAbsolute(keyFile)) {
    throw new ProposalError('GitHub App configuration is incomplete.');
  }
  try {
    const resolvedKey = fs.realpathSync(keyFile);
    if (inside(ctx.workTree, resolvedKey) || inside(ctx.gitDir, resolvedKey)) throw new Error();
    const descriptor = fs.openSync(keyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024) throw new Error();
      const key = createPrivateKey(readBounded(descriptor, 16 * 1024));
      if (key.asymmetricKeyType !== 'rsa') throw new Error();
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const data = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: app, iat: now - 60, exp: now + 540 })}`;
      return { jwt: `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`, installation };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    throw new ProposalError('GitHub App key could not be read from the worker secret file.');
  }
}

async function issueToken(ctx: Enrollment, mode: TokenMode): Promise<string> {
  if (mode !== 'read' && mode !== 'write') throw new ProposalError('Invalid token mode.');
  const { jwt, installation } = appJwt(ctx);
  const installed = await github<{ id?: number }>(`${ctx.repo.api}/installation`, jwt);
  if (String(installed?.id) !== installation) {
    throw new ProposalError('The enrolled repository does not belong to the configured GitHub App installation.');
  }
  const permissions: Record<string, string> = mode === 'write'
    ? { contents: 'write', pull_requests: 'write' }
    : { contents: 'read' };
  const grant = await github<{
    token?: string;
    permissions?: Record<string, string>;
    repositories?: Array<{ full_name?: string }>;
  }>(`/app/installations/${installation}/access_tokens`, jwt, {
    repositories: [ctx.repo.name],
    permissions
  });
  if (!grant?.token || grant.token.trim() !== grant.token || !/^[A-Za-z0-9_.-]{1,1024}$/.test(grant.token) || !grant.permissions ||
      Object.entries(permissions).some(([key, value]) => grant.permissions?.[key] !== value) ||
      Object.entries(grant.permissions).some(([key, value]) => key === 'metadata' ? value !== 'read' : permissions[key] !== value) ||
      (grant.repositories !== undefined && (grant.repositories.length !== 1 ||
        grant.repositories[0]?.full_name?.toLowerCase() !== ctx.repo.slug.toLowerCase()))) {
    throw new ProposalError('GitHub returned a token with unexpected scope.');
  }
  return grant.token;
}

export async function getRepoToken(ctx: ProposalContext, mode: TokenMode): Promise<string> {
  return issueToken(enrollment(ctx), mode);
}

type GitOptions = { input?: Buffer | string; env?: NodeJS.ProcessEnv; allowDiff?: boolean; push?: boolean };

function git(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
  const env = {
    ...buildGitEnv(),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: options.push ? 'https' : '',
    ...options.env
  };
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd, encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: options.push ? 60_000 : 15_000, env
    }, (error, stdout) => {
      if (!error || (options.allowDiff && error.code === 1)) resolve(stdout);
      else reject(new ProposalError(options.push ? 'Proposal push failed.' : 'Proposal Git operation failed.'));
    });
    child.stdin?.on('error', () => { /* The Git exit status handles a closed pipe. */ });
    child.stdin?.end(options.input);
  });
}

function localGit(ctx: Enrollment, args: string[], options?: GitOptions): Promise<Buffer> {
  return git(ctx.gitDir, [
    `--git-dir=${ctx.gitDir}`, `--work-tree=${ctx.workTree}`, '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all', '-c', 'user.useConfigOnly=true', '-c', 'commit.gpgSign=false',
    ...args
  ], options);
}

async function localHead(ctx: Enrollment): Promise<string> {
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer']
    .some((entry) => fs.existsSync(path.join(ctx.gitDir, entry)))) {
    throw new ProposalError('Finish the existing Git operation before preparing a proposal.');
  }
  const head = (await localGit(ctx, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim();
  if (!SHA.test(head)) throw new ProposalError('The checkout needs a committed base.');
  return head;
}

function splitPaths(output: Buffer): string[] {
  try {
    const paths = decoder.decode(output).split('\0');
    paths.pop();
    if (paths.length <= MAX_PATHS) return paths;
  } catch { /* Invalid UTF-8 cannot be reviewed unambiguously. */ }
  throw new ProposalError('Repository path listing is invalid or exceeds the review limit.');
}

function pathParts(relative: string): string[] {
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new ProposalError('Invalid repository path.');
  }
  return parts;
}

function reviewablePath(relative: string): boolean {
  const parts = pathParts(relative);
  const protectedName = /^(?:node_modules|id_(?:rsa|dsa|ed25519|ecdsa)(?:\..*)?|jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml)$/i;
  return Buffer.byteLength(relative) <= 512 && parts.every((part) =>
    !part.startsWith('.') && !/[\p{Cc}\p{Cf}\\:"<>|?*]|[ .]$/u.test(part) && !protectedName.test(part) &&
    !/(?:^|[._-])(?:secrets?|credentials?)(?:[._-]|$)/i.test(part) &&
    !/\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/i.test(part));
}

function regularMode(mode: string): mode is FileMode {
  return mode === '100644' || mode === '100755';
}

async function baseTree(ctx: Enrollment, base: string): Promise<Map<string, BlobEntry>> {
  const entries = splitPaths(await localGit(ctx, ['ls-tree', '-rlz', base]));
  return new Map(entries.map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, , sha, size] = entry.slice(0, tab).split(/ +/);
    if (tab === -1 || !SHA.test(sha)) throw new ProposalError('Invalid base tree entry.');
    return [entry.slice(tab + 1), { mode, sha, size: Number(size) }];
  }));
}

async function indexPaths(ctx: Enrollment): Promise<Set<string>> {
  const index = splitPaths(await localGit(ctx, ['ls-files', '--stage', '-z']));
  return new Set(index.map((entry) => {
    const tab = entry.indexOf('\t');
    if (tab === -1 || !entry.slice(0, tab).endsWith(' 0')) {
      throw new ProposalError('Resolve the existing Git index conflict before preparing a proposal.');
    }
    return entry.slice(tab + 1);
  }));
}

// Linux O_PATH pins each inode without opening devices or following symlinks.
const O_PATH = 0o10000000;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;

function readBounded(fd: number, max: number): Buffer {
  const buffer = Buffer.allocUnsafe(max + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) return buffer.subarray(0, length);
    length += count;
  }
  throw new ProposalError('File exceeded the byte limit while being read.');
}

type WorkingFile =
  | { kind: 'absent' }
  | { kind: 'excluded'; reason: 'parent' | 'symlink' | 'directory' | 'special' | 'hardlink' | 'protected' }
  | { kind: 'excluded'; reason: 'size'; stat: fs.Stats }
  | { kind: 'file'; stat: fs.Stats; bytes?: Buffer };

const inode = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;

function inspectFile(
  root: number, relative: string, budget?: { remaining: number }, protectedInodes?: ReadonlySet<string>
): WorkingFile {
  const parts = pathParts(relative);
  let parent = root;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = fs.openSync(`${fdPath(parent)}/${part}`, O_PATH | fs.constants.O_NOFOLLOW);
      if (parent !== root) fs.closeSync(parent);
      parent = next;
      if (!fs.fstatSync(parent).isDirectory()) return { kind: 'excluded', reason: 'parent' };
    }
    const leaf = fs.openSync(`${fdPath(parent)}/${parts.at(-1)}`, O_PATH | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(leaf);
      if (!stat.isFile()) return {
        kind: 'excluded',
        reason: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'special'
      };
      if (stat.nlink !== 1) return { kind: 'excluded', reason: 'hardlink' };
      if (protectedInodes?.has(inode(stat))) return { kind: 'excluded', reason: 'protected' };
      if (stat.size > MAX_FILE_BYTES) return { kind: 'excluded', reason: 'size', stat };
      if (!budget) return { kind: 'file', stat };
      if (stat.size > budget.remaining) throw new ProposalError('Worktree exceeded the review scan limit.');
      const reader = fs.openSync(fdPath(leaf), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const bytes = readBounded(reader, stat.size);
        const after = fs.fstatSync(reader);
        if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs || after.nlink !== stat.nlink || after.mode !== stat.mode) {
          throw new ProposalError('A worktree file changed during capture. Run a new review.');
        }
        budget.remaining -= bytes.length;
        return { kind: 'file', stat, bytes };
      } finally {
        fs.closeSync(reader);
      }
    } finally {
      fs.closeSync(leaf);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    if (error instanceof ProposalError) throw error;
    throw new ProposalError('A repository path could not be inspected safely.');
  } finally {
    if (parent !== root) fs.closeSync(parent);
  }
}

function protectedSourcePresent(entry: BlobEntry, file: WorkingFile): boolean {
  if (regularMode(entry.mode)) {
    return file.kind === 'file' || (file.kind === 'excluded' && file.reason === 'size');
  }
  // A protected symlink/submodule can remain at its original path. Never follow it.
  return file.kind === 'excluded' && file.reason === (entry.mode === '120000' ? 'symlink' : 'directory');
}

function gitBlobId(bytes: Buffer, shaLength: number): string {
  return createHash(shaLength === 40 ? 'sha1' : 'sha256')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function secretLike(text: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{15,})\b/i.test(text) ||
    /(?:https?:\/\/[^\s/@:]+:[^\s/@]+@|\b(?:password|passwd|api[_-]?key|(?:access|auth|refresh)[_-]?token|client[_-]?secret|aws_secret_access_key)\b["']?\s*[:=]\s*["']?[^\s"'#]{8,})/i.test(text);
}

function reviewText(bytes: Buffer): string | null {
  try {
    const text = decoder.decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || secretLike(text) ? null : text;
  } catch {
    return null;
  }
}

async function capture(
  ctx: Enrollment, base: string, selected?: readonly ReviewedPath[]
): Promise<{ files: Capture[]; excluded: number }> {
  const tree = await baseTree(ctx, base);
  const index = await indexPaths(ctx);
  const root = fs.openSync(ctx.workTree, O_PATH | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    // Rename similarity requires reading blobs before the source can be approved. Treat
    // moves as delete/add, and quarantine changes when a protected source disappears.
    const protectedInodes = new Set<string>();
    const protectedPaths: Array<[string, BlobEntry]> = [];
    for (const [relative, entry] of tree) {
      if (reviewablePath(relative) && regularMode(entry.mode) && entry.size <= MAX_FILE_BYTES) continue;
      const file = inspectFile(root, relative);
      if (!index.has(relative) || !protectedSourcePresent(entry, file)) {
        throw new ProposalError('A protected base path has moved, changed type or been removed.');
      }
      protectedPaths.push([relative, entry]);
      if ('stat' in file) protectedInodes.add(inode(file.stat));
    }
    const paths = selected
      ? selected.map((file) => file.path)
      : [...new Set([...tree.keys(), ...index, ...splitPaths(await localGit(ctx, ['ls-files', '--others', '--exclude-standard', '-z']))])];
    if (paths.length > MAX_PATHS) throw new ProposalError('Repository exceeds the review path limit.');

    const files: Capture[] = [];
    const budget = { remaining: MAX_SCAN_BYTES };
    let excluded = 0;
    for (const relative of paths.sort()) {
      const entry = tree.get(relative);
      if (!reviewablePath(relative) || (entry && (!regularMode(entry.mode) || entry.size > MAX_FILE_BYTES))) {
        excluded++;
        continue;
      }
      const working = inspectFile(root, relative, budget, protectedInodes);
      if (working.kind === 'excluded') {
        excluded++;
        continue;
      }
      let after: FileBytes | null = null;
      if (working.kind === 'file') {
        const bytes = working.bytes!;
        const text = reviewText(bytes);
        if (text === null) {
          excluded++;
          continue;
        }
        after = { mode: working.stat.mode & 0o100 ? '100755' : '100644', bytes };
        if (entry?.mode === after.mode && gitBlobId(bytes, base.length) === entry.sha) continue;
      } else if (!entry) {
        continue;
      }

      let before: FileBytes | null = null;
      if (entry && regularMode(entry.mode)) {
        if (entry.size > budget.remaining) throw new ProposalError('Base tree exceeded the review scan limit.');
        const bytes = await localGit(ctx, ['cat-file', 'blob', entry.sha]);
        if (bytes.length !== entry.size) throw new ProposalError('Base blob size does not match its tree entry.');
        budget.remaining -= bytes.length;
        if (reviewText(bytes) === null) {
          // A move from a content-sensitive source can be disguised as a normal addition.
          // Quarantine the review before returning or writing any captured changes.
          throw new ProposalError('A changed base path contains protected content.');
        }
        before = { mode: entry.mode, bytes };
      }
      files.push({ path: relative, before, after });
      if (files.length > MAX_REVIEW_FILES) throw new ProposalError('Too many changed files for one review.');
    }
    if (protectedPaths.some(([relative, entry]) => !protectedSourcePresent(entry, inspectFile(root, relative)))) {
      throw new ProposalError('A protected base path changed during capture. Run a new review.');
    }
    if (await localHead(ctx) !== base) throw new ProposalError('The local base changed. Run a new review.');
    return { files, excluded };
  } finally {
    fs.closeSync(root);
  }
}

function checkSelection(files: Capture[], selection: ReviewedPath[]) {
  if (JSON.stringify(files.map(fingerprint)) !== JSON.stringify(selection)) {
    throw new ProposalError('The reviewed paths have changed. Run a new review.');
  }
}

function fingerprint(file: Capture): ReviewedPath {
  return { path: file.path, after: file.after && { mode: file.after.mode, digest: digest(file.after.bytes) } };
}

function stateDirectory(ctx: Enrollment): string {
  const directory = path.join(ctx.gitDir, 'focuswiki-proposals');
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    syncDirectory(ctx.gitDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!fs.lstatSync(directory).isDirectory()) throw new ProposalError('Invalid worker proposal state directory.');
  return directory;
}

function syncDirectory(directory: string) {
  const fd = fs.openSync(directory, fs.constants.O_DIRECTORY | fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function load<T>(directory: string, name: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ProposalError('Worker proposal state could not be read.');
  }
}

// Publish immutable state atomically. A competing worker can only use the winning record.
function record<T>(directory: string, name: string, value: T): T {
  const destination = path.join(directory, name);
  const temporary = path.join(directory, `state-${randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    syncDirectory(directory);
    return load<T>(directory, name)!;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function rawPatch(directory: string, file: Capture): Promise<string> {
  // No worktree files ever reach Git diff. The two operands are reviewed byte buffers.
  const { before, after } = file;
  if (before) fs.writeFileSync(path.join(directory, 'before'), before.bytes, { mode: 0o600 });
  if (after) fs.writeFileSync(path.join(directory, 'after'), after.bytes, { mode: 0o600 });
  const output = await git(directory, [
    'diff', '--no-index', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '--',
    before ? 'before' : '/dev/null', after ? 'after' : '/dev/null'
  ], { allowDiff: true });
  const patch = decoder.decode(output);
  const hunks = patch.indexOf('\n@@ ');
  const mode = before?.mode === after?.mode ? '' : [
    before ? `old mode ${before.mode}\n` : '',
    after ? `new mode ${after.mode}\n` : ''
  ].join('');
  return `diff --git a/${file.path} b/${file.path}\n${mode}` +
    (hunks < 0 ? '' : `--- ${before ? `a/${file.path}` : '/dev/null'}\n+++ ${after ? `b/${file.path}` : '/dev/null'}${patch.slice(hunks)}`);
}

function fileSummary(file: Capture, raw: string): ChangeFileSummary {
  const before = file.before ? decoder.decode(file.before.bytes) : null;
  const after = file.after ? decoder.decode(file.after.bytes) : null;
  const category = file.path.endsWith('.md') ? 'markdown' : file.path.endsWith('.comments.json') ? 'comments' : 'code';
  const status = !file.before ? 'added' : !file.after ? 'deleted' : 'modified';
  const concise = (before?.split('\n').length ?? 0) <= 800 && (after?.split('\n').length ?? 0) <= 800;
  const markdownReview = category === 'markdown' && concise ? buildMarkdownFileReview(before, after) : undefined;
  const commentReview = category === 'comments' && concise ? buildCommentSidecarReview(before, after) : undefined;
  return {
    path: file.path, status, category,
    humanTitle: deriveHumanLabelForChangedPath(file.path, concise ? before : null, concise ? after : null),
    formattingOnly: Boolean(markdownReview && file.before?.mode === file.after?.mode &&
      !markdownReview.substantiveCount && markdownReview.formattingOnlyCount),
    summaryLabel: status === 'added' ? 'Added file' : status === 'deleted' ? 'Deleted file' : 'Modified file',
    isBinary: false, truncated: false,
    beforeBytes: file.before?.bytes.length ?? 0,
    afterBytes: file.after?.bytes.length ?? 0,
    rawPatch: raw, markdownReview, commentReview,
    codeReview: markdownReview || (commentReview && !commentReview.parseError)
      ? undefined : buildCodeFileReview(before, after, path.extname(file.path).slice(1) || 'text')
  };
}

export async function reviewProposal(ctx: ProposalContext): Promise<GitChangeReviewPayload & { reviewId: string }> {
  const enrolled = enrollment(ctx);
  const baseBranch = await managedBaseBranch(enrolled);
  const base = await localHead(enrolled);
  const { files, excluded } = await capture(enrolled, base);
  const directory = stateDirectory(enrolled);
  const scratch = fs.mkdtempSync(path.join(directory, 'diff-'));
  const summaries: ChangeFileSummary[] = [];
  try {
    let diffBytes = 0;
    for (const file of files) {
      const patch = await rawPatch(scratch, file);
      diffBytes += Buffer.byteLength(patch) + 1;
      if (diffBytes > MAX_DIFF_BYTES) throw new ProposalError('Proposal diff exceeds the review limit.');
      summaries.push(fileSummary(file, patch));
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const reviewId = randomUUID();
  const review: Review = {
    projectId: enrolled.projectId, remote: enrolled.remote, branch: enrolled.branch, workTree: enrolled.workTree,
    base, baseBranch, files: files.map(fingerprint)
  };
  record(directory, `${reviewId}.review`, review);
  return {
    reviewId, snapshotDigest: digest(JSON.stringify(review)),
    status: {
      branch: enrolled.branch, headSha: base, headSubject: '', isClean: !files.length,
      remoteName: null, remoteUrl: enrolled.remote,
      changedFiles: summaries.map(({ path, status }) => ({ path, status }))
    },
    commitScopeNote: 'Publishing uses only selected paths from this review.' +
      (excluded ? ' Protected, unsupported or oversized paths are outside the review.' : ''),
    diff: summaries.map((file) => file.rawPatch).join('\n'),
    files: summaries
  };
}

async function remoteTip(ctx: Enrollment, token: string, branch: string, optional = false): Promise<string | null> {
  const suffix = branch.split('/').map(encodeURIComponent).join('/');
  const ref = await github<{ ref?: string; object?: { sha?: string; type?: string } }>(
    `${ctx.repo.api}/git/ref/heads/${suffix}`, token, undefined, optional
  );
  if (ref === null && optional) return null;
  if (ref?.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit' || !SHA.test(ref.object.sha ?? '')) {
    throw new ProposalError('GitHub returned an unexpected branch ref.');
  }
  return ref.object.sha!;
}

async function managedBaseBranch(ctx: Enrollment): Promise<string> {
  const ref = (await localGit(ctx, ['symbolic-ref', 'HEAD'])).toString().trim();
  const branch = ref.slice('refs/heads/'.length);
  if (!ref.startsWith('refs/heads/') || !validBranch(branch) || branch.startsWith('focuswiki/')) {
    throw new ProposalError('Invalid managed base branch.');
  }
  return branch;
}

async function verifyRemoteBase(ctx: Enrollment, token: string, base: string, expectedBranch: string): Promise<string> {
  const branch = await managedBaseBranch(ctx);
  if (branch !== expectedBranch || await remoteTip(ctx, token, branch) !== base) {
    throw new ProposalError('The enrolled repository base changed. Fetch the new base and run a new review.');
  }
  return branch;
}

async function prepareCommit(ctx: Enrollment, directory: string, base: string, files: Capture[], message: string): Promise<string> {
  const temporary = fs.mkdtempSync(path.join(directory, 'index-'));
  const env = { GIT_INDEX_FILE: path.join(temporary, 'index') };
  try {
    await localGit(ctx, ['read-tree', base], { env });
    const updates: string[] = [];
    // Deletions first also support changing a file into a directory (or the reverse).
    for (const file of files) {
      if (!file.after) updates.push(`0 ${'0'.repeat(base.length)}\t${file.path}\0`);
    }
    for (const file of files) {
      if (!file.after) continue;
      const sha = (await localGit(ctx, ['hash-object', '-w', '--no-filters', '--stdin'], { input: file.after.bytes })).toString().trim();
      if (sha !== gitBlobId(file.after.bytes, base.length)) throw new ProposalError('Git did not store the reviewed bytes.');
      updates.push(`${file.after.mode} ${sha}\t${file.path}\0`);
    }
    await localGit(ctx, ['update-index', '-z', '--index-info'], { env, input: updates.join('') });
    const tree = (await localGit(ctx, ['write-tree'], { env })).toString().trim();
    if (!SHA.test(tree)) throw new ProposalError('Git did not return a proposal tree.');
    const changed = splitPaths(await localGit(ctx, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', base, tree]));
    if (JSON.stringify(changed.sort()) !== JSON.stringify(files.map((file) => file.path))) {
      throw new ProposalError('The proposal tree would change paths outside the approval.');
    }
    const sha = (await localGit(ctx, ['commit-tree', tree, '-p', base, '-F', '-'], { input: message })).toString().trim();
    if (!SHA.test(sha)) throw new ProposalError('Git did not return a proposal commit.');
    return sha;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function pinCommit(ctx: Enrollment, reviewId: string, sha: string): Promise<void> {
  // Comparing with the same SHA on retry is safe. A different existing ref is an error.
  const ref = `refs/focuswiki/proposals/${reviewId}`;
  const existing = (await localGit(ctx, ['for-each-ref', '--format=%(objectname)', ref])).toString().trim();
  if (existing === sha) return;
  try {
    await localGit(ctx, ['update-ref', ref, sha, '0'.repeat(sha.length)]);
  } catch (error) {
    if ((await localGit(ctx, ['for-each-ref', '--format=%(objectname)', ref])).toString().trim() !== sha) throw error;
  }
}

async function pushProposal(ctx: Enrollment, directory: string, sha: string, token: string): Promise<void> {
  const transport = fs.mkdtempSync(path.join(directory, 'transport-'));
  try {
    await git(transport, ['init', '--bare', '--template=', `--object-format=${sha.length === 40 ? 'sha1' : 'sha256'}`, '.']);
    const askpass = path.join(transport, 'askpass');
    const hooks = path.join(transport, 'hooks');
    fs.mkdirSync(hooks, { mode: 0o700 });
    fs.writeFileSync(askpass, [
      '#!/bin/sh',
      'case "$1" in',
      '  "Username for "*) printf "%s\\n" x-access-token ;;',
      '  "Password for "*) printf "%s\\n" "$FOCUSWIKI_PUSH_TOKEN" ;;',
      '  *) exit 1 ;;',
      'esac',
      ''
    ].join('\n'), { mode: 0o700 });
    // Reject a ref created between the API preflight and the push advertisement,
    // including a fast-forward. The server checks the advertised old OID atomically.
    fs.writeFileSync(path.join(hooks, 'pre-push'), [
      '#!/bin/sh',
      'while read -r local_ref local_oid remote_ref remote_oid; do',
      '  case "$remote_oid" in *[!0]*|"") exit 1 ;; esac',
      'done',
      ''
    ].join('\n'), { mode: 0o700 });
    await git(transport, [
      `--git-dir=${transport}`, '-c', `core.hooksPath=${hooks}`,
      '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'http.proxy=',
      '-c', 'credential.helper=', '-c', 'credential.interactive=false',
      'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', '--',
      ctx.repo.url, `${sha}:refs/heads/${ctx.branch}`
    ], {
      push: true,
      env: {
        GIT_ASKPASS: askpass, GIT_OBJECT_DIRECTORY: path.join(ctx.gitDir, 'objects'),
        FOCUSWIKI_PUSH_TOKEN: token
      }
    });
  } finally {
    fs.rmSync(transport, { recursive: true, force: true });
  }
}

type GitHubPull = {
  html_url?: string;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  base?: { ref?: string; repo?: { full_name?: string } };
};

function pullUrl(ctx: Enrollment, prepared: Prepared, pull: GitHubPull | null): string | null {
  const slug = ctx.repo.slug.toLowerCase();
  const url = pull?.html_url;
  if (!url || !url.startsWith('https://github.com/') || pull.head?.ref !== ctx.branch ||
      pull.head.sha !== prepared.sha || pull.head.repo?.full_name?.toLowerCase() !== slug ||
      pull.base?.ref !== prepared.baseBranch || pull.base.repo?.full_name?.toLowerCase() !== slug) return null;
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(url);
  return match?.[1].toLowerCase() === slug ? url : null;
}

async function findPullRequest(ctx: Enrollment, prepared: Prepared, token: string): Promise<string | null> {
  const endpoint = `${ctx.repo.api}/pulls`;
  const query = new URLSearchParams({
    head: `${ctx.repo.owner}:${ctx.branch}`, base: prepared.baseBranch, state: 'all', per_page: '100'
  });
  const pulls = await github<GitHubPull[]>(`${endpoint}?${query}`, token);
  if (!Array.isArray(pulls)) throw new ProposalError('GitHub returned an unexpected pull request listing.');
  for (const pull of pulls) {
    const url = pullUrl(ctx, prepared, pull);
    if (url) return url;
  }
  return null;
}

async function ensurePullRequest(ctx: Enrollment, prepared: Prepared, token: string, message: string): Promise<string> {
  const existing = await findPullRequest(ctx, prepared, token);
  if (existing) return existing;
  const title = message.split(/\r?\n/).find((line) => line.trim())!.trim();
  const pull = await github<GitHubPull>(`${ctx.repo.api}/pulls`, token, {
    title: Array.from(title).slice(0, 240).join(''), body: message, head: ctx.branch, base: prepared.baseBranch
  });
  const url = pullUrl(ctx, prepared, pull);
  if (!url) throw new ProposalError('GitHub returned an unexpected proposal pull request.');
  return url;
}

function verifyPrepared(prepared: Prepared, paths: string[], messageDigest: string): void {
  if (prepared.messageDigest !== messageDigest || JSON.stringify(prepared.paths) !== JSON.stringify(paths)) {
    throw new ProposalError('This review was already used with a different publication request.');
  }
}

export async function publishProposal(ctx: ProposalContext, input: PublishProposalInput): Promise<Proposal> {
  const enrolled = enrollment(ctx);
  if (typeof input.reviewId !== 'string' || input.reviewId.trim() !== input.reviewId ||
      !UUID.test(input.reviewId) || typeof input.message !== 'string' || !input.message.trim() ||
      Buffer.byteLength(input.message) > 8 * 1024 || reviewText(Buffer.from(input.message)) === null ||
      !Array.isArray(input.paths) || !input.paths.length || input.paths.length > MAX_REVIEW_FILES ||
      input.paths.some((relative) => typeof relative !== 'string' || !reviewablePath(relative)) ||
      new Set(input.paths).size !== input.paths.length) {
    throw new ProposalError('Publication requires a review ID, a safe commit message and unique reviewed paths.');
  }
  const { reviewId, message } = input;
  const paths = [...input.paths].sort();
  const messageDigest = digest(message);
  return withKeyLock(enrolled.gitDir, async () => {
    const directory = stateDirectory(enrolled);
    const review = load<Review>(directory, `${reviewId}.review`);
    if (!review || review.baseBranch !== await managedBaseBranch(enrolled) ||
        review.projectId !== enrolled.projectId || review.workTree !== enrolled.workTree ||
        review.remote !== enrolled.remote || review.branch !== enrolled.branch) {
      throw new ProposalError('Review is unavailable for this enrollment.');
    }
    const selection = paths.map((relative) => {
      const file = review.files.find((candidate) => candidate.path === relative);
      if (!file) throw new ProposalError('Publication includes a path outside the review.');
      return file;
    });
    const preparedName = `${reviewId}.prepared`;
    const pushedName = `${reviewId}.pushed`;
    const completedName = `${reviewId}.completed`;
    let prepared = load<Prepared>(directory, preparedName);
    if (prepared) {
      verifyPrepared(prepared, paths, messageDigest);
      const completed = load<Proposal>(directory, completedName);
      if (completed) return completed;
    }

    const captureSelection = async () => {
      if (await localHead(enrolled) !== review.base) throw new ProposalError('The local base changed. Run a new review.');
      const { files } = await capture(enrolled, review.base, selection);
      checkSelection(files, selection);
      return files;
    };

    let readToken: string | undefined;
    if (!prepared) {
      // Refuse a stale draft before asking for any credentials.
      const files = await captureSelection();
      readToken = await issueToken(enrolled, 'read');
      const baseBranch = await verifyRemoteBase(enrolled, readToken, review.base, review.baseBranch);
      if (await remoteTip(enrolled, readToken, enrolled.branch, true)) {
        throw new ProposalError('The proposal branch already exists. Use a new enrolled proposal branch.');
      }
      const sha = await prepareCommit(enrolled, directory, review.base, files, message);
      prepared = record(directory, preparedName, { paths, messageDigest, baseBranch, sha });
      verifyPrepared(prepared, paths, messageDigest);
    }

    await pinCommit(enrolled, reviewId, prepared.sha);
    readToken ??= await issueToken(enrolled, 'read');
    const existing = await remoteTip(enrolled, readToken, enrolled.branch, true);
    if (existing && existing !== prepared.sha) {
      throw new ProposalError('The proposal branch is occupied by a different commit.');
    }
    if (!existing) {
      if (load(directory, pushedName)) {
        const url = await findPullRequest(enrolled, prepared, await issueToken(enrolled, 'write'));
        if (url) return record(directory, completedName, { url, sha: prepared.sha });
        throw new ProposalError('The pushed proposal branch was removed.');
      }
      await verifyRemoteBase(enrolled, readToken, review.base, prepared.baseBranch);
    }
    const writeToken = await issueToken(enrolled, 'write');
    if (!existing) {
      // Recheck after blocking operations. A recovered, already-pushed commit is
      // identified by its immutable SHA and no longer depends on the mutable draft.
      await captureSelection();
      await verifyRemoteBase(enrolled, readToken, review.base, prepared.baseBranch);
      await pushProposal(enrolled, directory, prepared.sha, writeToken);
    }
    record(directory, pushedName, { sha: prepared.sha });
    if (await remoteTip(enrolled, readToken, enrolled.branch, true) !== prepared.sha) {
      throw new ProposalError('The pushed proposal branch no longer points to the approved commit.');
    }
    const url = await ensurePullRequest(enrolled, prepared, writeToken, message);
    return record(directory, completedName, { url, sha: prepared.sha });
  });
}
