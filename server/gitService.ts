import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type ChangeFileSummary,
  type GitChangeReviewPayload,
  buildCodeFileReview,
  buildCommentSidecarReview,
  buildMarkdownFileReview,
  deriveHumanLabelForChangedPath
} from '../shared/changeReview.js';
import type {
  GitBranchEntry,
  GitChangedFile,
  GitPullRequestRef,
  GitRefsPayload,
  GitRepoStatus,
  RemoteInspectResult
} from '../shared/types.js';

import {
  type CredentialStore,
  type ResolvedGitCredential,
  extractHttpsHost
} from './credentialStore.js';

const execFileAsync = promisify(execFile);

const MAX_REVIEW_FILE_BYTES = 256 * 1024;
const GIT_NETWORK_TIMEOUT_MS = 60_000;
const CREDENTIAL_HELPER_SCRIPT =
  '!f() { test "$1" = "get" && printf "username=%s\\npassword=%s\\n" "$CAIRN_GIT_USERNAME" "$CAIRN_GIT_TOKEN"; }; f';

export class WorkingTreeSnapshotMismatchError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'WorkingTreeSnapshotMismatchError';
  }
}

export class WorkingTreeDirtyError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'WorkingTreeDirtyError';
  }
}

export class GitOperationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'GitOperationError';
    this.statusCode = statusCode;
  }
}

export class GitAuthError extends GitOperationError {
  readonly host: string | null;
  constructor(message: string, host: string | null = null) {
    super(message, 401);
    this.name = 'GitAuthError';
    this.host = host;
  }
}

export async function isSshClientAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ssh', ['-V'], { timeout: 3000 });
    return true;
  } catch (err) {
    // ssh -V exits 0 or non-zero depending on version, ENOENT means binary is missing
    const code = (err as NodeJS.ErrnoException)?.code;
    return code !== 'ENOENT';
  }
}

function buildGitEnv(credential?: ResolvedGitCredential | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C'
  };
  if (credential) {
    env.CAIRN_GIT_USERNAME = credential.username;
    env.CAIRN_GIT_TOKEN = credential.token;
  }
  return env;
}

function resolveSafeDirValue(cwd: string): string {
  try {
    return fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function buildGitArgs(
  cwd: string,
  args: string[],
  options?: { scopeSafeDir?: boolean; credential?: ResolvedGitCredential | null }
): string[] {
  const prefix: string[] = [];
  if (options?.scopeSafeDir ?? true) {
    prefix.push('-c', `safe.directory=${resolveSafeDirValue(cwd)}`);
  }
  if (options?.credential) {
    prefix.push('-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER_SCRIPT}`);
  }
  return [...prefix, ...args];
}

async function runGitText(
  cwd: string,
  args: string[],
  options?: { scopeSafeDir?: boolean; timeoutMs?: number; credential?: ResolvedGitCredential | null }
): Promise<string> {
  const fullArgs = buildGitArgs(cwd, args, options);
  const { stdout } = await execFileAsync('git', fullArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: options?.timeoutMs ?? 30_000,
    env: buildGitEnv(options?.credential)
  });
  return stdout;
}

async function runGitBuffer(
  cwd: string,
  args: string[],
  options?: { scopeSafeDir?: boolean; timeoutMs?: number; credential?: ResolvedGitCredential | null }
): Promise<Buffer> {
  const fullArgs = buildGitArgs(cwd, args, options);
  const { stdout } = await execFileAsync('git', fullArgs, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
    timeout: options?.timeoutMs ?? 30_000,
    env: buildGitEnv(options?.credential)
  });
  return stdout;
}

export function sanitizeRemoteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function validateGitRemoteUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (!url) {
    throw new GitOperationError('Repository URL is required.', 400);
  }
  if (url.startsWith('-') || url.includes('\0') || /[\r\n]/.test(url)) {
    throw new GitOperationError('Invalid repository URL.', 400);
  }
  if (/^ext::/i.test(url)) {
    throw new GitOperationError('Unsupported Git transport.', 400);
  }

  const isStandardScheme = /^(https?|ssh|git|file):\/\//i.test(url);
  const isScpStyle = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:[^\s]+$/.test(url);
  if (!isStandardScheme && !isScpStyle) {
    throw new GitOperationError(
      'Repository URL must use https://, http://, ssh://, git://, file://, or git@host:owner/repo.git syntax.',
      400
    );
  }

  return url;
}

function validateGitRefToken(ref: string, label = 'ref'): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith('-') || /[\s\0~^:?*[\\]/.test(trimmed) || trimmed.includes('..')) {
    throw new GitOperationError(`Invalid Git ${label}: "${ref}".`, 400);
  }
  return trimmed;
}

