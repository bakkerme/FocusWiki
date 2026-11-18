import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type {
  CommentAnchor,
  ConflictErrorPayload,
  DocTreeEntry,
  DocumentPayload,
  ProjectConfig,
  ProjectSummary,
  RepoInspectionResult,
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
  resolveSafeProjectPath
} from './pathGuard.js';
import {
  GitAuthError,
  GitOperationError,
  WorkingTreeDirtyError,
  WorkingTreeSnapshotMismatchError,
  checkoutGitTarget,
  cloneRepository,
  commitWorkingTree,
  fetchGitRemote,
  getGitRefs,
  getGitRepoStatus,
  getGitWorkingDiff,
  initNewWikiRepository,
  inspectRemoteRepository,
  isSshClientAvailable,
  pullGitRemote
} from './gitService.js';
import { CredentialStore, extractHttpsHost } from './credentialStore.js';
import {
  CommentNotFoundError,
  addCommentReply,
  createCommentThread,
  readCommentSidecar,
  updateCommentStatus
} from './commentStore.js';
import {
  ProjectRegistry,
  deriveDisplayNameFromSlug,
  deriveSlugFromRemoteUrl,
  slugifyProjectId
} from './projectRegistry.js';
import { ProjectWatcherHub, type WatcherHubOptions } from './watcher.js';
import { BROWSE_LIMITS, SEARCH_LIMITS, ScanBudget, listConflictCopies, scanRepository, searchRepositories } from './repositoryScan.js';
import { withKeyLock, writeFileAtomicSync } from './fileLock.js';
import { createHttpSecurity, createExpensiveRequestLimiter, validateHost, type RateLimitOptions } from './httpSecurity.js';

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

function pickSuggestedDefaultDoc(docs: DocTreeEntry[]): string {
  if (docs.length === 0) return 'README.md';
  const preferred = ['docs/index.md', 'docs/README.md', 'README.md', 'readme.md'];
  for (const candidate of preferred) {
    const match = docs.find((d) => d.path === candidate);
    if (match) return match.path;
  }
  const docsMatch = docs.find((d) => d.path.startsWith('docs/'));
  return docsMatch?.path ?? docs[0].path;
}

export interface HubAppInstance {
  app: Express;
  watcherHub: ProjectWatcherHub;
  registry: ProjectRegistry;
  credentialStore: CredentialStore;
  close: () => Promise<void>;
}

export interface HubAppOptions {
  projects?: ProjectConfig[];
  registry?: ProjectRegistry;
  configPath?: string;
  credentialsPath?: string;
  credentialStore?: CredentialStore;
  managedReposDir?: string;
  allowedImportRoots?: string[];
  clientDistDir?: string;
  enableWatcher?: boolean;
  allowedHosts?: string[];
  rateLimit?: RateLimitOptions | false;
  sse?: WatcherHubOptions;
}

