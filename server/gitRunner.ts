import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  directoriesOverlap, enrollmentBinding, isLocalProject, loadEnrollmentEntries, watchEnrollmentFile,
  type EnrolledProject, type EnrollmentEntry
} from './enrollment.js';
import {
  DEFAULT_GIT_SOCKET, GitRpcError, MAX_GIT_REQUEST_BYTES, MAX_GIT_RESPONSE_BYTES, isGitSha,
  parseGitRequest, proposalBranch, unwrapReviewId, type GitRequest, type GitResult, type ProposalService, type PublishedProposal
} from './gitProtocol.js';
import { GitQueue } from './gitQueue.js';
import { createLogger, sanitizeLogText } from './logger.js';
import { ManagedRepository, workerDirectory } from './managedGit.js';

const log = createLogger('focuswiki-git');
const MAX_CONNECTIONS = 32;
const REQUEST_READ_TIMEOUT = 2_000;

async function loadProposalService(): Promise<ProposalService | undefined> {
  try {
    // Resolve the real companion at runtime so the core worker can also build independently.
    const mod = await import(new URL('./proposalService.js', import.meta.url).href);
    if (typeof mod.reviewProposal === 'function' && typeof mod.publishProposal === 'function' &&
        typeof mod.getRepoToken === 'function') return mod;
    log.warn('Proposal service module loaded without required exports');
  } catch (err) {
    // Dependency failures must not fall back to legacy Git or credential handling.
    log.warn('Failed to load proposal service module', {
      reason: err instanceof Error ? err.message : 'Unknown error'
    });
  }
}

function proposalFailure(error: unknown): GitRpcError {
  if (error instanceof GitRpcError) return error;
  const item = error as { status?: unknown; statusCode?: unknown } | null;
  const status = item?.statusCode ?? item?.status;
  if (status === 409) return new GitRpcError('proposal_conflict');
  if (status === 400 || status === 422) return new GitRpcError('proposal_rejected');
  if (status === 401 || status === 403 || status === 503) return new GitRpcError('proposal_unavailable');
  return new GitRpcError('git_operation_failed');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePublished(result: PublishedProposal, remote: string): PublishedProposal {
  const url = typeof result?.url === 'string' ? result.url : '';
  if (remote.startsWith('https://github.com/')) {
    const target = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d{0,19})$/.exec(url);
    const slug = remote.slice('https://github.com/'.length, -4);
    if (!target || target[0] !== url || target[1].toLowerCase() !== slug || !isGitSha(result.sha)) {
      throw new GitRpcError('git_operation_failed');
    }
    return { url, sha: result.sha };
  }
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new GitRpcError('git_operation_failed');
  }
  if (parsed.protocol !== 'https:' || !parsed.pathname.endsWith('.git')) {
    throw new GitRpcError('git_operation_failed');
  }
  const origin = parsed.origin.toLowerCase();
  const slug = parsed.pathname.slice(1, -4).toLowerCase();
  const target = new RegExp(`^${escapeRegExp(origin)}/([^/]+/[^/]+)/pulls/([1-9]\\d{0,19})$`).exec(url);
  if (!target || target[0] !== url || target[1].toLowerCase() !== slug || !isGitSha(result.sha)) {
    throw new GitRpcError('git_operation_failed');
  }
  return { url, sha: result.sha };
}

async function prepareWorkerSocket(socketPath: string): Promise<void> {
  const existing = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!existing) return;
  const uid = process.geteuid?.();
  if (!existing.isSocket() || (uid !== undefined && existing.uid !== uid)) {
    throw new Error('Invalid existing Git worker socket path.');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(1000, () => socket.destroy(new Error('Timed out checking the existing Git worker socket.')));
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('Another process is listening on FOCUSWIKI_GIT_SOCKET.'));
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') resolve();
      else reject(err);
    });
  });
  const current = fs.lstatSync(socketPath);
  if (current.dev !== existing.dev || current.ino !== existing.ino) {
    throw new Error('Git worker socket changed during startup.');
  }
  fs.unlinkSync(socketPath);
}