function extractGitErrorDetail(
  err: unknown,
  credentialStore?: CredentialStore,
  extraSecrets: string[] = []
): string {
  let raw = err instanceof Error ? err.message : 'Git command failed.';
  if (err && typeof err === 'object') {
    const stderr = (err as { stderr?: string | Buffer }).stderr;
    const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
    if (text.trim()) {
      raw = text.trim().split(/\r?\n/).slice(-4).join(' ');
    }
  }
  if (credentialStore) {
    return credentialStore.scrubText(raw, extraSecrets);
  }
  let scrubbed = raw.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1***:***@');
  for (const s of extraSecrets) {
    if (s && s.length >= 4 && scrubbed.includes(s)) {
      scrubbed = scrubbed.split(s).join('***');
    }
  }
  return scrubbed;
}

function isGitAuthFailure(detail: string): boolean {
  return /could not read username|authentication failed|invalid username or token|terminal prompts disabled|http basic: access denied|the requested url returned error: 40[13]/i.test(
    detail
  );
}

function isBufferBinary(buf: Buffer | null): boolean {
  if (!buf || buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return sample.includes(0);
}

function detectLanguageHint(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'html';
    case '.js':
    case '.mjs':
      return 'javascript';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.css':
      return 'css';
    case '.json':
      return 'json';
    case '.md':
      return 'markdown';
    case '.yml':
    case '.yaml':
      return 'yaml';
    default:
      return 'text';
  }
}

function formatPorcelainStatus(
  xy: string
): 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' {
  if (xy === '??') return 'untracked';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

async function resolvePrimaryRemote(projectRoot: string): Promise<{ name: string | null; url: string | null }> {
  try {
    const remotesRaw = (await runGitText(projectRoot, ['remote'])).trim();
    const remotes = remotesRaw
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean);
    if (remotes.length === 0) return { name: null, url: null };
    const chosen = remotes.includes('origin') ? 'origin' : remotes[0];
    const urlRaw = (await runGitText(projectRoot, ['remote', 'get-url', chosen])).trim();
    return { name: chosen, url: urlRaw ? sanitizeRemoteUrl(urlRaw) : null };
  } catch {
    return { name: null, url: null };
  }
}

