import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitChangedFile, ProjectGitStatus } from '../shared/types.js';
import { validCheckoutFile, validProjectFile, type EnrolledProject } from './enrollment.js';
import { GitRpcError, isGitSha, type ProposalContext, type ProposalService } from './gitProtocol.js';
import { hasWorkingTree, unavailableGitStatus } from './projectRegistry.js';

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_CHANGED_FILES = 100;
const FETCH_RETRY_MS = 60_000;
const STATUS_INTERVAL_MS = 5_000;
const GIT_PATH = '/usr/bin/git';

const gitConfig = [
  'core.hooksPath=/dev/null',
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'core.fsmonitor=false',
  'credential.helper=',
  'http.followRedirects=false',
  'protocol.allow=never',
  'protocol.https.allow=always',
  'fetch.recurseSubmodules=false',
  'gc.auto=0',
  'maintenance.auto=false'
];

function runGit(cwd: string, args: string[], signal: AbortSignal, token?: string): Promise<string> {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(token ? 45_000 : 10_000)]);
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/nonexistent',
    LC_ALL: 'C',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1'
  };
  if (token !== undefined) {
    if (!/^[!-~]{1,4096}$/.test(token)) throw new GitRpcError('git_unavailable');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraHeader';
    env.GIT_CONFIG_VALUE_0 = 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_PATH, [...gitConfig.flatMap((value) => ['-c', value]), ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const kill = () => {
      failed = true;
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
    };
    deadline.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT) kill();
      else chunks.push(chunk);
    });
    child.on('error', () => { failed = true; });
    child.on('close', (code) => {
      deadline.removeEventListener('abort', kill);
      if (deadline.aborted) reject(new GitRpcError('git_timeout'));
      else if (failed || code !== 0) reject(new GitRpcError('git_operation_failed'));
      else resolve(Buffer.concat(chunks, bytes).toString('utf8'));
    });
  });
}

function statusEntry(entry: string): GitChangedFile {
  const kind = entry.slice(0, 2);
  const status = kind === '??' ? 'untracked' :
    kind.includes('D') ? 'deleted' :
    kind.includes('A') ? 'added' : 'modified';
  return { path: entry.slice(3), status };
}

function exists(file: string): boolean {
  return !!fs.lstatSync(file, { throwIfNoEntry: false });
}

export function workerDirectory(dir: string, privateDir = false): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || fs.realpathSync(dir) !== dir ||
      stat.uid !== process.geteuid!() || (stat.mode & (privateDir ? 0o077 : 0o022))) {
    throw new Error('Worker directory has unsafe ownership, permissions or location.');
  }
}

export class ManagedRepository {
  private nextStatus = 0;
  private nextFetch = 0;
  private fetchedAt?: string;
  private fetchState: ProjectGitStatus['fetchState'] = 'pending';
  private readonly context: ProposalContext;
  private readonly metadataDir: string;
  private readonly workingStage: string;
  status: ProjectGitStatus;

  constructor(private readonly project: EnrolledProject, private readonly reposDir: string,
              stateDir: string, private readonly proposal?: ProposalService) {
    this.status = unavailableGitStatus(project, 'pending');
    this.metadataDir = path.join(stateDir, project.id);
    this.workingStage = path.join(reposDir, '.staging', project.id);
    this.context = {
      projectId: project.id,
      workTree: path.join(reposDir, project.id),
      gitDir: path.join(this.metadataDir, 'git'),
      remote: project.remote,
      branch: project.branch
    };
  }

  get due(): boolean {
    return Date.now() >= Math.min(this.nextStatus, this.nextFetch);
  }

  proposalContext(): ProposalContext {
    // Recheck the paths at dispatch. A cached status never authorizes a proposal.
    this.checkBinding();
    if (!exists(this.installedFile) || exists(this.workingStage) || !hasWorkingTree(this.context.workTree)) {
      throw new GitRpcError('git_not_ready');
    }
    return { ...this.context };
  }