export function createHubApp(options: HubAppOptions): HubAppInstance {
  const app = express();
  const startedAt = Date.now();
  const registry =
    options.registry ??
    new ProjectRegistry({
      projects: options.projects ?? [],
      configPath: options.configPath,
      managedReposDir: options.managedReposDir,
      allowedImportRoots: options.allowedImportRoots
    });
  const resolvedCredsPath =
    options.credentialsPath ??
    (options.configPath
      ? path.join(path.dirname(options.configPath), '.git-credentials.enc.json')
      : undefined);
  const credentialStore =
    options.credentialStore ??
    new CredentialStore({
      credentialsPath: resolvedCredsPath
    });
  const watcherEnabled = options.enableWatcher !== false;

  const watcherHub = new ProjectWatcherHub(options.sse);
  if (watcherEnabled) {
    watcherHub.start(registry.list());
  }

  app.disable('x-powered-by');
  app.use(createHttpSecurity({ allowedHosts: options.allowedHosts }));
  if (options.rateLimit !== false) app.use(createExpensiveRequestLimiter(options.rateLimit));
  app.use(express.json({ limit: '4mb' }));

  function getProjectOrThrow(projectId: string): ProjectConfig {
    const project = registry.get(projectId);
    if (!project) {
      throw new PathBoundaryError(`Unregistered project "${projectId}".`, 404);
    }
    if (!fs.existsSync(project.rootPath)) {
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

  async function browseGitStatus(root: string, signal = AbortSignal.timeout(2_500)) {
    try {
      return await getGitRepoStatus(root, signal);
    } catch {
      return { branch: 'unknown', headSha: '', headSubject: '', isClean: false, changedFiles: [], statusIncomplete: true };
    }
  }

  async function buildProjectSummary(project: ProjectConfig, budget = new ScanBudget(), gitSignal?: AbortSignal): Promise<ProjectSummary> {
    const [git, scan] = await Promise.all([
      browseGitStatus(project.rootPath, gitSignal),
      scanRepository(project, budget)
    ]);
    return {
      ...project,
      git,
      ...scan,
      ...(watcherEnabled && watcherHub.isWatchIncomplete(project.id) ? { watchIncomplete: true } : {})
    };
  }

  async function inspectLocalDirectory(dirPath: string, signal?: AbortSignal): Promise<RepoInspectionResult> {
    const { realRoot } = registry.validateLocalImportDirectory(dirPath);
    const dirSlug = slugifyProjectId(path.basename(realRoot));
    const existing = registry.findByRootPath(realRoot);
    const isGitRepo = fs.existsSync(path.join(realRoot, '.git'));
    const tempProject: ProjectConfig = {
      id: dirSlug,
      name: deriveDisplayNameFromSlug(dirSlug),
      description: '',
      rootPath: realRoot,
      defaultDoc: 'README.md'
    };
    const gitDeadline = AbortSignal.timeout(2_500);
    const [git, { docs, embeds, scanIncomplete }] = await Promise.all([
      browseGitStatus(realRoot, signal ? AbortSignal.any([signal, gitDeadline]) : gitDeadline),
      scanRepository(tempProject, new ScanBudget(undefined, signal))
    ]);

    return {
      valid: true,
      path: realRoot,
      suggestedId: existing ? existing.id : registry.ensureUniqueId(dirSlug),
      suggestedName: deriveDisplayNameFromSlug(path.basename(realRoot)),
      suggestedDefaultDoc: pickSuggestedDefaultDoc(docs),
      docCount: docs.length,
      embedCount: embeds.length,
      ...(scanIncomplete ? { scanIncomplete } : {}),
      isGitRepo,
      branch: isGitRepo ? git.branch : undefined,
      remoteUrl: git.remoteUrl ?? null,
      alreadyRegisteredId: existing?.id ?? null
    };
  }

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });

  // Healthcheck
  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'focuswiki',
      projectCount: registry.list().length,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000)
    });
  });

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

  // Import configuration hints for UI
  app.get('/api/projects/import-config', (_req, res) => {
    res.json({
      managedReposDir: registry.managedReposDir,
      allowedImportRoots: registry.allowedImportRoots,
      canPersistConfig: true
    });
  });

  // Settings: encrypted Git HTTPS credentials (never returns plaintext tokens)
  app.get('/api/settings/credentials', (_req, res) => {
    res.json({
      credentials: credentialStore.list(),
      encryptionMode: credentialStore.getEncryptionMode()
    });
  });

  app.put('/api/settings/credentials', (req, res, next) => {
    try {
      const host = String(req.body?.host ?? '').trim();
      const username =
        typeof req.body?.username === 'string' && req.body.username.trim()
          ? req.body.username.trim()
          : undefined;
      const token = String(req.body?.token ?? '');
      const saved = credentialStore.upsert({ host, username, token });
      res.json({
        credential: saved,
        credentials: credentialStore.list()
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/settings/credentials/:id', (req, res, next) => {
    try {
      const id = decodeURIComponent(req.params.id);
      if (id.startsWith('env:')) {
        res.status(400).json({
          error: 'env_credential_readonly',
          message: 'Environment variable credentials are read-only and must be changed in server env.'
        });
        return;
      }
      const removed = credentialStore.remove(id);
      if (!removed) {
        res.status(404).json({ error: 'not_found', message: 'Credential not found.' });
        return;
      }
      res.json({
        removedId: id,
        credentials: credentialStore.list()
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/settings/credentials/test', async (req, res, next) => {
    try {
      const url = String(req.body?.url ?? '').trim();
      const token =
        typeof req.body?.token === 'string' && req.body.token.trim()
          ? req.body.token.trim()
          : undefined;
      const username =
        typeof req.body?.username === 'string' && req.body.username.trim()
          ? req.body.username.trim()
          : undefined;
      const result = await inspectRemoteRepository(url, {
        credentialStore,
        overrideCredential: token ? { username, token } : undefined,
        allowedFileRoots: registry.allowedImportRoots
      });
      res.json({
        ok: true,
        url: result.url,
        defaultBranch: result.defaultBranch,
        branchCount: result.branches.length,
        prCount: result.pullRequests.length
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/settings/environment', async (_req, res, next) => {
    try {
      const info: ServerEnvironmentInfo = {
        managedReposDir: registry.managedReposDir,
        allowedImportRoots: registry.allowedImportRoots,
        configPath: options.configPath ?? null,
        credentialsPath: credentialStore.credentialsPath,
        encryptionMode: credentialStore.getEncryptionMode(),
        sshClientAvailable: await isSshClientAvailable(),
        projectCount: registry.list().length
      };
      res.json(info);
    } catch (err) {
      next(err);
    }
  });

  // List registered projects + git status + doc tree + discovered embeds
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
    const summaries: ProjectSummary[] = [];
    for (const project of page) {
      signal.throwIfAborted();
      summaries.push(await buildProjectSummary(project, budget.child(), gitSignal));
    }
    const nextOffset = offset + page.length;
    res.json({ projects: summaries, ...(nextOffset < projects.length ? { nextOffset } : {}) });
  }));

  // Inspect a local directory before attaching it as a wiki repository
  app.post('/api/projects/inspect-local', boundedBrowse(async (req, res, signal) => {
    const dirPath = String(req.body?.path ?? '').trim();
    res.json(await inspectLocalDirectory(dirPath, signal));
  }));

  // Inspect a remote Git URL (branches & PR/MR refs) before cloning
  app.post('/api/projects/inspect-remote', async (req, res, next) => {
    try {
      const url = String(req.body?.url ?? '').trim();
      const token =
        typeof req.body?.token === 'string' && req.body.token.trim()
          ? req.body.token.trim()
          : undefined;
      const username =
        typeof req.body?.username === 'string' && req.body.username.trim()
          ? req.body.username.trim()
          : undefined;
      const saveToken = Boolean(req.body?.saveToken);
      const result = await inspectRemoteRepository(url, {
        credentialStore,
        overrideCredential: token ? { username, token } : undefined,
        allowedFileRoots: registry.allowedImportRoots
      });
      const httpsHost = extractHttpsHost(url);
      if (saveToken && token && httpsHost) {
        credentialStore.upsert({ host: httpsHost, username, token });
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Import a repository via clone, local folder link, or fresh initialization
  app.post('/api/projects/import', boundedBrowse(async (req, res, _signal, next) => {
    try {
      const mode = String(req.body?.mode ?? '').trim();
      const requestedName = String(req.body?.name ?? '').trim();
      const requestedId = String(req.body?.id ?? '').trim();
      const requestedDefaultDoc = String(req.body?.defaultDoc ?? '').trim();
      const description = String(req.body?.description ?? '').trim();

      if (mode === 'local') {
        const dirPath = String(req.body?.path ?? '').trim();
        const inspected = await inspectLocalDirectory(dirPath);
        if (inspected.alreadyRegisteredId) {
          res.status(409).json({
            error: 'already_registered',
            message: `Directory is already registered under "${inspected.alreadyRegisteredId}".`
          });
          return;
        }
        const id = requestedId ? slugifyProjectId(requestedId) : inspected.suggestedId;
        const name = requestedName || inspected.suggestedName;
        const defaultDoc = requestedDefaultDoc || inspected.suggestedDefaultDoc;
        const added = registry.add({
          id,
          name,
          description: description || (inspected.remoteUrl ? `Remote: ${inspected.remoteUrl}` : ''),
          rootPath: inspected.path,
          defaultDoc,
          source: {
            originType: 'local-link',
            ...(inspected.remoteUrl ? { remoteUrl: inspected.remoteUrl } : {}),
            importedAt: new Date().toISOString()
          }
        });
        if (watcherEnabled) watcherHub.addProject(added);
        watcherHub.broadcast({
          type: 'projects:updated',
          projectId: added.id,
          reason: 'imported',
          at: new Date().toISOString()
        });
        const summary = await buildProjectSummary(added);
        res.status(201).json({ project: summary });
        return;
      }

      if (mode === 'clone') {
        const shallow = Boolean(req.body?.shallow);
        const url = String(req.body?.url ?? '').trim();
        const branch =
          typeof req.body?.branch === 'string' && req.body.branch.trim()
            ? req.body.branch.trim()
            : undefined;
        const prNumber =
          typeof req.body?.prNumber === 'number' && Number.isInteger(req.body.prNumber) && req.body.prNumber > 0
            ? req.body.prNumber
            : undefined;
        const token =
          typeof req.body?.token === 'string' && req.body.token.trim()
            ? req.body.token.trim()
            : undefined;
        const username =
          typeof req.body?.username === 'string' && req.body.username.trim()
            ? req.body.username.trim()
            : undefined;
        const saveToken = Boolean(req.body?.saveToken);

        const baseSlug = requestedId
          ? slugifyProjectId(requestedId)
          : deriveSlugFromRemoteUrl(url);
        const id = registry.ensureUniqueId(baseSlug);
        const name = requestedName || deriveDisplayNameFromSlug(baseSlug);
        const destDir = registry.resolveManagedCloneTarget(id);

        const gitStatus = await cloneRepository({
          url,
          destDir,
          branch,
          prNumber,
          shallow,
          credentialStore,
          overrideCredential: token ? { username, token } : undefined,
          allowedFileRoots: registry.allowedImportRoots
        });

        const httpsHost = extractHttpsHost(url);
        if (saveToken && token && httpsHost) {
          credentialStore.upsert({ host: httpsHost, username, token });
        }

        const { docs: scannedDocs } = await scanRepository({
          id,
          name,
          description,
          rootPath: destDir,
          defaultDoc: requestedDefaultDoc || 'README.md'
        });
        const defaultDoc = requestedDefaultDoc || pickSuggestedDefaultDoc(scannedDocs);

        try {
          const added = registry.add({
            id,
            name,
            description: description || (gitStatus.remoteUrl ? `Cloned from ${gitStatus.remoteUrl}` : ''),
            rootPath: destDir,
            defaultDoc,
            source: {
              originType: 'managed-clone',
              ...(gitStatus.remoteUrl ? { remoteUrl: gitStatus.remoteUrl } : {}),
              importedAt: new Date().toISOString()
            }
          });
          if (watcherEnabled) watcherHub.addProject(added);
          watcherHub.broadcast({
            type: 'projects:updated',
            projectId: added.id,
            reason: 'imported',
            at: new Date().toISOString()
          });
          const summary = await buildProjectSummary(added);
          res.status(201).json({ project: summary });
        } catch (err) {
          if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
          }
          throw err;
        }
        return;
      }

      if (mode === 'init') {
        const name = requestedName || 'New Documentation Repo';
        const baseSlug = requestedId ? slugifyProjectId(requestedId) : slugifyProjectId(name);
        const id = registry.ensureUniqueId(baseSlug);
        const defaultDoc = requestedDefaultDoc || 'README.md';
        const destDir = registry.resolveManagedCloneTarget(id);

        await initNewWikiRepository({
          destDir,
          title: name,
          defaultDoc
        });

        try {
          const added = registry.add({
            id,
            name,
            description,
            rootPath: destDir,
            defaultDoc,
            source: {
              originType: 'initialized',
              importedAt: new Date().toISOString()
            }
          });
          if (watcherEnabled) watcherHub.addProject(added);
          watcherHub.broadcast({
            type: 'projects:updated',
            projectId: added.id,
            reason: 'imported',
            at: new Date().toISOString()
          });
          const summary = await buildProjectSummary(added);
          res.status(201).json({ project: summary });
        } catch (err) {
          if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
          }
          throw err;
        }
        return;
      }

      res.status(400).json({
        error: 'invalid_import_mode',
        message: 'Import mode must be "clone", "local", or "init".'
      });
    } catch (err) {
      next(err);
    }
  }));

  // Update repository metadata (display name, default page, description)
  app.patch('/api/projects/:projectId', boundedBrowse(async (req, res, _signal, next) => {
    try {
      const existing = getProjectOrThrow(req.params.projectId);
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
      const description =
        typeof req.body?.description === 'string' ? req.body.description.trim() : undefined;
      let defaultDoc: string | undefined;
      if (typeof req.body?.defaultDoc === 'string') {
        const { normalizedRelPath } = resolveSafeProjectPath(
          existing.rootPath,
          req.body.defaultDoc.trim()
        );
        if (!normalizedRelPath.endsWith('.md')) {
          throw new PathBoundaryError('Default page must be a Markdown (.md) file.', 400);
        }
        defaultDoc = normalizedRelPath;
      }

      const updated = registry.update(existing.id, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(defaultDoc !== undefined ? { defaultDoc } : {})
      });
      if (!updated) {
        res.status(404).json({ error: 'not_found', message: `Project "${req.params.projectId}" not found.` });
        return;
      }
      watcherHub.broadcast({
        type: 'projects:updated',
        projectId: updated.id,
        reason: 'updated',
        at: new Date().toISOString()
      });
      const summary = await buildProjectSummary(updated);
      res.json({ project: summary });
    } catch (err) {
      next(err);
    }
  }));

  // Unregister a repository from FocusWiki (leaves repository files untouched on disk)
  app.delete('/api/projects/:projectId', async (req, res, next) => {
    try {
      const removed = registry.remove(req.params.projectId);
      if (!removed) {
        res.status(404).json({ error: 'not_found', message: `Unregistered project "${req.params.projectId}".` });
        return;
      }
      await watcherHub.removeProject(removed.id);
      watcherHub.broadcast({
        type: 'projects:updated',
        projectId: removed.id,
        reason: 'removed',
        at: new Date().toISOString()
      });
      res.json({ removedId: removed.id });
    } catch (err) {
      next(err);
    }
  });

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
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, assetPath);
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
      // Also reject aliases into protected metadata directories inside the repository.
      const realRoot = fs.realpathSync(project.rootPath);
      const realRelative = path.relative(realRoot, fs.realpathSync(absolutePath));
      if (realRelative.split(path.sep).some((part) => !part || part.startsWith('.') || ['.git', '.focuswiki', '.cairn'].includes(part.toLowerCase())) || /\.comments\.json$/i.test(realRelative)) {
        throw new PathBoundaryError('Protected asset target.', 403);
      }
      res.setHeader('Content-Type', MIME_BY_EXT[ext]);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (ext === '.svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.sendFile(realRelative.split(path.sep).join('/'), { root: realRoot, dotfiles: 'deny' }, (err) => { if (err) next(err); });
    } catch (err) {
      next(err);
    }
  });

  // Read Markdown document + AST + resolved comments
  app.get('/api/projects/:projectId/doc', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.query.path ?? project.defaultDoc);
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(
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
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, withExt);
      if (fs.existsSync(absolutePath)) {
        res.status(409).json({ error: 'already_exists', message: `Document "${normalizedRelPath}" already exists.` });
        return;
      }
      const initialMd =
        typeof req.body?.markdown === 'string' && req.body.markdown.trim()
          ? req.body.markdown
          : `# ${title}\n\nStart writing here.\n`;

      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o770 });
      fs.writeFileSync(absolutePath, initialMd, { encoding: 'utf8', mode: 0o660 });

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

      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, rawPath);
      await withKeyLock(fs.existsSync(absolutePath) ? fs.realpathSync(absolutePath) : absolutePath, async () => {
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
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, docParam);
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
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, docParam);
      await withKeyLock(fs.existsSync(absolutePath) ? fs.realpathSync(absolutePath) : absolutePath, async () => {
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
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, docParam);
      await withKeyLock(fs.existsSync(absolutePath) ? fs.realpathSync(absolutePath) : absolutePath, async () => {
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
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, docParam);
      await withKeyLock(fs.existsSync(absolutePath) ? fs.realpathSync(absolutePath) : absolutePath, async () => {
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
      if (!srcParam.startsWith('embeds/')) {
        throw new PathBoundaryError('Embed components must reside under "embeds/".', 400);
      }
      if (!source.trim()) {
        res.status(400).json({ error: 'invalid_source', message: 'Component HTML/JS source is required.' });
        return;
      }
      const { absolutePath, normalizedRelPath } = resolveSafeEmbedAssetPath(
        project.rootPath,
        srcParam
      );
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o770 });
      fs.writeFileSync(absolutePath, source, { encoding: 'utf8', mode: 0o660 });
      res.status(201).json({
        src: normalizedRelPath
      });
    } catch (err) {
      next(err);
    }
  });

  // Git diff & status inspection
  app.get('/api/projects/:projectId/git/diff', boundedBrowse(async (req, res, signal) => {
    const project = getProjectOrThrow(req.params.projectId);
    res.json(await getGitWorkingDiff(project.rootPath, signal));
  }));

  // Deliberate local Git commit (never pushes; preserves user message & identity without forced attribution)
  app.post('/api/projects/:projectId/git/commit', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const message = String(req.body?.message ?? '').trim();
      const authorName =
        typeof req.body?.authorName === 'string' && req.body.authorName.trim()
          ? req.body.authorName.trim()
          : undefined;
      const authorEmail =
        typeof req.body?.authorEmail === 'string' && req.body.authorEmail.trim()
          ? req.body.authorEmail.trim()
          : undefined;
      const expectedSnapshotDigest =
        typeof req.body?.expectedSnapshotDigest === 'string'
          ? req.body.expectedSnapshotDigest.trim()
          : undefined;

      if (!message) {
        res.status(400).json({ error: 'invalid_message', message: 'Commit message is required.' });
        return;
      }

      const paths = Array.isArray(req.body?.paths)
        ? req.body.paths.filter((p: unknown): p is string => typeof p === 'string')
        : undefined;

      const committed = await commitWorkingTree(
        project.rootPath,
        message,
        authorName,
        authorEmail,
        expectedSnapshotDigest,
        paths
      );
      res.json(committed);
    } catch (err) {
      if (err instanceof WorkingTreeSnapshotMismatchError) {
        try {
          const project = getProjectOrThrow(req.params.projectId);
          const latestReview = await getGitWorkingDiff(project.rootPath);
          res.status(409).json({
            error: 'working_tree_changed',
            message: err.message,
            latestReview
          });
          return;
        } catch (innerErr) {
          next(innerErr);
          return;
        }
      }
      next(err);
    }
  });

  // List local/remote branches and PR refs for a project
  app.get('/api/projects/:projectId/git/refs', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const refs = await getGitRefs(project.rootPath);
      res.json(refs);
    } catch (err) {
      next(err);
    }
  });

  // Fetch remote branches and PR/MR refs (non-destructive)
  app.post('/api/projects/:projectId/git/fetch', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const includePrRefs =
        typeof req.body?.includePrRefs === 'boolean' ? req.body.includePrRefs : true;
      const refs = await fetchGitRemote(project.rootPath, credentialStore, {
        includePrRefs,
        allowedFileRoots: registry.allowedImportRoots
      });
      watcherHub.broadcast({
        type: 'projects:updated',
        projectId: project.id,
        reason: 'synced',
        at: new Date().toISOString()
      });
      res.json(refs);
    } catch (err) {
      next(err);
    }
  });

  // Fast-forward pull current branch from upstream remote (requires clean working tree)
  app.post('/api/projects/:projectId/git/pull', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const result = await pullGitRemote(project.rootPath, credentialStore, {
        allowedFileRoots: registry.allowedImportRoots
      });
      watcherHub.broadcast({
        type: 'projects:updated',
        projectId: project.id,
        reason: 'synced',
        at: new Date().toISOString()
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Switch local branch, track remote branch, or check out a PR ref (requires clean working tree)
  app.post('/api/projects/:projectId/git/checkout', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const kindRaw = String(req.body?.kind ?? 'local').trim();
      const kind =
        kindRaw === 'remote' || kindRaw === 'pr' || kindRaw === 'local' ? kindRaw : null;
      if (!kind) {
        res.status(400).json({ error: 'invalid_target', message: 'Checkout kind must be "local", "remote", or "pr".' });
        return;
      }
      const ref = String(req.body?.ref ?? '').trim();
      const prNumber =
        typeof req.body?.prNumber === 'number' ? req.body.prNumber : undefined;

      const result = await checkoutGitTarget(
        project.rootPath,
        { kind, ref, prNumber },
        credentialStore,
        { allowedFileRoots: registry.allowedImportRoots }
      );
      watcherHub.broadcast({
        type: 'projects:updated',
        projectId: project.id,
        reason: 'checkout',
        at: new Date().toISOString()
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Sandboxed static asset server for project-authored browser embeds
  app.get('/embed-sandbox/:projectId/*', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const wildcard = (req.params as Record<string, string>)[0] ?? '';
      const { absolutePath, normalizedRelPath } = resolveSafeEmbedAssetPath(
        project.rootPath,
        wildcard
      );

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
      const allowedProjectAssetPrefix = `${proto}://${host}/embed-sandbox/${encodeURIComponent(project.id)}/`;

      // Strict defense-in-depth CSP:
      // Paired with <iframe sandbox="allow-scripts"> (opaque null origin, NO allow-same-origin),
      // components can run their own inline/sibling scripts & styles, cannot fetch external or hub APIs,
      // and cannot read parent DOM or storage.
      const csp = [
        "default-src 'none'",
        `script-src 'unsafe-inline' ${allowedProjectAssetPrefix}`,
        `style-src 'unsafe-inline' ${allowedProjectAssetPrefix}`,
        `img-src data: blob: ${allowedProjectAssetPrefix}`,
        `font-src data: ${allowedProjectAssetPrefix}`,
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'"
      ].join('; ');

      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', contentType);

      res.sendFile(absolutePath);
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
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PathBoundaryError) {
      res.status(err.statusCode).json({
        error: 'path_boundary_violation',
        message: err.message
      });
      return;
    }
    if (err instanceof WorkingTreeDirtyError) {
      res.status(err.statusCode).json({
        error: 'working_tree_dirty',
        message: err.message
      });
      return;
    }
    if (err instanceof GitAuthError) {
      res.status(err.statusCode).json({
        error: 'auth_required',
        host: err.host,
        message: err.message
      });
      return;
    }
    if (err instanceof GitOperationError) {
      res.status(err.statusCode).json({
        error: 'git_operation_error',
        message: err.message
      });
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
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error('[focuswiki] Unexpected request error:', credentialStore.scrubText(detail));
    res.status(500).json({ error: 'server_error', message: 'Unexpected server error.' });
  });

  return {
    app,
    watcherHub,
    registry,
    credentialStore,
    close: async () => {
      await watcherHub.close();
    }
  };
}