async function readAheadBehind(projectRoot: string): Promise<{ ahead: number; behind: number }> {
  try {
    const raw = (
      await runGitText(projectRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    ).trim();
    const parts = raw.split(/\s+/);
    const ahead = Number.parseInt(parts[0] ?? '0', 10) || 0;
    const behind = Number.parseInt(parts[1] ?? '0', 10) || 0;
    return { ahead, behind };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export async function getGitRepoStatus(projectRoot: string): Promise<GitRepoStatus> {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return {
      branch: 'uninitialized',
      headSha: '',
      headSubject: 'Not a Git repository',
      isClean: true,
      changedFiles: [],
      remoteName: null,
      remoteUrl: null,
      ahead: 0,
      behind: 0
    };
  }

  let branch = 'HEAD';
  try {
    branch = (await runGitText(projectRoot, ['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    try {
      branch = (await runGitText(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    } catch {
      branch = 'main';
    }
  }

  let headSha = '';
  let headSubject = 'No commits yet';
  try {
    const logLine = (await runGitText(projectRoot, ['log', '-1', '--format=%h\t%s'])).trim();
    if (logLine) {
      const [sha, ...rest] = logLine.split('\t');
      headSha = sha ?? '';
      headSubject = rest.join('\t') || '';
    }
  } catch {
    // Unborn branch
  }

  const statusBuf = await runGitBuffer(projectRoot, ['status', '--porcelain=v1', '-uall', '-z']);
  const tokens = statusBuf.toString('utf8').split('\0');
  const changedFiles: GitChangedFile[] = [];

  for (let idx = 0; idx < tokens.length; idx++) {
    const entry = tokens[idx];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const primaryPath = entry.slice(3);
    if (!primaryPath) continue;
    const status = formatPorcelainStatus(xy);
    if (xy.includes('R') || xy.includes('C')) {
      const origPath = tokens[idx + 1] || undefined;
      idx++;
      changedFiles.push({
        path: primaryPath,
        ...(origPath ? { oldPath: origPath } : {}),
        status
      });
    } else {
      changedFiles.push({
        path: primaryPath,
        status
      });
    }
  }

  const remote = await resolvePrimaryRemote(projectRoot);
  const { ahead, behind } = await readAheadBehind(projectRoot);

  return {
    branch,
    headSha,
    headSubject,
    isClean: changedFiles.length === 0,
    changedFiles,
    remoteName: remote.name,
    remoteUrl: remote.url,
    ahead,
    behind
  };
}

export async function computeWorkingTreeSnapshotDigest(
  projectRoot: string,
  status?: GitRepoStatus
): Promise<string> {
  const current = status ?? (await getGitRepoStatus(projectRoot));
  const hash = crypto.createHash('sha256');
  hash.update(`branch:${current.branch}\nhead:${current.headSha}\n`);

  const sorted = [...current.changedFiles].sort((a, b) => a.path.localeCompare(b.path));
  for (const item of sorted) {
    hash.update(`file:${item.status}:${item.oldPath ?? ''}:${item.path}\n`);
    const abs = path.join(projectRoot, item.path);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const contentHash = crypto
          .createHash('sha256')
          .update(fs.readFileSync(abs))
          .digest('hex');
        hash.update(`sha:${contentHash}\n`);
      } else {
        hash.update('sha:missing\n');
      }
    } catch {
      hash.update('sha:unreadable\n');
    }
  }

  return hash.digest('hex').slice(0, 24);
}

async function readHeadBlobBuffer(projectRoot: string, relPath: string): Promise<Buffer | null> {
  try {
    return await runGitBuffer(projectRoot, ['show', `HEAD:${relPath}`]);
  } catch {
    return null;
  }
}

async function readSingleFileRawPatch(
  projectRoot: string,
  file: GitChangedFile,
  afterBuf: Buffer | null,
  isBinary: boolean
): Promise<string> {
  if (file.status === 'untracked') {
    if (isBinary) {
      return `diff --git a/${file.path} b/${file.path}\nnew binary file (${afterBuf?.length ?? 0} bytes)`;
    }
    const raw = (afterBuf ? afterBuf.subarray(0, 16_000).toString('utf8') : '').replace(/\r\n/g, '\n');
    const lines = raw.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const plus = lines.map((l) => `+${l}`).join('\n');
    return `diff --git a/${file.path} b/${file.path}\nnew file (untracked)\n--- /dev/null\n+++ b/${file.path}\n${plus}`;
  }

  const pathArgs = file.oldPath ? [file.oldPath, file.path] : [file.path];
  try {
    const out = await runGitText(projectRoot, ['diff', 'HEAD', '--', ...pathArgs]);
    return out.trimEnd();
  } catch {
    try {
      const out = await runGitText(projectRoot, ['diff', '--', ...pathArgs]);
      return out.trimEnd();
    } catch {
      return '';
    }
  }
}

export async function getGitWorkingDiff(projectRoot: string): Promise<GitChangeReviewPayload> {
  const status = await getGitRepoStatus(projectRoot);
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return {
      status,
      diff: '',
      snapshotDigest: 'uninitialized',
      commitScopeNote: 'Directory is not initialized as a Git repository.',
      files: []
    };
  }

  const snapshotDigest = await computeWorkingTreeSnapshotDigest(projectRoot, status);
  const files: ChangeFileSummary[] = [];
  const rawPatches: string[] = [];

  for (const ch of status.changedFiles) {
    const normStatus = (
      ['modified', 'added', 'deleted', 'renamed', 'untracked'].includes(ch.status)
        ? ch.status
        : 'modified'
    ) as ChangeFileSummary['status'];

    const headLookupPath = ch.oldPath ?? ch.path;
    const beforeBuf =
      normStatus === 'added' || normStatus === 'untracked'
        ? null
        : await readHeadBlobBuffer(projectRoot, headLookupPath);

    let afterBuf: Buffer | null = null;
    if (normStatus !== 'deleted') {
      const abs = path.join(projectRoot, ch.path);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        afterBuf = fs.readFileSync(abs);
      }
    }

    const beforeBytes = beforeBuf?.length ?? 0;
    const afterBytes = afterBuf?.length ?? 0;
    const isBinary = isBufferBinary(beforeBuf) || isBufferBinary(afterBuf);
    const truncated =
      !isBinary && (beforeBytes > MAX_REVIEW_FILE_BYTES || afterBytes > MAX_REVIEW_FILE_BYTES);

    const beforeText =
      !isBinary && beforeBuf !== null
        ? beforeBuf.subarray(0, MAX_REVIEW_FILE_BYTES).toString('utf8')
        : null;
    const afterText =
      !isBinary && afterBuf !== null
        ? afterBuf.subarray(0, MAX_REVIEW_FILE_BYTES).toString('utf8')
        : null;

    const rawPatch = await readSingleFileRawPatch(projectRoot, ch, afterBuf, isBinary);
    if (rawPatch) {
      rawPatches.push(rawPatch);
    }

    const humanTitle = deriveHumanLabelForChangedPath(ch.path, beforeText, afterText);

    if (isBinary) {
      files.push({
        path: ch.path,
        ...(ch.oldPath ? { oldPath: ch.oldPath } : {}),
        status: normStatus,
        category: 'binary',
        humanTitle,
        formattingOnly: false,
        summaryLabel: `Binary file (${beforeBytes} B → ${afterBytes} B)`,
        isBinary: true,
        truncated: false,
        beforeBytes,
        afterBytes,
        rawPatch
      });
      continue;
    }

    if (ch.path.endsWith('.md')) {
      const mdReview = buildMarkdownFileReview(beforeText, afterText);
      const formattingOnly =
        normStatus === 'modified' &&
        !truncated &&
        mdReview.substantiveCount === 0 &&
        mdReview.formattingOnlyCount > 0;

      let summaryLabel = '';
      if (normStatus === 'added' || normStatus === 'untracked') {
        summaryLabel = `New document (${mdReview.substantiveCount} ${
          mdReview.substantiveCount === 1 ? 'block' : 'blocks'
        })`;
      } else if (normStatus === 'deleted') {
        summaryLabel = 'Deleted document';
      } else if (formattingOnly) {
        summaryLabel =
          mdReview.formattingOnlyTables > 0
            ? 'Table pipe alignment only'
            : 'Markdown formatting only';
      } else {
        const parts: string[] = [];
        if (mdReview.substantiveCount > 0) {
          parts.push(
            `${mdReview.substantiveCount} content ${
              mdReview.substantiveCount === 1 ? 'change' : 'changes'
            }`
          );
        }
        if (mdReview.formattingOnlyTables > 0) {
          parts.push(
            `${mdReview.formattingOnlyTables} table formatting-only`
          );
        } else if (mdReview.formattingOnlyCount > 0) {
          parts.push(`${mdReview.formattingOnlyCount} formatting-only`);
        }
        summaryLabel = parts.join(' · ') || 'Whitespace change';
      }

      files.push({
        path: ch.path,
        ...(ch.oldPath ? { oldPath: ch.oldPath } : {}),
        status: normStatus,
        category: 'markdown',
        humanTitle,
        formattingOnly,
        summaryLabel,
        isBinary: false,
        truncated,
        beforeBytes,
        afterBytes,
        rawPatch,
        markdownReview: mdReview
      });
      continue;
    }

    if (ch.path.endsWith('.comments.json')) {
      const commentReview = buildCommentSidecarReview(beforeText, afterText);
      const codeFallback = commentReview.parseError
        ? buildCodeFileReview(beforeText, afterText, 'json')
        : undefined;
      const summaryLabel = commentReview.parseError
        ? 'Comment JSON diff'
        : normStatus === 'deleted'
          ? 'Deleted comment sidecar'
          : `${commentReview.changes.length} thread ${
              commentReview.changes.length === 1 ? 'update' : 'updates'
            }`;

      files.push({
        path: ch.path,
        ...(ch.oldPath ? { oldPath: ch.oldPath } : {}),
        status: normStatus,
        category: 'comments',
        humanTitle,
        formattingOnly: false,
        summaryLabel,
        isBinary: false,
        truncated,
        beforeBytes,
        afterBytes,
        rawPatch,
        commentReview,
        ...(codeFallback ? { codeReview: codeFallback } : {})
      });
      continue;
    }

    const codeReview = buildCodeFileReview(beforeText, afterText, detectLanguageHint(ch.path));
    const summaryLabel =
      normStatus === 'added' || normStatus === 'untracked'
        ? `New file (+${codeReview.addedLines} lines)`
        : normStatus === 'deleted'
          ? `Deleted file (-${codeReview.removedLines} lines)`
          : `+${codeReview.addedLines} / -${codeReview.removedLines} lines`;

    files.push({
      path: ch.path,
      ...(ch.oldPath ? { oldPath: ch.oldPath } : {}),
      status: normStatus,
      category: 'code',
      humanTitle,
      formattingOnly: false,
      summaryLabel,
      isBinary: false,
      truncated: truncated || codeReview.hunksTruncated,
      beforeBytes,
      afterBytes,
      rawPatch,
      codeReview
    });
  }

  const fileCount = status.changedFiles.length;
  const commitScopeNote =
    fileCount === 0
      ? 'Working tree is clean.'
      : fileCount === 1
        ? `Committing stages and records the 1 changed working-tree file in this repository on local branch ${status.branch} (never pushes).`
        : `Committing stages and records all ${fileCount} changed working-tree files in this repository on local branch ${status.branch} (never pushes).`;

  return {
    status,
    diff: rawPatches.join('\n\n'),
    snapshotDigest,
    commitScopeNote,
    files
  };
}

export function normalizeCommitMessage(rawMessage: string): string {
  const normalized = rawMessage.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('Commit message cannot be empty.');
  }
  return `${normalized}\n`;
}

async function readConfiguredGitIdentity(
  projectRoot: string
): Promise<{ name: string | null; email: string | null }> {
  let name: string | null = null;
  let email: string | null = null;
  try {
    name = (await runGitText(projectRoot, ['config', '--get', 'user.name'])).trim() || null;
  } catch {
    name = null;
  }
  try {
    email = (await runGitText(projectRoot, ['config', '--get', 'user.email'])).trim() || null;
  } catch {
    email = null;
  }
  return { name, email };
}

export async function commitWorkingTree(
  projectRoot: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
  expectedSnapshotDigest?: string
): Promise<{ sha: string; subject: string; status: GitRepoStatus }> {
  const before = await getGitRepoStatus(projectRoot);
  if (before.isClean) {
    throw new Error('Working tree has no uncommitted changes to commit.');
  }

  if (expectedSnapshotDigest && expectedSnapshotDigest.trim()) {
    const currentDigest = await computeWorkingTreeSnapshotDigest(projectRoot, before);
    if (currentDigest !== expectedSnapshotDigest.trim()) {
      throw new WorkingTreeSnapshotMismatchError(
        'Working files changed since this review was loaded. Review the updated changes before committing.'
      );
    }
  }

  const formattedMessage = normalizeCommitMessage(message);
  const configured = await readConfiguredGitIdentity(projectRoot);
  const resolvedName = authorName?.trim() || configured.name || 'Workspace Author';
  const resolvedEmail = authorEmail?.trim() || configured.email || 'author@local.invalid';

  await runGitText(projectRoot, ['add', '-A']);
  await runGitText(projectRoot, [
    '-c',
    `user.name=${resolvedName}`,
    '-c',
    `user.email=${resolvedEmail}`,
    'commit',
    '--cleanup=verbatim',
    '-m',
    formattedMessage
  ]);

  const after = await getGitRepoStatus(projectRoot);
  return {
    sha: after.headSha,
    subject: after.headSubject,
    status: after
  };
}

function resolveCredentialForTarget(
  remoteUrl: string | null | undefined,
  credentialStore?: CredentialStore,
  override?: { username?: string; token?: string } | null
): ResolvedGitCredential | null {
  if (!remoteUrl) return null;
  const host = extractHttpsHost(remoteUrl);
  if (!host) return null;
  const overrideToken = override?.token?.trim();
  if (overrideToken) {
    return {
      host,
      username: override?.username?.trim() || 'x-access-token',
      token: overrideToken
    };
  }
  return credentialStore?.resolveForRemoteUrl(remoteUrl) ?? null;
}

export async function inspectRemoteRepository(
  rawUrl: string,
  options?: {
    credentialStore?: CredentialStore;
    overrideCredential?: { username?: string; token?: string } | null;
  }
): Promise<RemoteInspectResult> {
  const url = validateGitRemoteUrl(rawUrl);
  const credential = resolveCredentialForTarget(
    url,
    options?.credentialStore,
    options?.overrideCredential
  );
  let output = '';
  try {
    output = await runGitText(
      process.cwd(),
      ['ls-remote', '--symref', '--', url, 'HEAD', 'refs/heads/*', 'refs/pull/*/head', 'refs/merge-requests/*/head'],
      { scopeSafeDir: false, timeoutMs: GIT_NETWORK_TIMEOUT_MS, credential }
    );
  } catch (err) {
    const detail = extractGitErrorDetail(
      err,
      options?.credentialStore,
      credential ? [credential.token] : []
    );
    if (isGitAuthFailure(detail)) {
      throw new GitAuthError(
        `Authentication required for ${extractHttpsHost(url) ?? 'remote repository'}: ${detail}`,
        extractHttpsHost(url)
      );
    }
    throw new GitOperationError(`Unable to inspect remote repository: ${detail}`, 400);
  }

  let defaultBranch: string | null = null;
  const branches: string[] = [];
  const pullRequests: Array<{ number: number; ref: string; sha: string }> = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('ref: ')) {
      const m = line.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/);
      if (m) defaultBranch = m[1];
      continue;
    }
    const [sha, refName] = line.split(/\t+/);
    if (!sha || !refName) continue;
    if (refName.startsWith('refs/heads/')) {
      branches.push(refName.slice('refs/heads/'.length));
    } else {
      const prMatch = refName.match(/^refs\/(?:pull|merge-requests)\/(\d+)\/head$/);
      if (prMatch) {
        pullRequests.push({
          number: Number.parseInt(prMatch[1], 10),
          ref: refName,
          sha: sha.slice(0, 7)
        });
      }
    }
  }

  branches.sort((a, b) => {
    if (a === defaultBranch) return -1;
    if (b === defaultBranch) return 1;
    return a.localeCompare(b);
  });
  pullRequests.sort((a, b) => b.number - a.number);

  return {
    url: sanitizeRemoteUrl(url),
    defaultBranch,
    branches,
    pullRequests
  };
}