  async refresh(signal: AbortSignal): Promise<void> {
    this.nextStatus = Date.now() + STATUS_INTERVAL_MS;
    const fetchDue = Date.now() >= this.nextFetch;
    if (fetchDue) this.nextFetch = Date.now() + FETCH_RETRY_MS;

    try {
      if (!exists(this.metadataDir)) {
        // An existing tree may contain uncommitted work or legacy Git metadata. Never adopt it.
        if (exists(this.context.workTree)) throw new GitRpcError('git_not_ready');
        if (!this.proposal || !fetchDue) {
          this.fetchState = this.proposal ? this.fetchState : 'unavailable';
          this.recordUnavailable(this.fetchState === 'unavailable' ? 'unavailable' : 'pending');
          return;
        }
        await this.initialize(signal);
      }
      this.checkBinding();

      if (!exists(this.installedFile) && !fetchDue) {
        this.recordUnavailable(this.fetchState === 'unavailable' ? 'unavailable' : 'pending');
        return;
      }
      if (exists(this.installedFile)) {
        this.finishInstall(signal);
        await this.inspect(signal);
      }

      if (fetchDue) {
        try {
          if (!this.proposal) throw new GitRpcError('git_unavailable');
          // The token provider validates an existing worktree. Before provisioning,
          // give it the empty private stage and keep the enrolled path unpublished.
          const workTree = exists(this.installedFile) ? this.context.workTree : this.workingStage;
          if (workTree === this.workingStage) {
            if (!exists(workTree)) fs.mkdirSync(workTree, { mode: 0o700 });
            workerDirectory(workTree, true);
          }
          const token = await this.proposal.getRepoToken({ ...this.context, workTree, branch: 'focuswiki/bootstrap' }, 'read');
          signal.throwIfAborted();
          await this.git([
            'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance',
            '--', this.context.remote, `+${this.localRef}:${this.remoteRef}`
          ], signal, token);
          this.fetchedAt = new Date().toISOString();
          this.fetchState = 'current';
        } catch {
          this.fetchState = 'unavailable';
        }

        if (this.fetchState === 'current' && !exists(this.installedFile)) {
          await this.prepareCheckout(signal);
          this.finishInstall(signal);
        }
        if (exists(this.installedFile)) await this.inspect(signal);
        else this.recordUnavailable(this.fetchState === 'unavailable' ? 'unavailable' : 'pending');
      }
    } catch {
      this.recordUnavailable('unavailable');
    }
  }

  private get binding(): string {
    return JSON.stringify({ remote: this.context.remote, branch: this.context.branch });
  }

  private get installedFile(): string {
    return path.join(this.metadataDir, 'checkout-prepared');
  }

  private get localRef(): string {
    return `refs/heads/${this.context.branch}`;
  }

  private get remoteRef(): string {
    return `refs/remotes/origin/${this.context.branch}`;
  }