export async function startGitRunner(options: {
  enrollmentFile: string;
  reposDir: string;
  stateDir: string;
  socketPath: string;
  proposalService?: ProposalService;
  enrollmentDebounceMs?: number;
}): Promise<{ close(): Promise<void> }> {
  const socketPath = path.resolve(options.socketPath);
  const socketDir = path.dirname(socketPath);
  const reposDir = path.resolve(options.reposDir);
  const stateDir = path.resolve(options.stateDir);
  const roots = [reposDir, stateDir, socketDir];
  const checkEnrollmentPath = () => {
    const resolved = fs.realpathSync(options.enrollmentFile);
    if (roots.some((root) => directoriesOverlap(root, resolved))) {
      throw new Error('Git state, working files, runtime socket and enrollment must use separate paths.');
    }
  };
  if (roots.some((root, index) => roots.slice(index + 1).some((other) => directoriesOverlap(root, other)))) {
    throw new Error('Git state, working files, runtime socket and enrollment must use separate paths.');
  }
  checkEnrollmentPath();
  workerDirectory(stateDir, true);
  workerDirectory(reposDir);
  workerDirectory(socketDir);
  await prepareWorkerSocket(socketPath);
  const allEntries = loadEnrollmentEntries(options.enrollmentFile);
  const stageRoot = path.join(reposDir, '.staging');
  if (!fs.existsSync(stageRoot)) fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  workerDirectory(stageRoot, true);

  const proposal = options.proposalService ?? await loadProposalService();
  const bindings = new Map<string, string>();
  const projects = new Map<string, ManagedRepository>();
  const queue = new GitQueue();

  function reconcileEnrollment(nextEntries: EnrollmentEntry[]): {
    enrolled: EnrolledProject[];
    localCount: number;
    added: number;
    removed: number;
    rebound: number;
  } {
    const enrolled = nextEntries.filter((entry): entry is EnrolledProject => !isLocalProject(entry));
    const localCount = nextEntries.length - enrolled.length;
    const nextIds = new Set(enrolled.map((project) => project.id));
    let added = 0;
    let removed = 0;
    let rebound = 0;

    for (const id of [...projects.keys()]) {
      if (!nextIds.has(id)) {
        projects.delete(id);
        bindings.delete(id);
        removed++;
      }
    }
    for (const project of enrolled) {
      const nextBinding = enrollmentBinding(project);
      if (projects.has(project.id) && bindings.get(project.id) === nextBinding) {
        continue;
      }
      if (projects.has(project.id)) rebound++;
      else added++;
      bindings.set(project.id, nextBinding);
      projects.set(project.id, new ManagedRepository(project, reposDir, stateDir, proposal));
    }
    return { enrolled, localCount, added, removed, rebound };
  }

  const initial = reconcileEnrollment(allEntries);

  async function dispatch(request: GitRequest, signal: AbortSignal): Promise<GitResult> {
    if (request.verb === 'statuses') {
      return Object.fromEntries([...projects].map(([id, project]) => [id, project.status]));
    }

    const project = projects.get(request.projectId);
    if (!project || bindings.get(request.projectId) !== request.binding) throw new GitRpcError('unknown_git_project');
    if (!proposal || (request.verb === 'propose' && proposal.enforcesManagedBase !== true)) {
      throw new GitRpcError('proposal_unavailable');
    }
    return queue.run(request.projectId, signal, async (jobSignal) => {
      if (projects.get(request.projectId) !== project || bindings.get(request.projectId) !== request.binding) {
        throw new GitRpcError('unknown_git_project');
      }
      if (request.verb === 'update') {
        return project.update(jobSignal);
      }
      let ctx;
      try { ctx = project.proposalContext(); } catch { throw new GitRpcError('git_not_ready'); }
      jobSignal.throwIfAborted();
      try {
        if (request.verb === 'review') {
          const nonce = randomUUID();
          const result = await proposal.reviewProposal({ ...ctx, branch: proposalBranch(request.actor, nonce) });
          if (typeof result?.reviewId !== 'string' || result.reviewId !== result.reviewId.trim() || !/^[!-~]{1,475}$/.test(result.reviewId) ||
              typeof result.diff !== 'string' || !Array.isArray(result.files) || !result.status) {
            throw new GitRpcError('git_operation_failed');
          }
          return { ...result, reviewId: `${nonce}.${result.reviewId}`, status: { ...result.status, branch: ctx.branch } };
        }

        const { nonce, innerId } = unwrapReviewId(request.input.reviewId);
        const result = await proposal.publishProposal(
          { ...ctx, branch: proposalBranch(request.actor, nonce) },
          { ...request.input, reviewId: innerId }
        );
        const published = validatePublished(result, ctx.remote);
        log.info('Published Git proposal', {
          project: request.projectId,
          url: published.url,
          sha: published.sha.slice(0, 12)
        });
        return published;
      } catch (err) {
        const mapped = proposalFailure(err);
        const detail = err instanceof GitRpcError ? err.detail
          : err instanceof Error ? sanitizeLogText(err.message, 240)
          : undefined;
        throw detail && !mapped.detail ? new GitRpcError(mapped.code, detail) : mapped;
      }
    });
  }

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    if (sockets.size >= MAX_CONNECTIONS) return socket.destroy();
    sockets.add(socket);
    const disconnect = new AbortController();
    const receiveTimer = setTimeout(() => socket.destroy(), REQUEST_READ_TIMEOUT);
    const chunks: Buffer[] = [];
    let size = 0;
    let dispatched = false;

    function send(value: object) {
      if (socket.destroyed) return;
      const frame = JSON.stringify(value) + '\n';
      socket.setTimeout(3_000, () => socket.destroy());
      if (Buffer.byteLength(frame) <= MAX_GIT_RESPONSE_BYTES) socket.end(frame);
      else socket.end(JSON.stringify({ ok: false, error: 'git_response_too_large' }) + '\n');
    }

    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(receiveTimer);
      disconnect.abort();
      sockets.delete(socket);
    });
    socket.on('data', (chunk: Buffer) => {
      if (dispatched) return socket.destroy();
      size += chunk.length;
      const end = chunk.indexOf(10);
      if (size > MAX_GIT_REQUEST_BYTES || (end !== -1 && end !== chunk.length - 1)) {
        return socket.destroy();
      }
      chunks.push(chunk);
      if (end === -1) return;
      dispatched = true;
      clearTimeout(receiveTimer);
      let request: GitRequest;
      try {
        request = parseGitRequest(Buffer.concat(chunks, size));
      } catch {
        log.warn('Rejected invalid Git worker socket request');
        return send({ ok: false, error: 'invalid_git_request' });
      }
      chunks.length = 0;
      const limit = request.verb === 'propose' ? 85_000 : request.verb === 'update' ? 60_000 : 25_000;
      const deadline = AbortSignal.timeout(limit);
      const signal = AbortSignal.any([disconnect.signal, deadline]);
      const expired = () => {
        log.warn('Git worker RPC timed out', {
          verb: request.verb,
          project: request.verb === 'statuses' ? undefined : request.projectId,
          timeoutMs: limit
        });
        send({ ok: false, error: 'git_timeout' });
      };
      deadline.addEventListener('abort', expired, { once: true });
      void dispatch(request, signal).then((result) => {
        if (!signal.aborted) send({ ok: true, result });
      }).catch((error: unknown) => {
        if (!signal.aborted) {
          const mapped = proposalFailure(error);
          log.warn('Git worker RPC failed', {
            verb: request.verb,
            project: request.verb === 'statuses' ? undefined : request.projectId,
            code: mapped.code,
            reason: mapped.detail ?? (error instanceof Error && !(error instanceof GitRpcError) ? error.message : undefined)
          });
          send({ ok: false, error: mapped.code });
        }
      }).finally(() => deadline.removeEventListener('abort', expired));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  try { fs.chmodSync(socketPath, 0o660); } catch (err) {
    server.close();
    throw err;
  }

  log.info('Loaded enrolled projects', {
    count: initial.enrolled.length,
    localSkipped: initial.localCount || undefined,
    projects: initial.enrolled.map((p) => `${p.id}@${p.branch}`).join(',') || 'none',
    proposalService: Boolean(proposal)
  });
  let cursor = 0;
  const refresh = () => {
    const entries = [...projects];
    if (entries.length === 0) return;
    if (cursor >= entries.length) cursor = 0;
    for (let checked = 0; checked < entries.length; checked++) {
      const [id, project] = entries[cursor];
      cursor = (cursor + 1) % entries.length;
      if (project.due && queue.canRunInBackground(id)) {
        void queue.run(id, AbortSignal.timeout(60_000), (signal) => project.refresh(signal)).catch(() => {});
      }
    }
  };
  refresh();
  const background = setInterval(refresh, 500);
  const enrollmentWatcher = watchEnrollmentFile(options.enrollmentFile, {
    initialEntries: allEntries,
    debounceMs: options.enrollmentDebounceMs,
    onReload: (nextEntries) => {
      checkEnrollmentPath();
      const summary = reconcileEnrollment(nextEntries);
      log.info('Reloaded enrolled projects', {
        count: summary.enrolled.length,
        localSkipped: summary.localCount || undefined,
        added: summary.added || undefined,
        removed: summary.removed || undefined,
        rebound: summary.rebound || undefined,
        projects: summary.enrolled.map((p) => `${p.id}@${p.branch}`).join(',') || 'none'
      });
      refresh();
    },
    onError: (reason) => {
      log.warn('Failed to reload enrollment.json; keeping last valid configuration', { reason });
    }
  });

  return {
    async close() {
      enrollmentWatcher.close();
      clearInterval(background);
      queue.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function main(): Promise<void> {
  const enrollmentFile = process.env.FOCUSWIKI_ENROLLMENT_FILE;
  const reposDir = process.env.FOCUSWIKI_REPOS_DIR;
  const stateDir = process.env.FOCUSWIKI_GIT_STATE_DIR;
  if (!enrollmentFile || !reposDir || !stateDir) {
    throw new Error('Set FOCUSWIKI_ENROLLMENT_FILE, FOCUSWIKI_REPOS_DIR and FOCUSWIKI_GIT_STATE_DIR.');
  }
  process.umask(0o007);
  const runner = await startGitRunner({
    enrollmentFile, reposDir, stateDir, socketPath: process.env.FOCUSWIKI_GIT_SOCKET || DEFAULT_GIT_SOCKET
  });
  console.log('[focuswiki-git] Listening on the private socket.');
  const stop = () => {
    void runner.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err: unknown) => {
    console.error('[focuswiki-git] Startup failed:', err instanceof Error ? err.message : 'Unknown error.');
    process.exitCode = 1;
  });
}