export async function cloneRepository(options: {
  url: string;
  destDir: string;
  branch?: string;
  prNumber?: number;
  credentialStore?: CredentialStore;
  overrideCredential?: { username?: string; token?: string } | null;
}): Promise<GitRepoStatus> {
  const url = validateGitRemoteUrl(options.url);
  if (fs.existsSync(options.destDir)) {
    throw new GitOperationError(`Destination already exists at ${options.destDir}.`, 409);
  }
  fs.mkdirSync(path.dirname(options.destDir), { recursive: true, mode: 0o770 });

  const branch = options.branch?.trim() ? validateGitRefToken(options.branch, 'branch') : undefined;
  const prNumber =
    typeof options.prNumber === 'number' && Number.isInteger(options.prNumber) && options.prNumber > 0
      ? options.prNumber
      : undefined;
  const credential = resolveCredentialForTarget(
    url,
    options.credentialStore,
    options.overrideCredential
  );

  const cloneArgs = ['clone'];
  if (branch && !prNumber) {
    cloneArgs.push('--branch', branch);
  }
  cloneArgs.push('--', url, options.destDir);

  try {
    await runGitText(path.dirname(options.destDir), cloneArgs, {
      scopeSafeDir: false,
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      credential
    });
  } catch (err) {
    if (fs.existsSync(options.destDir)) {
      fs.rmSync(options.destDir, { recursive: true, force: true });
    }
    const detail = extractGitErrorDetail(
      err,
      options.credentialStore,
      credential ? [credential.token] : []
    );
    if (isGitAuthFailure(detail)) {
      throw new GitAuthError(
        `Authentication required to clone ${extractHttpsHost(url) ?? 'repository'}: ${detail}`,
        extractHttpsHost(url)
      );
    }
    throw new GitOperationError(`Git clone failed: ${detail}`, 400);
  }

  if (prNumber) {
    try {
      await checkoutGitPrNumber(options.destDir, prNumber, 'origin', credential);
    } catch (err) {
      if (fs.existsSync(options.destDir)) {
        fs.rmSync(options.destDir, { recursive: true, force: true });
      }
      throw err;
    }
  }

  return getGitRepoStatus(options.destDir);
}

