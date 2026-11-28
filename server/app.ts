import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type {
  CommentAnchor,
  ConflictErrorPayload,
  DocTreeEntry,
  DocumentPayload,
  ProjectConfig,
  ProjectSummary,
  ServerEnvironmentInfo
} from '../shared/types.js';
import {
  extractDocumentTitle,
  markdownToProseMirror
} from '../shared/markdownCodec.js';
import {
  buildAnchorFromBlockSelection,
  extractProseBlocks,
  resolveThreadsAgainstDoc
} from '../shared/anchorResolver.js';
import {
  PathBoundaryError,
  resolveInternalMetadataDir,
  resolveSafeEmbedAssetPath,
  resolveSafeProjectFilePath
} from './pathGuard.js';
import { GitSocketClient } from './gitSocketClient.js';
import { GitRpcError, parseProposalInput, validProposalActor, type GitStatuses } from './gitProtocol.js';
import {
  CommentNotFoundError,
  addCommentReply,
  createCommentThread,
  readCommentSidecar,
  updateCommentStatus
} from './commentStore.js';
import { watchEnrollmentFile, type EnrollmentWatchHandle } from './enrollment.js';
import { ProjectRegistry, hasWorkingTree, unavailableGitStatus } from './projectRegistry.js';
import { ProjectWatcherHub, type WatcherHubOptions } from './watcher.js';
import { BROWSE_LIMITS, SEARCH_LIMITS, ScanBudget, listConflictCopies, scanRepository, searchRepositories } from './repositoryScan.js';
import { withKeyLock, writeFileAtomicSync } from './fileLock.js';
import { createHttpSecurity, createExpensiveRequestLimiter, validateHost, type RateLimitOptions, type ServeAccessOptions } from './httpSecurity.js';
import { createLogger } from './logger.js';

const log = createLogger('focuswiki');

export function computeRevision(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};


export interface HubAppInstance {
  app: Express;
  watcherHub: ProjectWatcherHub;
  registry: ProjectRegistry;
  close: () => Promise<void>;
}

export interface HubAppOptions {
  projects?: ProjectConfig[];
  registry?: ProjectRegistry;
  enrollmentWatch?: {
    file: string;
    debounceMs?: number;
  };
  gitSocketPath?: string;
  proposalAuth?: RequestHandler;
  clientDistDir?: string;
  enableWatcher?: boolean;
  allowedHosts?: string[];
  serveAccess?: ServeAccessOptions;
  rateLimit?: RateLimitOptions | false;
  sse?: WatcherHubOptions;
}

