import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitChangedFile, ProjectGitStatus } from '../shared/types.js';
import { validCheckoutFile, validProjectFile, type EnrolledProject } from './enrollment.js';
import { GitRpcError, isGitSha, type GitUpdateResult, type ProposalContext, type ProposalService } from './gitProtocol.js';
import { hasWorkingTree, unavailableGitStatus } from './projectRegistry.js';
import { createLogger, sanitizeLogText } from './logger.js';

const log = createLogger('focuswiki-git');
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_GIT_STDERR = 4 * 1024;
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

function parseForgejoHttpProxy(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new GitRpcError('git_unavailable', 'FOCUSWIKI_FORGEJO_PROXY must be a valid HTTP proxy URL.');
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== '/' || !parsed.hostname) {
    throw new GitRpcError('git_unavailable', 'FOCUSWIKI_FORGEJO_PROXY must be an http://host:port URL without credentials or path.');
  }
  return parsed.origin;
}

function parseForgejoCaFile(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!path.isAbsolute(trimmed) || path.normalize(trimmed) !== trimmed || Buffer.byteLength(trimmed, 'utf8') > 512) {
    throw new GitRpcError('git_unavailable', 'FOCUSWIKI_FORGEJO_CA_FILE must be a normalized absolute path.');
  }
  return trimmed;
}

interface GitFetchAuth {
  token: string;
  remote: string;
}