export async function initNewWikiRepository(options: {
  destDir: string;
  title: string;
  defaultDoc: string;
}): Promise<GitRepoStatus> {
  if (fs.existsSync(options.destDir)) {
    throw new GitOperationError(`Destination already exists at ${options.destDir}.`, 409);
  }
  fs.mkdirSync(options.destDir, { recursive: true, mode: 0o770 });

  const relDoc = options.defaultDoc.trim() || 'README.md';
  const docAbs = path.resolve(options.destDir, relDoc);
  if (!docAbs.startsWith(path.resolve(options.destDir) + path.sep)) {
    throw new GitOperationError('Default document path escapes repository directory.', 400);
  }
  fs.mkdirSync(path.dirname(docAbs), { recursive: true, mode: 0o770 });
  fs.writeFileSync(
    docAbs,
    `# ${options.title.trim() || 'Repository Docs'}\n\nWelcome to this FocusWiki documentation repository.\n`,
    { encoding: 'utf8', mode: 0o660 }
  );

  await runGitText(options.destDir, ['init', '-b', 'main']);
  await runGitText(options.destDir, ['add', '-A']);
  await runGitText(options.destDir, [
    '-c',
    'user.name=Workspace Author',
    '-c',
    'user.email=author@local.invalid',
    'commit',
    '-m',
    'Initialize wiki repository'
  ]);

  return getGitRepoStatus(options.destDir);
}