export function createHubApp(options: HubAppOptions): HubAppInstance {
  const app = express();
  const embedAssetKey = crypto.randomBytes(32);
  const registry = options.registry ?? new ProjectRegistry(options.projects ?? []);
  const gitClient = new GitSocketClient(options.gitSocketPath);
  const proposalAuth: RequestHandler = options.proposalAuth ?? ((_req, _res, next) => {
    next(new GitRpcError('proposal_unavailable'));
  });
  const watcherEnabled = options.enableWatcher !== false;

  const watcherHub = new ProjectWatcherHub(options.sse);
  if (watcherEnabled) {
    watcherHub.start(registry.list());
  }

  let enrollmentWatcher: EnrollmentWatchHandle | undefined;
  if (options.enrollmentWatch) {
    enrollmentWatcher = watchEnrollmentFile(options.enrollmentWatch.file, {
      initialEntries: registry.enrollmentSnapshot(),
      debounceMs: options.enrollmentWatch.debounceMs,
      onReload: async (entries) => {
        const diff = registry.syncEnrollment(entries);
        if (!diff.changed) return;
        if (watcherEnabled) {
          const toStop = new Set([...diff.removed, ...diff.rootChanged]);
          for (const id of toStop) {
            await watcherHub.removeProject(id);
          }
          const toStart = [
            ...diff.added,
            ...diff.updated.filter((project) => diff.rootChanged.includes(project.id))
          ];
          for (const project of toStart) {
            watcherHub.addProject(project);
          }
        }
        watcherHub.broadcast({ type: 'projects:updated', reason: 'updated', at: new Date().toISOString() });
        log.info('Reloaded enrollment configuration', {
          projects: entries.length,
          added: diff.added.length,
          removed: diff.removed.length,
          updated: diff.updated.length
        });
      },
      onError: (reason) => {
        log.warn('Failed to reload enrollment.json; keeping last valid configuration', { reason });
      }
    });
  }

  app.disable('x-powered-by');
  app.use(createHttpSecurity({ allowedHosts: options.allowedHosts, serveAccess: options.serveAccess }));
  if (options.rateLimit !== false) app.use(createExpensiveRequestLimiter(options.rateLimit));
  app.use(express.json({ limit: '4mb' }));

  function getProjectOrThrow(projectId: string): ProjectConfig {
    const project = registry.get(projectId);
    if (!project) {
      throw new PathBoundaryError(`Unregistered project "${projectId}".`, 404);
    }
    if (!hasWorkingTree(project.rootPath)) {
      throw new PathBoundaryError(`Working copy missing for "${projectId}".`, 404);
    }
    return project;
  }

  let activeBrowseRequests = 0;
  const boundedBrowse = (work: (req: Request, res: Response, signal: AbortSignal, next: NextFunction) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      if (activeBrowseRequests >= 4) {
        res.setHeader('Retry-After', '1');
        res.status(503).json({ error: 'browse_busy', message: 'Workspace is busy. Please retry shortly.' });
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      activeBrowseRequests++;
      try {
        await work(req, res, controller.signal, next);
      } catch (err) {
        if (!controller.signal.aborted) next(err);
      } finally {
        activeBrowseRequests--;
        res.off('close', abort);
      }
    };

  async function buildProjectSummary(project: ProjectConfig, statuses: GitStatuses, budget: ScanBudget): Promise<ProjectSummary> {
    const enrollment = registry.managed(project.id);
    const hasFiles = hasWorkingTree(project.rootPath);
    if (watcherEnabled && hasFiles) {
      watcherHub.retryFailedProject(project);
    }
    const status = Object.hasOwn(statuses, project.id) ? statuses[project.id] : undefined;
    const git = enrollment && status?.branch === enrollment.branch && status.remoteUrl === enrollment.remote &&
      (status.state !== 'ready' || hasFiles) ? status : unavailableGitStatus(enrollment);
    return {
      ...project,
      git,
      workingTreeAvailable: hasFiles,
      ...(hasFiles ? await scanRepository(project, budget) : { docs: [], embeds: [] }),
      ...(watcherEnabled && watcherHub.isWatchIncomplete(project.id) ? { watchIncomplete: true } : {})
    };
  }

  // Disconnecting the HTTP client withdraws queued work on the private socket.
  async function untilDisconnect<T>(res: Response, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    if (res.destroyed) disconnect();
    try {
      return await operation(controller.signal);
    } finally {
      res.off('close', disconnect);
    }
  }

  app.get(['/api/health', '/healthz'], (_req, res) => { res.json({ ok: true }); });

  // SSE stream for external file & comment updates
  app.get('/api/events', (req, res) => {
    if (!watcherHub.addClient(res)) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'sse_capacity', message: 'Too many event streams. Retry shortly.' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`);
  });

  function retired(_req: Request, res: Response): void {
    res.status(410).json({
      error: 'git_workflow_retired',
      message: 'This workflow has been retired. Projects are managed through operator enrollment.'
    });
  }

  app.all([
    '/api/projects/import-config',
    '/api/projects/import',
    '/api/projects/inspect-local',
    '/api/projects/inspect-remote',
    '/api/settings/credentials',
    '/api/settings/credentials/*',
    '/api/projects/:projectId/git/refs',
    '/api/projects/:projectId/git/fetch',
    '/api/projects/:projectId/git/pull',
    '/api/projects/:projectId/git/checkout',
    '/api/projects/:projectId/git/commit',
    '/api/projects/:projectId/git/push',
    '/api/projects/:projectId/git/sync'
  ], retired);
  app.patch('/api/projects/:projectId', retired);
  app.delete('/api/projects/:projectId', retired);

  app.get('/api/settings/environment', (_req, res) => {
    const projects = registry.list();
    const info: ServerEnvironmentInfo = {
      projectCount: projects.length,
      managedProjectCount: projects.filter((project) => registry.managed(project.id)).length
    };
    res.json(info);
  });

  let lastGitStatusError: string | undefined;

  app.get('/api/projects', boundedBrowse(async (req, res, signal) => {
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      res.status(400).json({ error: 'invalid_offset', message: 'Offset must be a nonnegative integer.' });
      return;
    }
    const projects = registry.list();
    const page = projects.slice(offset, offset + 24);
    const budget = new ScanBudget(BROWSE_LIMITS, signal);
    const gitSignal = AbortSignal.any([signal, AbortSignal.timeout(2_500)]);
    let statuses: GitStatuses = {};
    if (page.some(project => registry.managed(project.id))) {
      try {
        statuses = await gitClient.statuses(gitSignal);
        if (lastGitStatusError) {
          log.info('Restored Git worker socket connectivity');
          lastGitStatusError = undefined;
        }
      } catch (err) {
        const code = err instanceof GitRpcError ? err.code : 'git_unavailable';
        if (lastGitStatusError !== code) {
          lastGitStatusError = code;
          log.warn('Failed to query Git worker statuses', { code });
        }
      }
    }
    const summaries: ProjectSummary[] = [];
    for (const project of page) {
      signal.throwIfAborted();
      summaries.push(await buildProjectSummary(project, statuses, budget.child()));
    }
    const nextOffset = offset + page.length;
    res.json({ projects: summaries, ...(nextOffset < projects.length ? { nextOffset } : {}) });
  }));


  // Full-text search across all registered projects
  app.get('/api/search', boundedBrowse(async (req, res, signal) => {
    const query = String(req.query.q ?? '').trim();
    if (!query) {
      res.json({ results: [] });
      return;
    }
    if (query.length > 256) {
      res.status(400).json({ error: 'query_too_long', message: 'Search queries are limited to 256 characters.' });
      return;
    }
    res.json(await searchRepositories(registry.list(), query.toLowerCase(), new ScanBudget(SEARCH_LIMITS, signal)));
  }));

  // Repository-local images only; executable documents belong in the embed sandbox.
  app.get('/api/projects/:projectId/assets/*', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const assetPath = (req.params as Record<string, string>)[0] ?? '';
      const segments = assetPath.split('/');
      if (!assetPath || assetPath.includes('\0')) throw new PathBoundaryError('Invalid asset path.', 400);
      if (segments.some((segment) => ['..', '.git', '.focuswiki', '.cairn'].includes(segment.toLowerCase())) || /\.comments\.json(?:$|\/)/i.test(assetPath)) {
        throw new PathBoundaryError('Protected asset path.', 403);
      }
      const { absolutePath, normalizedRelPath } = resolveSafeProjectFilePath(project.rootPath, assetPath);
      if (normalizedRelPath.split('/').some((seg) => seg.startsWith('.'))) {
        throw new PathBoundaryError('Hidden dotfiles may not be served as assets.', 403);
      }
      const ext = path.extname(normalizedRelPath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.svg'].includes(ext)) {
        throw new PathBoundaryError('Only safe image assets may be served here.', 403);
      }
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        res.status(404).json({ error: 'not_found', message: 'Asset not found.' });
        return;
      }
      res.setHeader('Content-Type', MIME_BY_EXT[ext]);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (ext === '.svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.sendFile(normalizedRelPath, { root: project.rootPath, dotfiles: 'deny' });
    } catch (err) {
      next(err);
    }
  });

  // Read Markdown document + AST + resolved comments
  app.get('/api/projects/:projectId/doc', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.query.path ?? project.defaultDoc);
      const { absolutePath, normalizedRelPath } = resolveSafeProjectFilePath(
        project.rootPath,
        docParam
      );
      if (!normalizedRelPath.endsWith('.md')) {
        throw new PathBoundaryError('Only Markdown (.md) documents may be opened here.', 400);
      }
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        res.status(404).json({ error: 'not_found', message: `Document "${normalizedRelPath}" not found.` });
        return;
      }

      const markdown = fs.readFileSync(absolutePath, 'utf8');
      const stat = fs.statSync(absolutePath);
      const docJson = markdownToProseMirror(markdown);
      const sidecar = readCommentSidecar(project.rootPath, normalizedRelPath);
      const comments = resolveThreadsAgainstDoc(sidecar.threads, docJson);

      const payload: DocumentPayload = {
        projectId: project.id,
        path: normalizedRelPath,
        markdown,
        revision: computeRevision(markdown),
        mtimeMs: stat.mtimeMs,
        docJson,
        comments,
        ...await listConflictCopies(project.rootPath, normalizedRelPath)
      };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  // Create new Markdown document in project working tree
  app.post('/api/projects/:projectId/docs', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const rawPath = String(req.body?.path ?? '').trim();
      const title = String(req.body?.title ?? 'Untitled Document').trim();
      const withExt = rawPath.endsWith('.md') ? rawPath : `${rawPath}.md`;
      const { absolutePath, normalizedRelPath } = resolveSafeProjectFilePath(project.rootPath, withExt);
      if (fs.existsSync(absolutePath)) {
        res.status(409).json({ error: 'already_exists', message: `Document "${normalizedRelPath}" already exists.` });
        return;
      }
      const initialMd =
        typeof req.body?.markdown === 'string' && req.body.markdown.trim()
          ? req.body.markdown
          : `# ${title}\n\nStart writing here.\n`;

      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o770 });
      fs.writeFileSync(absolutePath, initialMd, { encoding: 'utf8', mode: 0o660, flag: 'wx' });

      res.status(201).json({
        path: normalizedRelPath,
        revision: computeRevision(initialMd)
      });
    } catch (err) {
      next(err);
    }
  });

  // Save / autosave Markdown document with optimistic revision check & recoverable conflict handling
  app.put('/api/projects/:projectId/doc', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const rawPath = String(req.body?.path ?? '');
      const markdown = typeof req.body?.markdown === 'string' ? req.body.markdown : null;
      const baseRevision = typeof req.body?.baseRevision === 'string' ? req.body.baseRevision : '';
      const forceOverwrite = Boolean(req.body?.forceOverwrite);

      if (markdown === null) {
        res.status(400).json({ error: 'invalid_body', message: 'Field "markdown" is required.' });
        return;
      }

      const lockPath = resolveSafeProjectFilePath(project.rootPath, rawPath).absolutePath;
      await withKeyLock(lockPath, async () => {
        const { absolutePath, normalizedRelPath } = resolveSafeProjectFilePath(project.rootPath, rawPath);
        if (!normalizedRelPath.endsWith('.md')) {
          throw new PathBoundaryError('Only Markdown (.md) files can be written via document save.', 400);
        }

        if (fs.existsSync(absolutePath)) {
          const diskMarkdown = fs.readFileSync(absolutePath, 'utf8');
          const diskRevision = computeRevision(diskMarkdown);

          if (!forceOverwrite && baseRevision !== diskRevision && diskMarkdown !== markdown) {
            const conflictDir = resolveInternalMetadataDir(project.rootPath, '.focuswiki/conflicts');
            fs.mkdirSync(conflictDir, { recursive: true, mode: 0o770 });
            const safePrefix = normalizedRelPath.replace(/[^a-zA-Z0-9._-]/g, '__');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const conflictFileName = `${safePrefix}.${stamp}.${crypto.randomUUID()}.md`;
            const conflictAbsPath = path.join(conflictDir, conflictFileName);
            writeFileAtomicSync(conflictAbsPath, markdown, 0o660);

            const conflictPayload: ConflictErrorPayload = {
              error: 'revision_conflict',
              message:
                'File changed externally on disk since this editor loaded it. Both versions are preserved.',
              path: normalizedRelPath,
              diskRevision,
              diskMarkdown,
              yourMarkdown: markdown,
              savedConflictCopyPath: `.focuswiki/conflicts/${conflictFileName}`
            };
            res.status(409).json(conflictPayload);
            return;
          }
        } else {
          fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o770 });
        }

        writeFileAtomicSync(absolutePath, markdown);
        const stat = fs.statSync(absolutePath);
        const docJson = markdownToProseMirror(markdown);
        const sidecar = readCommentSidecar(project.rootPath, normalizedRelPath);
        const comments = resolveThreadsAgainstDoc(sidecar.threads, docJson);

        res.json({
          path: normalizedRelPath,
          revision: computeRevision(markdown),
          mtimeMs: stat.mtimeMs,
          savedAt: new Date().toISOString(),
          docJson,
          comments,
          ...await listConflictCopies(project.rootPath, normalizedRelPath)
        });
      });
    } catch (err) {
      next(err);
    }
  });

  // Read resolved comments for a document
  app.get('/api/projects/:projectId/comments', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.query.path ?? project.defaultDoc);
      const { absolutePath, normalizedRelPath } = resolveSafeProjectFilePath(project.rootPath, docParam);
      if (!fs.existsSync(absolutePath)) {
        res.status(404).json({ error: 'not_found', message: 'Document not found.' });
        return;
      }
      const md = fs.readFileSync(absolutePath, 'utf8');
      const docJson = markdownToProseMirror(md);
      const sidecar = readCommentSidecar(project.rootPath, normalizedRelPath);
      res.json({
        document: normalizedRelPath,
        threads: resolveThreadsAgainstDoc(sidecar.threads, docJson)
      });
    } catch (err) {
      next(err);
    }
  });

  // Create inline comment thread (supports both UI selection anchors and bot quote strings)
  app.post('/api/projects/:projectId/comments', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.body?.path ?? '');
      const lockPath = resolveSafeProjectFilePath(project.rootPath, docParam).absolutePath;
      await withKeyLock(lockPath, async () => {
        const { absolutePath, normalizedRelPath } = resolveSafeProjectFilePath(project.rootPath, docParam);
        if (!fs.existsSync(absolutePath)) {
          res.status(404).json({ error: 'not_found', message: 'Document not found.' });
          return;
        }
        const bodyText = String(req.body?.body ?? '').trim();
        if (!bodyText) {
          res.status(400).json({ error: 'invalid_body', message: 'Comment body is required.' });
          return;
        }
        const author = String(req.body?.author ?? 'Reviewer').trim();
        const role: 'human' | 'bot' = req.body?.role === 'bot' ? 'bot' : 'human';

        const md = fs.readFileSync(absolutePath, 'utf8');
        const docJson = markdownToProseMirror(md);
        const blocks = extractProseBlocks(docJson);

        let anchor: CommentAnchor | null = null;
        if (req.body?.anchor && typeof req.body.anchor.quote === 'string') {
          anchor = {
            quote: String(req.body.anchor.quote),
            prefix: String(req.body.anchor.prefix ?? ''),
            suffix: String(req.body.anchor.suffix ?? ''),
            headingContext: req.body.anchor.headingContext
              ? String(req.body.anchor.headingContext)
              : undefined
          };
        } else if (typeof req.body?.quote === 'string' && req.body.quote.trim()) {
          const quote = req.body.quote;
          const matchingBlocks = blocks.filter((b) => b.text.includes(quote));
          if (matchingBlocks.length === 1) {
            const blk = matchingBlocks[0];
            const idx = blk.text.indexOf(quote);
            anchor = buildAnchorFromBlockSelection(blk, idx, idx + quote.length);
          } else {
            anchor = {
              quote,
              prefix: String(req.body?.prefix ?? ''),
              suffix: String(req.body?.suffix ?? '')
            };
          }
        }

        if (!anchor || !anchor.quote.trim()) {
          res.status(400).json({ error: 'invalid_anchor', message: 'Selected prose quote is required.' });
          return;
        }

        const created = createCommentThread(project.rootPath, normalizedRelPath, {
          anchor,
          author,
          role,
          body: bodyText
        });

        const [resolved] = resolveThreadsAgainstDoc([created], docJson);
        res.status(201).json({ thread: resolved });
      });
    } catch (err) {
      next(err);
    }
  });

  // Reply to an existing comment thread
  app.post('/api/projects/:projectId/comments/:threadId/replies', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.body?.path ?? '');
      const lockPath = resolveSafeProjectFilePath(project.rootPath, docParam).absolutePath;
      await withKeyLock(lockPath, async () => {
        const { absolutePath, normalizedRelPath } = resolveSafeProjectFilePath(project.rootPath, docParam);
        const bodyText = String(req.body?.body ?? '').trim();
        if (!bodyText) {
          res.status(400).json({ error: 'invalid_body', message: 'Reply body is required.' });
          return;
        }
        const updated = addCommentReply(project.rootPath, normalizedRelPath, req.params.threadId, {
          author: String(req.body?.author ?? 'Reviewer'),
          role: req.body?.role === 'bot' ? 'bot' : 'human',
          body: bodyText
        });
        const md = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
        const [resolved] = resolveThreadsAgainstDoc([updated], markdownToProseMirror(md));
        res.json({ thread: resolved });
      });
    } catch (err) {
      next(err);
    }
  });

  // Resolve or reopen a comment thread
  app.post('/api/projects/:projectId/comments/:threadId/status', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.body?.path ?? '');
      const lockPath = resolveSafeProjectFilePath(project.rootPath, docParam).absolutePath;
      await withKeyLock(lockPath, async () => {
        const { absolutePath, normalizedRelPath } = resolveSafeProjectFilePath(project.rootPath, docParam);
        const status = req.body?.status === 'resolved' ? 'resolved' : req.body?.status === 'open' ? 'open' : null;
        if (!status) {
          res.status(400).json({ error: 'invalid_status', message: 'Status must be "open" or "resolved".' });
          return;
        }
        const updated = updateCommentStatus(project.rootPath, normalizedRelPath, req.params.threadId, {
          status,
          actor: String(req.body?.actor ?? 'Reviewer'),
          role: req.body?.role === 'bot' ? 'bot' : 'human',
          note: typeof req.body?.note === 'string' ? req.body.note : undefined
        });
        const md = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
        const [resolved] = resolveThreadsAgainstDoc([updated], markdownToProseMirror(md));
        res.json({ thread: resolved });
      });
    } catch (err) {
      next(err);
    }
  });

  // Inspect project-authored embed source file (read-only view for transparency)
  app.get('/api/projects/:projectId/embed-source', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const srcParam = String(req.query.src ?? '');
      const { absolutePath, normalizedRelPath } = resolveSafeEmbedAssetPath(
        project.rootPath,
        srcParam
      );
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        res.status(404).json({ error: 'not_found', message: `Embed source "${normalizedRelPath}" not found.` });
        return;
      }
      const source = fs.readFileSync(absolutePath, 'utf8');
      res.json({
        src: normalizedRelPath,
        source
      });
    } catch (err) {
      next(err);
    }
  });

  // Create or update a project-authored embed component file inside embeds/
  app.post('/api/projects/:projectId/embeds', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const srcParam = String(req.body?.src ?? '').trim();
      const source = typeof req.body?.source === 'string' ? req.body.source : '';
      if (!source.trim()) {
        res.status(400).json({ error: 'invalid_source', message: 'Component HTML/JS source is required.' });
        return;
      }
      const { absolutePath, normalizedRelPath } = resolveSafeEmbedAssetPath(
        project.rootPath,
        srcParam
      );
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o770 });
      writeFileAtomicSync(absolutePath, source);
      res.status(201).json({
        src: normalizedRelPath
      });
    } catch (err) {
      next(err);
    }
  });

  function requireManagedProject(req: Request, _res: Response, next: NextFunction): void {
    if (!registry.managed(req.params.projectId)) return next(new GitRpcError('unknown_git_project'));
    next();
  }

  function requireProposalActor(_req: Request, res: Response, next: NextFunction): void {
    if (!validProposalActor(res.locals.proposalActor)) return next(new GitRpcError('proposal_auth_required'));
    next();
  }

  app.head('/api/projects/:projectId/git/diff', (_req, res) => {
    res.setHeader('Allow', 'GET');
    res.sendStatus(405);
  });

  app.get('/api/projects/:projectId/git/diff', requireManagedProject, proposalAuth, requireProposalActor, async (req, res, next) => {
    try {
      const project = registry.managed(req.params.projectId)!;
      const review = await untilDisconnect(res, (signal) => gitClient.review(project, res.locals.proposalActor, signal));
      if (!res.destroyed) {
        res.setHeader('Cache-Control', 'no-store');
        res.json(review);
      }
    } catch (err) {
      if (!res.destroyed) next(err);
    }
  });

  app.post('/api/projects/:projectId/git/update', requireManagedProject, proposalAuth, requireProposalActor, async (req, res, next) => {
    try {
      const project = registry.managed(req.params.projectId)!;
      const result = await untilDisconnect(res, (signal) => gitClient.update(project, res.locals.proposalActor, signal));
      if (!res.destroyed) {
        res.setHeader('Cache-Control', 'no-store');
        res.json(result);
      }
    } catch (err) {
      if (!res.destroyed) next(err);
    }
  });

  app.post('/api/projects/:projectId/git/propose', requireManagedProject, proposalAuth, requireProposalActor, async (req, res, next) => {
    try {
      const project = registry.managed(req.params.projectId)!;
      const input = parseProposalInput(req.body);
      const actor: string = res.locals.proposalActor;
      const result = await untilDisconnect(res, (signal) => gitClient.propose(project, actor, input, signal));
      if (!res.destroyed) {
        res.setHeader('Cache-Control', 'no-store');
        res.json(result);
      }
    } catch (err) {
      if (!res.destroyed) next(err);
    }
  });

  // Sandboxed static asset server for project-authored browser embeds
  app.get('/embed-sandbox/:projectId/*', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const wildcard = (req.params as Record<string, string>)[0] ?? '';
      const assetToken = crypto.createHmac('sha256', embedAssetKey)
        .update(project.id).update('\0').update(project.rootPath).digest('hex');
      const assetPathPrefix = `/embed-sandbox/${encodeURIComponent(project.id)}/_assets/${assetToken}/`;
      const scoped = wildcard.startsWith('_assets/');
      let relPath = wildcard;
      if (scoped) {
        const match = /^_assets\/([a-f0-9]{64})\/(.*)$/s.exec(wildcard);
        if (!match || !crypto.timingSafeEqual(Buffer.from(match[1], 'hex'), Buffer.from(assetToken, 'hex'))) {
          throw new PathBoundaryError('Invalid embed asset URL.');
        }
        relPath = match[2];
      }
      const { absolutePath, normalizedRelPath } = resolveSafeEmbedAssetPath(project.rootPath, relPath);

      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        res.status(404).type('text/plain').send('Embed asset not found.');
        return;
      }

      const ext = path.extname(normalizedRelPath).toLowerCase();
      const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      const host = validateHost(req.get('host'));
      const proto = req.protocol;
      if (!host || !['http', 'https'].includes(proto)) {
        throw new PathBoundaryError('Invalid request authority.', 400);
      }
      const browserOrigin: string = res.locals.browserOrigin ?? `${proto}://${host}`;
      const allowedProjectAssetPrefix = scoped ? ` ${browserOrigin}${assetPathPrefix}embeds/` : '';
      const csp = [
        "sandbox allow-scripts",
        "default-src 'none'",
        `script-src 'unsafe-inline'${allowedProjectAssetPrefix}`,
        `style-src 'unsafe-inline'${allowedProjectAssetPrefix}`,
        `img-src data: blob:${allowedProjectAssetPrefix}`,
        `font-src data:${allowedProjectAssetPrefix}`,
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'"
      ].join('; ');

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      if (!scoped) {
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (ext === '.html') {
          // Navigation can use this redirect. A cross-origin fetch cannot read it or its Location.
          const encodedPath = normalizedRelPath.split('/').map(encodeURIComponent).join('/');
          const queryStart = req.originalUrl.indexOf('?');
          const query = queryStart === -1 ? '' : req.originalUrl.slice(queryStart);
          res.location(assetPathPrefix + encodedPath + query).status(302).end();
          return;
        }
      } else if (ext !== '.html') {
        // Opaque iframe modules and fonts need CORS. The project-scoped URL authorizes it.
        res.vary('Origin');
        if (req.get('origin') === 'null') res.setHeader('Access-Control-Allow-Origin', 'null');
      }
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('Content-Type', contentType);

      res.sendFile(normalizedRelPath, { root: project.rootPath, dotfiles: 'deny' });
    } catch (err) {
      next(err);
    }
  });

  // Serve built React SPA in production
  if (options.clientDistDir && fs.existsSync(options.clientDistDir)) {
    const clientRoot = path.resolve(options.clientDistDir);
    app.use(express.static(clientRoot));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/embed-sandbox/')) {
        next();
        return;
      }
      res.sendFile(path.join(clientRoot, 'index.html'));
    });
  }

  // Central error handler
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PathBoundaryError) {
      res.status(err.statusCode).json({
        error: 'path_boundary_violation',
        message: err.message
      });
      return;
    }
    if (err instanceof GitRpcError) {
      log.warn('Managed Git request failed', {
        method: req.method,
        path: req.path,
        status: err.status,
        code: err.code
      });
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof CommentNotFoundError) {
      res.status(err.statusCode).json({ error: 'not_found', message: err.message });
      return;
    }
    // Express body parser and URI decoding failures are client errors, not server faults.
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'invalid_request', message: 'Invalid request.' });
      return;
    }
    console.error('[focuswiki] Unexpected request error.');
    res.status(500).json({ error: 'server_error', message: 'Unexpected server error.' });
  });

  return {
    app,
    watcherHub,
    registry,
    close: async () => {
      enrollmentWatcher?.close();
      await watcherHub.close();
    }
  };
}
