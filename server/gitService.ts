import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitChangedFile, GitRepoStatus } from '../shared/types.js';

const execFileAsync = promisify(execFile);

export const OPENBOT_TRAILER =
  'Co-authored-by: OpenBot <335604065+openbotgit[bot]@users.noreply.github.com>';

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout;
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
    branch = (await runGit(projectRoot, ['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    try {
      branch = (await runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    } catch {
      branch = 'main';
    }
  }

  let headSha = '';
  let headSubject = 'No commits yet';
  try {
    const logLine = (await runGit(projectRoot, ['log', '-1', '--format=%h\t%s'])).trim();
    if (logLine) {
      const [sha, ...rest] = logLine.split('\t');
      headSha = sha ?? '';
      headSubject = rest.join('\t') || '';
    }
  } catch {
    // Unborn branch
  }

  const statusOut = await runGit(projectRoot, ['status', '--porcelain=v1', '-uall']);
  const changedFiles: GitChangedFile[] = [];

  for (const rawLine of statusOut.split('\n')) {
    if (rawLine.length < 4) continue;
    const xy = rawLine.slice(0, 2);
    const filePath = rawLine.slice(3).trim();
    if (!filePath) continue;
    changedFiles.push({
      path: filePath,
      status: formatPorcelainStatus(xy)
    });
  }

  return {
    branch,
    headSha,
    headSubject,
    isClean: changedFiles.length === 0,
    changedFiles
  };
}

function formatPorcelainStatus(xy: string): string {
  if (xy === '??') return 'untracked';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  if (xy.includes('R')) return 'renamed';
  return 'modified';
}

export async function getGitWorkingDiff(projectRoot: string): Promise<{
  status: GitRepoStatus;
  diff: string;
}> {
  const status = await getGitRepoStatus(projectRoot);
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return { status, diff: '' };
  }

  let trackedDiff = '';
  try {
    trackedDiff = await runGit(projectRoot, ['diff', 'HEAD', '--']);
  } catch {
    trackedDiff = await runGit(projectRoot, ['diff', '--']);
  }

  const untrackedSnippets: string[] = [];
  for (const file of status.changedFiles) {
    if (file.status === 'untracked') {
      const abs = path.join(projectRoot, file.path);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const raw = fs.readFileSync(abs, 'utf8').slice(0, 8000);
        const plusLines = raw
          .split('\n')
          .map((line) => `+${line}`)
          .join('\n');
        untrackedSnippets.push(
          `diff --git a/${file.path} b/${file.path}\nnew file (untracked)\n--- /dev/null\n+++ b/${file.path}\n${plusLines}`
        );
      }
    }
  }

  const combined = [trackedDiff.trimEnd(), ...untrackedSnippets].filter(Boolean).join('\n\n');
  return {
    status,
    diff: combined
  };
}

export function formatCommitMessageWithTrailer(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    throw new Error('Commit message cannot be empty.');
  }
  if (trimmed.includes(OPENBOT_TRAILER)) {
    return `${trimmed}\n`;
  }
  return `${trimmed}\n\n${OPENBOT_TRAILER}\n`;
}

export async function commitWorkingTree(
  projectRoot: string,
  message: string,
  authorName = 'Workspace Author',
  authorEmail = 'author@local.invalid'
): Promise<{ sha: string; subject: string; status: GitRepoStatus }> {
  const before = await getGitRepoStatus(projectRoot);
  if (before.isClean) {
    throw new Error('Working tree has no uncommitted changes to commit.');
  }

  const formattedMessage = formatCommitMessageWithTrailer(message);
  await runGit(projectRoot, ['add', '-A']);
  await runGit(projectRoot, [
    '-c',
    `user.name=${authorName}`,
    '-c',
    `user.email=${authorEmail}`,
    'commit',
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