export async function getGitRefs(projectRoot: string): Promise<GitRefsPayload> {
  const status = await getGitRepoStatus(projectRoot);
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return {
      status,
      hasRemote: false,
      remoteName: null,
      remoteUrl: null,
      ahead: 0,
      behind: 0,
      branches: [],
      pullRequests: []
    };
  }

  const remote = await resolvePrimaryRemote(projectRoot);
  const { ahead, behind } = await readAheadBehind(projectRoot);

  const branches: GitBranchEntry[] = [];
  const pullRequests: GitPullRequestRef[] = [];
  const prByNumber = new Map<number, GitPullRequestRef>();

  const localRaw = await runGitText(projectRoot, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)\t%(HEAD)\t%(objectname:short)\t%(upstream:short)\t%(subject)',
    'refs/heads'
  ]);

  const localBranchSet = new Set<string>();
  for (const line of localRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, headFlag, sha, upstream, ...subjectParts] = line.split('\t');
    if (!name) continue;
    localBranchSet.add(name);
    const prMatch = name.match(/^(?:pr|mr)\/(\d+)$/);
    if (prMatch) {
      const num = Number.parseInt(prMatch[1], 10);
      prByNumber.set(num, {
        number: num,
        ref: `refs/heads/${name}`,
        sha: sha ?? '',
        localBranch: name,
        checkedOut: headFlag === '*',
        subject: subjectParts.join('\t') || undefined
      });
    }
    branches.push({
      name,
      kind: 'local',
      ...(upstream ? { upstream } : {}),
      sha: sha ?? '',
      subject: subjectParts.join('\t') || '',
      isCurrent: headFlag === '*'
    });
  }

  const remoteRaw = await runGitText(projectRoot, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)\t%(objectname:short)\t%(subject)',
    'refs/remotes'
  ]);

  for (const line of remoteRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [fullName, sha, ...subjectParts] = line.split('\t');
    if (!fullName || fullName.endsWith('/HEAD')) continue;
    const slashIdx = fullName.indexOf('/');
    const remotePrefix = slashIdx > 0 ? fullName.slice(0, slashIdx) : remote.name ?? 'origin';
    const shortName = slashIdx > 0 ? fullName.slice(slashIdx + 1) : fullName;

    const prMatch = shortName.match(/^(?:pr|mr)\/(\d+)$/);
    if (prMatch) {
      const num = Number.parseInt(prMatch[1], 10);
      if (!prByNumber.has(num)) {
        prByNumber.set(num, {
          number: num,
          ref: `refs/remotes/${fullName}`,
          sha: sha ?? '',
          localBranch: `pr/${num}`,
          checkedOut: status.branch === `pr/${num}`,
          subject: subjectParts.join('\t') || undefined
        });
      }
      continue;
    }

    branches.push({
      name: fullName,
      kind: 'remote',
      remote: remotePrefix,
      sha: sha ?? '',
      subject: subjectParts.join('\t') || '',
      isCurrent: false
    });
  }

  for (const pr of prByNumber.values()) {
    pullRequests.push(pr);
  }
  pullRequests.sort((a, b) => b.number - a.number);

  return {
    status,
    hasRemote: Boolean(remote.name && remote.url),
    remoteName: remote.name,
    remoteUrl: remote.url,
    ahead,
    behind,
    branches,
    pullRequests
  };
}