function runGit(cwd: string, args: string[], signal: AbortSignal, auth?: GitFetchAuth): Promise<string> {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(auth ? 45_000 : 10_000)]);
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
  if (auth !== undefined) {
    if (!/^[!-~]{1,4096}$/.test(auth.token)) throw new GitRpcError('git_unavailable');
    let origin: string;
    try {
      const parsed = new URL(auth.remote);
      if (parsed.protocol !== 'https:' || !parsed.hostname) throw new Error();
      origin = parsed.origin.toLowerCase();
    } catch {
      throw new GitRpcError('git_unavailable');
    }
    const configPairs: Array<[string, string]> = [[
      `http.${origin}/.extraHeader`,
      'Authorization: Basic ' + Buffer.from('x-access-token:' + auth.token).toString('base64')
    ]];
    if (origin !== 'https://github.com') {
      const proxy = parseForgejoHttpProxy(process.env.FOCUSWIKI_FORGEJO_PROXY);
      if (proxy) configPairs.push([`http.${origin}/.proxy`, proxy]);
      const caFile = parseForgejoCaFile(process.env.FOCUSWIKI_FORGEJO_CA_FILE);
      if (caFile) configPairs.push([`http.${origin}/.sslCAInfo`, caFile]);
    }
    env.GIT_CONFIG_COUNT = String(configPairs.length);
    configPairs.forEach(([key, value], idx) => {
      env[`GIT_CONFIG_KEY_${idx}`] = key;
      env[`GIT_CONFIG_VALUE_${idx}`] = value;
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_PATH, [...gitConfig.flatMap((value) => ['-c', value]), ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let bytes = 0;
    let errBytes = 0;
    let failed = false;
    let spawnError: string | undefined;
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
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_GIT_STDERR) return;
      const slice = errBytes + chunk.length > MAX_GIT_STDERR ? chunk.subarray(0, MAX_GIT_STDERR - errBytes) : chunk;
      errChunks.push(slice);
      errBytes += slice.length;
    });
    child.on('error', (err) => {
      failed = true;
      spawnError = err.message;
    });
    child.on('close', (code) => {
      deadline.removeEventListener('abort', kill);
      const stderrText = errBytes ? sanitizeLogText(Buffer.concat(errChunks, errBytes).toString('utf8'), 240) : '';
      if (deadline.aborted) {
        reject(new GitRpcError('git_timeout', `git ${args[0] ?? 'command'} timed out`));
      } else if (failed || code !== 0) {
        const detail = spawnError
          ? `git ${args[0] ?? 'command'} spawn failed: ${sanitizeLogText(spawnError, 200)}`
          : `git exit ${code ?? 'signal'}${stderrText ? `: ${stderrText}` : ''}`;
        reject(new GitRpcError('git_operation_failed', detail));
      } else {
        resolve(Buffer.concat(chunks, bytes).toString('utf8'));
      }
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
  private lastErrorKey?: string;
  private lastErrorMessage?: string;
  private wasReady = false;
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

    let phase = 'refresh';
    try {
      if (exists(this.metadataDir) && this.canResetUninstalledBinding()) {
        phase = 'init';
        log.info('Resetting uninstalled repository binding to match updated enrollment', {
          project: this.project.id,
          branch: this.context.branch,
          remote: this.context.remote
        });
        fs.rmSync(this.metadataDir, { recursive: true, force: true });
        if (exists(this.workingStage)) {
          workerDirectory(this.workingStage, true);
          fs.rmSync(this.workingStage, { recursive: true, force: true });
        }
      }
      if (!exists(this.metadataDir)) {
        // An existing tree may contain uncommitted work or legacy Git metadata. Never adopt it.
        if (exists(this.context.workTree)) {
          throw new GitRpcError('git_not_ready', `Refusing to adopt existing directory at ${this.context.workTree}`);
        }
        if (!this.proposal || !fetchDue) {
          if (!this.proposal) {
            this.logError('config', 'Proposal service is unavailable; cannot fetch repository.');
          }
          this.fetchState = this.proposal ? this.fetchState : 'unavailable';
          this.recordUnavailable(this.fetchState === 'unavailable' ? 'unavailable' : 'pending');
          return;
        }
        phase = 'init';
        await this.initialize(signal);
      }
      phase = 'binding';
      this.checkBinding();

      if (!exists(this.installedFile) && !fetchDue) {
        this.recordUnavailable(this.fetchState === 'unavailable' ? 'unavailable' : 'pending');
        return;
      }
      if (exists(this.installedFile)) {
        phase = 'install';
        this.finishInstall(signal);
        phase = 'inspect';
        await this.inspect(signal);
      }

      if (fetchDue) {
        let fetchPhase = 'token';
        try {
          await this.fetchRemote(signal, (nextPhase) => { fetchPhase = nextPhase; });
        } catch (err) {
          this.fetchState = 'unavailable';
          this.logError(fetchPhase, describeError(err));
        }

        if (this.fetchState === 'current' && !exists(this.installedFile)) {
          phase = 'checkout';
          await this.prepareCheckout(signal);
          phase = 'install';
          this.finishInstall(signal);
        } else if (this.fetchState === 'current' && exists(this.installedFile)) {
          try {
            await this.fastForward(signal);
          } catch (err) {
            if (err instanceof GitRpcError && err.code === 'git_dirty_worktree') {
              log.debug('Skipped auto fast-forward because working tree has local changes', { project: this.project.id });
            } else {
              this.logError('fast-forward', describeError(err));
            }
          }
        }
        if (exists(this.installedFile)) {
          phase = 'inspect';
          await this.inspect(signal);
        } else {
          this.recordUnavailable(this.fetchState === 'unavailable' ? 'unavailable' : 'pending');
        }
      }
    } catch (err) {
      this.logError(phase, describeError(err));
      this.recordUnavailable('unavailable');
    }
  }

  /** Fetches upstream immediately and fast-forwards the working tree if clean. */
  async update(signal: AbortSignal): Promise<GitUpdateResult> {
    this.proposalContext();
    this.nextFetch = Date.now() + FETCH_RETRY_MS;
    this.nextStatus = Date.now() + STATUS_INTERVAL_MS;
    let fetchPhase = 'token';
    try {
      await this.fetchRemote(signal, (nextPhase) => { fetchPhase = nextPhase; });
    } catch (err) {
      this.fetchState = 'unavailable';
      this.logError(fetchPhase, describeError(err));
      await this.inspect(signal).catch(() => {});
      if (err instanceof GitRpcError) throw err;
      throw new GitRpcError('git_unavailable', describeError(err));
    }
    const result = await this.fastForward(signal);
    await this.inspect(signal);
    return { ...result, status: this.status };
  }

  private async fetchRemote(signal: AbortSignal, onPhase?: (phase: string) => void): Promise<void> {
    onPhase?.('token');
    if (!this.proposal) throw new GitRpcError('git_unavailable', 'Proposal service is unavailable.');
    // The token provider validates an existing worktree. Before provisioning,
    // give it the empty private stage and keep the enrolled path unpublished.
    const workTree = exists(this.installedFile) ? this.context.workTree : this.workingStage;
    if (workTree === this.workingStage) {
      if (!exists(workTree)) fs.mkdirSync(workTree, { mode: 0o700 });
      workerDirectory(workTree, true);
    }
    const token = await this.proposal.getRepoToken({ ...this.context, workTree, branch: 'focuswiki/bootstrap' }, 'read');
    signal.throwIfAborted();
    onPhase?.('fetch');
    await this.git([
      'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance',
      '--', this.context.remote, `+${this.localRef}:${this.remoteRef}`
    ], signal, { token, remote: this.context.remote });
    this.fetchedAt = new Date().toISOString();
    this.fetchState = 'current';
    this.lastErrorMessage = undefined;
    log.debug('Fetched remote branch', { project: this.project.id, branch: this.context.branch });
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

  private canResetUninstalledBinding(): boolean {
    if (exists(this.installedFile) || exists(this.context.workTree)) return false;
    workerDirectory(this.metadataDir, true);
    try {
      if (fs.readFileSync(path.join(this.metadataDir, 'binding.json'), 'utf8') !== this.binding) return true;
      if (fs.readFileSync(path.join(this.context.gitDir, 'HEAD'), 'utf8') !== `ref: ${this.localRef}\n`) return true;
      return false;
    } catch {
      return true;
    }
  }

  private describeBindingMismatch(rawBinding: string): string {
    try {
      const bound = JSON.parse(rawBinding) as { remote?: unknown; branch?: unknown };
      const boundRemote = typeof bound?.remote === 'string' ? bound.remote : undefined;
      const boundBranch = typeof bound?.branch === 'string' ? bound.branch : undefined;
      if (boundRemote && boundBranch) {
        const remoteDiff = boundRemote !== this.context.remote;
        const branchDiff = boundBranch !== this.context.branch;
        if (branchDiff && !remoteDiff) {
          return `Existing checkout is bound to branch "${boundBranch}", not "${this.context.branch}". Use a new project id or remove ${this.metadataDir}.`;
        }
        if (remoteDiff && !branchDiff) {
          return `Existing checkout is bound to ${boundRemote}, not ${this.context.remote}. Use a new project id or remove ${this.metadataDir}.`;
        }
        if (remoteDiff && branchDiff) {
          return `Existing checkout is bound to ${boundRemote} (${boundBranch}), not ${this.context.remote} (${this.context.branch}). Use a new project id or clear git-state.`;
        }
      }
    } catch {
      // Fall through to generic mismatch error.
    }
    return `Managed checkout binding in ${this.metadataDir} does not match current enrollment.`;
  }

  private checkBinding(): void {
    workerDirectory(this.metadataDir, true);
    let rawBinding: string;
    try {
      rawBinding = fs.readFileSync(path.join(this.metadataDir, 'binding.json'), 'utf8');
    } catch {
      throw new GitRpcError('git_not_ready', `Managed checkout binding file is missing in ${this.metadataDir}.`);
    }
    if (rawBinding !== this.binding) {
      throw new GitRpcError('git_not_ready', this.describeBindingMismatch(rawBinding));
    }
    const gitDir = fs.lstatSync(this.context.gitDir);
    if (!gitDir.isDirectory() || gitDir.uid !== process.geteuid!() || (gitDir.mode & 0o022)) {
      throw new GitRpcError('git_not_ready', 'Managed Git metadata directory has unsafe ownership or permissions.');
    }
    let head: string;
    try {
      head = fs.readFileSync(path.join(this.context.gitDir, 'HEAD'), 'utf8');
    } catch {
      throw new GitRpcError('git_not_ready', `Managed Git HEAD file is missing in ${this.context.gitDir}.`);
    }
    if (head !== `ref: ${this.localRef}\n`) {
      throw new GitRpcError(
        'git_not_ready',
        `Managed Git HEAD (${head.trim() || '<empty>'}) does not match enrolled branch ref (ref: ${this.localRef}).`
      );
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

  private git(args: string[], signal: AbortSignal, auth?: GitFetchAuth, workTree = this.context.workTree): Promise<string> {
    return runGit(this.metadataDir, [
      `--git-dir=${this.context.gitDir}`, `--work-tree=${workTree}`, ...args
    ], signal, auth);
  }

  private async validateTree(head: string, signal: AbortSignal): Promise<string[]> {
    const tree = await this.git(['ls-tree', '-r', '-z', head], signal);
    const paths: string[] = [];
    for (const entry of tree.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const entryPath = tab >= 0 ? entry.slice(tab + 1) : '';
      if (!/^100(?:644|755) blob /.test(entry) || tab < 0 || !validCheckoutFile(entryPath)) {
        const mode = entry.split(' ', 2)[0] || 'unknown';
        throw new GitRpcError('git_not_ready', `Rejected tree entry (mode=${mode}, path=${entryPath || '<invalid>'})`);
      }
      paths.push(entryPath);
    }
    return paths;
  }

  private async assertNoIgnoredCollision(
    localHead: string,
    remoteHead: string,
    remotePaths: string[],
    signal: AbortSignal
  ): Promise<void> {
    const remoteFileSet = new Set(remotePaths);
    const remoteDirSet = new Set<string>();
    for (const rel of remotePaths) {
      let slash = rel.indexOf('/');
      while (slash !== -1) {
        remoteDirSet.add(rel.slice(0, slash));
        slash = rel.indexOf('/', slash + 1);
      }
    }

    const ignoredRaw = await this.git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], signal);
    for (const ignoredPath of ignoredRaw.split('\0').filter(Boolean)) {
      if (remoteFileSet.has(ignoredPath)) {
        throw new GitRpcError('git_dirty_worktree', `Upstream update would overwrite ignored path "${ignoredPath}".`);
      }
      if (remoteDirSet.has(ignoredPath)) {
        throw new GitRpcError('git_dirty_worktree', `Upstream update conflicts with ignored file "${ignoredPath}".`);
      }
      let slash = ignoredPath.indexOf('/');
      while (slash !== -1) {
        const prefix = ignoredPath.slice(0, slash);
        if (remoteFileSet.has(prefix)) {
          throw new GitRpcError('git_dirty_worktree', `Upstream update would replace ignored directory "${prefix}".`);
        }
        slash = ignoredPath.indexOf('/', slash + 1);
      }
    }

    // Also guard against empty ignored directories or other colliding entries at newly added paths.
    const addedRaw = await this.git([
      'diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=A', localHead, remoteHead
    ], signal);
    for (const addedPath of addedRaw.split('\0').filter(Boolean)) {
      if (exists(path.join(this.context.workTree, addedPath))) {
        throw new GitRpcError('git_dirty_worktree', `Upstream path "${addedPath}" collides with an existing local entry.`);
      }
      let slash = addedPath.indexOf('/');
      while (slash !== -1) {
        const prefix = addedPath.slice(0, slash);
        const stat = fs.lstatSync(path.join(this.context.workTree, prefix), { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) {
          throw new GitRpcError('git_dirty_worktree', `Upstream path "${addedPath}" collides with local file "${prefix}".`);
        }
        slash = addedPath.indexOf('/', slash + 1);
      }
    }
  }

  private async fastForward(signal: AbortSignal): Promise<{ updated: boolean; previousSha: string; headSha: string }> {
    const localHead = (await this.git(['rev-parse', '--verify', this.localRef + '^{commit}'], signal)).trim();
    const remoteHead = (await this.git(['rev-parse', '--verify', this.remoteRef + '^{commit}'], signal)).trim();
    if (!isGitSha(localHead) || !isGitSha(remoteHead)) {
      throw new GitRpcError('git_not_ready', 'Could not resolve local or remote branch commit.');
    }
    if (localHead === remoteHead) {
      return { updated: false, previousSha: localHead, headSha: localHead };
    }

    try {
      await this.git(['update-index', '-q', '--refresh'], signal);
    } catch {
      throw new GitRpcError('git_dirty_worktree', 'Working copy has local changes.');
    }
    const porcelain = await this.git([
      'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=all'
    ], signal);
    if (porcelain.length > 0) {
      throw new GitRpcError('git_dirty_worktree', 'Working copy has local changes.');
    }

    try {
      await this.git(['merge-base', '--is-ancestor', localHead, remoteHead], signal);
    } catch {
      throw new GitRpcError('git_not_fast_forward', `Local ${localHead.slice(0, 12)} is not an ancestor of remote ${remoteHead.slice(0, 12)}.`);
    }

    const remotePaths = await this.validateTree(remoteHead, signal);
    await this.assertNoIgnoredCollision(localHead, remoteHead, remotePaths, signal);
    signal.throwIfAborted();
    try {
      await this.git(['read-tree', '-m', '-u', localHead, remoteHead], signal);
    } catch (err) {
      // read-tree refuses to overwrite concurrently modified or colliding untracked files.
      throw new GitRpcError('git_dirty_worktree', describeError(err));
    }
    await this.git(['update-ref', this.localRef, remoteHead, localHead], signal);
    log.info('Fast-forwarded managed repository', {
      project: this.project.id,
      branch: this.context.branch,
      from: localHead.slice(0, 12),
      to: remoteHead.slice(0, 12)
    });
    return { updated: true, previousSha: localHead, headSha: remoteHead };
  }

  private async prepareCheckout(signal: AbortSignal): Promise<void> {
    if (exists(this.context.workTree)) {
      throw new GitRpcError('git_not_ready', `Worktree already exists at ${this.context.workTree}`);
    }
    const head = (await this.git(['rev-parse', '--verify', this.remoteRef + '^{commit}'], signal)).trim();
    if (!isGitSha(head)) throw new GitRpcError('git_not_ready', `Remote ref ${this.remoteRef} did not resolve to a commit.`);
    await this.validateTree(head, signal);

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
      behind,
      ...(this.lastErrorMessage ? { lastError: this.lastErrorMessage } : {})
    };
    if (!this.wasReady || (this.fetchState === 'current' && !this.lastErrorMessage && this.lastErrorKey)) {
      log.info('Managed repository ready', {
        project: this.project.id,
        branch: this.context.branch,
        head: headSha.slice(0, 12),
        fetchState: this.fetchState
      });
    }
    this.wasReady = true;
    if (this.fetchState === 'current' && !this.lastErrorMessage) this.lastErrorKey = undefined;
  }

  private logError(phase: string, reason: string): void {
    const sanitizedReason = sanitizeLogText(reason, 240);
    this.lastErrorMessage = sanitizeLogText(`[${phase}] ${sanitizedReason}`, 260);
    const key = `${phase}:${sanitizedReason}`;
    if (this.lastErrorKey === key) return;
    this.lastErrorKey = key;
    log.warn('Managed repository sync failed', {
      project: this.project.id,
      branch: this.context.branch,
      remote: this.context.remote,
      phase,
      reason: sanitizedReason
    });
  }

  private recordUnavailable(state: 'pending' | 'unavailable'): void {
    if (state === 'unavailable') this.wasReady = false;
    this.status = {
      ...unavailableGitStatus(this.project, state),
      fetchState: this.fetchState,
      fetchedAt: this.fetchedAt,
      ...(this.lastErrorMessage ? { lastError: this.lastErrorMessage } : {})
    };
  }
}

function describeError(err: unknown): string {
  if (err instanceof GitRpcError) {
    return sanitizeLogText(err.detail ? `${err.code}: ${err.detail}` : `${err.code}: ${err.message}`, 240);
  }
  if (err instanceof Error) return sanitizeLogText(err.message || err.name, 240);
  return 'Unknown error';
}