  private checkBinding(): void {
    workerDirectory(this.metadataDir, true);
    if (fs.readFileSync(path.join(this.metadataDir, 'binding.json'), 'utf8') !== this.binding) {
      throw new GitRpcError('git_not_ready');
    }
    const gitDir = fs.lstatSync(this.context.gitDir);
    if (!gitDir.isDirectory() || gitDir.uid !== process.geteuid!() || (gitDir.mode & 0o022) ||
        fs.readFileSync(path.join(this.context.gitDir, 'HEAD'), 'utf8') !== `ref: ${this.localRef}\n`) {
      throw new GitRpcError('git_not_ready');
    }
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    const stateDir = path.dirname(this.metadataDir);
    const tmp = fs.mkdtempSync(path.join(stateDir, '.init-'));
    try {
      const gitDir = path.join(tmp, 'git');
      await runGit(tmp, ['init', '--bare', '--template=', `--initial-branch=${this.context.branch}`, gitDir], signal);
      fs.chmodSync(gitDir, 0o700);
      for (const [key, value] of [
        ['core.bare', 'false'],
        ['core.worktree', this.context.workTree],
        ['remote.origin.url', this.context.remote],
        ['user.name', 'FocusWiki'],
        ['user.email', 'focuswiki@local.invalid']
      ]) {
        await runGit(tmp, ['config', '--file', path.join(gitDir, 'config'), key, value], signal);
      }
      fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'info/exclude'), '/.focuswiki/\n/.cairn/\n', { flag: 'wx' });
      fs.writeFileSync(path.join(tmp, 'binding.json'), this.binding, { flag: 'wx' });
      signal.throwIfAborted();
      fs.renameSync(tmp, this.metadataDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private git(args: string[], signal: AbortSignal, token?: string, workTree = this.context.workTree): Promise<string> {
    return runGit(this.metadataDir, [
      `--git-dir=${this.context.gitDir}`, `--work-tree=${workTree}`, ...args
    ], signal, token);
  }

  private async prepareCheckout(signal: AbortSignal): Promise<void> {
    if (exists(this.context.workTree)) throw new GitRpcError('git_not_ready');
    const head = (await this.git(['rev-parse', '--verify', this.remoteRef + '^{commit}'], signal)).trim();
    if (!isGitSha(head)) throw new GitRpcError('git_not_ready');
    const tree = await this.git(['ls-tree', '-r', '-z', head], signal);
    for (const entry of tree.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (!/^100(?:644|755) blob /.test(entry) || tab < 0 || !validCheckoutFile(entry.slice(tab + 1))) {
        throw new GitRpcError('git_not_ready');
      }
    }

    // Only our private staging directory may be discarded on a failed initial checkout.
    fs.rmSync(this.workingStage, { recursive: true, force: true });
    fs.mkdirSync(this.workingStage, { mode: 0o700 });
    await this.git(['read-tree', head], signal, undefined, this.workingStage);
    await this.git(['checkout-index', '--all'], signal, undefined, this.workingStage);
    await this.git(['update-ref', this.localRef, head], signal, undefined, this.workingStage);
    signal.throwIfAborted();
    fs.writeFileSync(this.installedFile, '', { flag: 'wx', mode: 0o600 });
  }

  private finishInstall(signal: AbortSignal): void {
    if (exists(this.workingStage)) {
      signal.throwIfAborted();
      if (exists(this.context.workTree)) throw new GitRpcError('git_not_ready');
      fs.chmodSync(this.workingStage, 0o770);
      fs.renameSync(this.workingStage, this.context.workTree);
    }
    if (!hasWorkingTree(this.context.workTree)) throw new GitRpcError('git_not_ready');
  }

  private async inspect(signal: AbortSignal): Promise<void> {
    const head = (await this.git(['log', '-1', '--format=%H%x00%s', this.localRef], signal)).trimEnd();
    const [headSha, headSubject] = head.split('\0');
    if (!isGitSha(headSha)) throw new GitRpcError('git_not_ready');
    const porcelain = await this.git([
      'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=all'
    ], signal);
    const files = porcelain.split('\0').filter(Boolean);
    // Tracking counts are only a claim about an existing fetched ref, with fetch freshness shown separately.
    const graph = await this.git(['rev-list', '--left-right', '--count', `${this.localRef}...${this.remoteRef}`], signal);
    const [ahead, behind] = graph.trim().split(/\s+/).map(Number);
    this.status = {
      state: 'ready',
      checkedAt: new Date().toISOString(),
      branch: this.context.branch,
      remoteUrl: this.context.remote,
      remoteName: 'origin',
      headSha,
      headSubject: Buffer.from(headSubject ?? '').subarray(0, 512).toString('utf8'),
      isClean: files.length === 0,
      changedFiles: files.filter((entry) => validProjectFile(entry.slice(3))).slice(0, MAX_CHANGED_FILES).map(statusEntry),
      changesTruncated: files.length > MAX_CHANGED_FILES || files.some((entry) => !validProjectFile(entry.slice(3))),
      fetchState: this.fetchState,
      fetchedAt: this.fetchedAt,
      ahead,
      behind
    };
  }

  private recordUnavailable(state: 'pending' | 'unavailable'): void {
    this.status = {
      ...unavailableGitStatus(this.project, state),
      fetchState: this.fetchState,
      fetchedAt: this.fetchedAt
    };
  }
}