export async function fetchGitRemote(
  projectRoot: string,
  credentialStore?: CredentialStore,
  options?: { includePrRefs?: boolean }
): Promise<GitRefsPayload> {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    throw new GitOperationError('Directory is not a Git repository.', 400);
  }
  const remote = await resolvePrimaryRemote(projectRoot);
  if (!remote.name) {
    throw new GitOperationError('No Git remote is configured for this repository.', 400);
  }

  const credential = resolveCredentialForTarget(remote.url, credentialStore);
  const includePrRefs = options?.includePrRefs ?? true;

  try {
    await runGitText(projectRoot, ['fetch', '--prune', remote.name], {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      credential
    });
  } catch (err) {
    const detail = extractGitErrorDetail(
      err,
      credentialStore,
      credential ? [credential.token] : []
    );
    if (isGitAuthFailure(detail)) {
      throw new GitAuthError(
        `Authentication required for ${extractHttpsHost(remote.url ?? '') ?? 'remote'}: ${detail}`,
        extractHttpsHost(remote.url ?? '')
      );
    }
    throw new GitOperationError(`Git fetch failed: ${detail}`, 502);
  }

  // Also fetch PR / MR heads if enabled and the remote advertises them (GitHub, Gitea/Forgejo, GitLab)
  if (includePrRefs) {
    try {
      const lsPr = await runGitText(
        projectRoot,
        ['ls-remote', remote.name, 'refs/pull/*/head', 'refs/merge-requests/*/head'],
        { timeoutMs: GIT_NETWORK_TIMEOUT_MS, credential }
      );
      const hasPull = lsPr.includes('refs/pull/');
      const hasMr = lsPr.includes('refs/merge-requests/');
      if (hasPull) {
        await runGitText(
          projectRoot,
          ['fetch', remote.name, `+refs/pull/*/head:refs/remotes/${remote.name}/pr/*`],
          { timeoutMs: GIT_NETWORK_TIMEOUT_MS, credential }
        );
      }
      if (hasMr) {
        await runGitText(
          projectRoot,
          ['fetch', remote.name, `+refs/merge-requests/*/head:refs/remotes/${remote.name}/mr/*`],
          { timeoutMs: GIT_NETWORK_TIMEOUT_MS, credential }
        );
      }
    } catch {
      // Non-fatal: standard Git bare remotes may not support PR ref namespaces
    }
  }

  return getGitRefs(projectRoot);
}

export async function pullGitRemote(
  projectRoot: string,
  credentialStore?: CredentialStore
): Promise<{
  status: GitRepoStatus;
  summary: string;
  updated: boolean;
}> {
  const before = await getGitRepoStatus(projectRoot);
  if (!before.isClean) {
    throw new WorkingTreeDirtyError(
      'Commit or revert uncommitted working-tree changes before pulling from remote.'
    );
  }

  const remote = await resolvePrimaryRemote(projectRoot);
  if (!remote.name) {
    throw new GitOperationError('No Git remote is configured for this repository.', 400);
  }

  const credential = resolveCredentialForTarget(remote.url, credentialStore);

  try {
    await runGitText(projectRoot, ['fetch', '--prune', remote.name], {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      credential
    });
  } catch (err) {
    const detail = extractGitErrorDetail(
      err,
      credentialStore,
      credential ? [credential.token] : []
    );
    if (isGitAuthFailure(detail)) {
      throw new GitAuthError(
        `Authentication required for ${extractHttpsHost(remote.url ?? '') ?? 'remote'}: ${detail}`,
        extractHttpsHost(remote.url ?? '')
      );
    }
    throw new GitOperationError(`Git fetch failed: ${detail}`, 502);
  }

  // Determine upstream or matching remote branch
  let pullTargetArgs: string[] = ['pull', '--ff-only'];
  let hasUpstream = false;
  try {
    await runGitText(projectRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    hasUpstream = true;
  } catch {
    hasUpstream = false;
  }

  if (!hasUpstream) {
    const candidateRemoteRef = `${remote.name}/${before.branch}`;
    try {
      await runGitText(projectRoot, ['rev-parse', '--verify', `refs/remotes/${candidateRemoteRef}`]);
      pullTargetArgs = ['pull', '--ff-only', remote.name, before.branch];
    } catch {
      throw new GitOperationError(
        `Branch "${before.branch}" has no upstream tracking branch on "${remote.name}".`,
        400
      );
    }
  }

  let output = '';
  try {
    output = (
      await runGitText(projectRoot, pullTargetArgs, {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        credential
      })
    ).trim();
  } catch (err) {
    const detail = extractGitErrorDetail(
      err,
      credentialStore,
      credential ? [credential.token] : []
    );
    if (detail.includes('Not possible to fast-forward')) {
      throw new GitOperationError(
        'Remote branch has diverged from local commits and cannot fast-forward cleanly.',
        409
      );
    }
    if (isGitAuthFailure(detail)) {
      throw new GitAuthError(
        `Authentication required for ${extractHttpsHost(remote.url ?? '') ?? 'remote'}: ${detail}`,
        extractHttpsHost(remote.url ?? '')
      );
    }
    throw new GitOperationError(`Git pull failed: ${detail}`, 502);
  }

  const after = await getGitRepoStatus(projectRoot);
  const updated = before.headSha !== after.headSha;
  return {
    status: after,
    updated,
    summary: updated
      ? `Updated ${after.branch} (${before.headSha || 'init'} → ${after.headSha})`
      : output || `${after.branch} is already up to date`
  };
}

async function checkoutGitPrNumber(
  projectRoot: string,
  prNumber: number,
  remoteName: string,
  credential?: ResolvedGitCredential | null
): Promise<void> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new GitOperationError('Pull request number must be a positive integer.', 400);
  }

  const localBranch = `pr/${prNumber}`;
  const remotePrRef = `refs/remotes/${remoteName}/pr/${prNumber}`;
  const remoteMrRef = `refs/remotes/${remoteName}/mr/${prNumber}`;

  // Try fetching fresh PR head (refs/pull/<n>/head, then refs/merge-requests/<n>/head)
  let fetchedRef: string | null = null;
  for (const [remotePattern, localTarget] of [
    [`+refs/pull/${prNumber}/head:${remotePrRef}`, remotePrRef],
    [`+refs/merge-requests/${prNumber}/head:${remoteMrRef}`, remoteMrRef]
  ]) {
    try {
      await runGitText(projectRoot, ['fetch', remoteName, remotePattern], {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        credential
      });
      fetchedRef = localTarget;
      break;
    } catch {
      // Try next ref convention
    }
  }

  if (!fetchedRef) {
    for (const candidate of [remotePrRef, remoteMrRef, `refs/heads/${localBranch}`]) {
      try {
        await runGitText(projectRoot, ['rev-parse', '--verify', candidate]);
        fetchedRef = candidate;
        break;
      } catch {
        // continue
      }
    }
  }

  if (!fetchedRef) {
    throw new GitOperationError(
      `Pull request #${prNumber} was not found on remote "${remoteName}".`,
      404
    );
  }

  if (fetchedRef === `refs/heads/${localBranch}`) {
    await runGitText(projectRoot, ['checkout', localBranch, '--']);
  } else {
    await runGitText(projectRoot, ['checkout', '-B', localBranch, fetchedRef, '--']);
  }
}

