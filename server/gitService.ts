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
import type { GitChangedFile, GitRepoStatus } from '../shared/types.js';

const execFileAsync = promisify(execFile);

const MAX_REVIEW_FILE_BYTES = 256 * 1024;

export class WorkingTreeSnapshotMismatchError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'WorkingTreeSnapshotMismatchError';
  }
}

async function runGitText(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout;
}

async function runGitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout;
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

export async function getGitRepoStatus(projectRoot: string): Promise<GitRepoStatus> {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return {
      branch: 'uninitialized',
      headSha: '',
      headSubject: 'Not a Git repository',
      isClean: true,
      changedFiles: []
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

  return {
    branch,
    headSha,
    headSubject,
    isClean: changedFiles.length === 0,
    changedFiles
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