export async function checkoutGitTarget(
  projectRoot: string,
  target: { kind: 'local' | 'remote' | 'pr'; ref: string; prNumber?: number },
  credentialStore?: CredentialStore
): Promise<{ status: GitRepoStatus; branch: string }> {
  const before = await getGitRepoStatus(projectRoot);
  if (!before.isClean) {
    throw new WorkingTreeDirtyError(
      'Commit or revert uncommitted working-tree changes before switching branches or PRs.'
    );
  }

  const remote = await resolvePrimaryRemote(projectRoot);
  const credential = resolveCredentialForTarget(remote.url, credentialStore);

  if (target.kind === 'pr') {
    const parsedNum =
      typeof target.prNumber === 'number'
        ? target.prNumber
        : Number.parseInt(target.ref.replace(/^(?:pr|mr)\//, '').replace(/^#/, ''), 10);
    if (!Number.isInteger(parsedNum) || parsedNum <= 0) {
      throw new GitOperationError('Valid pull request number is required.', 400);
    }
    await checkoutGitPrNumber(projectRoot, parsedNum, remote.name ?? 'origin', credential);
    const after = await getGitRepoStatus(projectRoot);
    return { status: after, branch: after.branch };
  }

  const safeRef = validateGitRefToken(target.ref, 'branch');

  if (target.kind === 'local') {
    try {
      await runGitText(projectRoot, ['checkout', safeRef, '--']);
    } catch (err) {
      throw new GitOperationError(`Could not switch to branch "${safeRef}": ${extractGitErrorDetail(err)}`, 400);
    }
    const after = await getGitRepoStatus(projectRoot);
    return { status: after, branch: after.branch };
  }

  // target.kind === 'remote' (e.g. "origin/feature-docs")
  const slashIdx = safeRef.indexOf('/');
  const localBranchName = slashIdx > 0 ? safeRef.slice(slashIdx + 1) : safeRef;
  let localExists = false;
  try {
    await runGitText(projectRoot, ['rev-parse', '--verify', `refs/heads/${localBranchName}`]);
    localExists = true;
  } catch {
    localExists = false;
  }

  try {
    if (localExists) {
      await runGitText(projectRoot, ['checkout', localBranchName, '--']);
    } else {
      await runGitText(projectRoot, ['checkout', '-b', localBranchName, '--track', safeRef, '--']);
    }
  } catch (err) {
    throw new GitOperationError(
      `Could not check out remote branch "${safeRef}": ${extractGitErrorDetail(err)}`,
      400
    );
  }

  const after = await getGitRepoStatus(projectRoot);
  return { status: after, branch: after.branch };
}

