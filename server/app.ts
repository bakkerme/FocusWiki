import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type {
  CommentAnchor,
  ConflictErrorPayload,
  DocTreeEntry,
  DocumentPayload,
  EmbedAssetEntry,
  ProjectConfig,
  ProjectSummary,
  SearchResultItem
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
  resolveSafeEmbedAssetPath,
  resolveSafeProjectPath
} from './pathGuard.js';
import {
  WorkingTreeSnapshotMismatchError,
  commitWorkingTree,
  getGitRepoStatus,
  getGitWorkingDiff
} from './gitService.js';
import {
  addCommentReply,
  createCommentThread,
  readCommentSidecar,
  updateCommentStatus
} from './commentStore.js';
import { ProjectWatcherHub } from './watcher.js';

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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const IGNORED_AGENT_DOC_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

function scanMarkdownDocs(project: ProjectConfig): DocTreeEntry[] {
  const entries: DocTreeEntry[] = [];
  const root = project.rootPath;
  if (!fs.existsSync(root)) return entries;

  function walk(dirAbs: string): void {
    const items = fs.readdirSync(dirAbs, { withFileTypes: true });
    for (const item of items) {
      if (
        item.name.startsWith('.') ||
        item.name === 'node_modules' ||
        item.name === 'embeds'
      ) {
        continue;
      }
      const full = path.join(dirAbs, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (
        item.isFile() &&
        item.name.endsWith('.md') &&
        !IGNORED_AGENT_DOC_NAMES.has(item.name)
      ) {
        const relPath = path.relative(root, full).split(path.sep).join('/');
        const raw = fs.readFileSync(full, 'utf8');
        const stat = fs.statSync(full);
        const sidecar = readCommentSidecar(root, relPath);
        const openComments = sidecar.threads.filter((t) => t.status === 'open').length;
        entries.push({
          path: relPath,
          title: extractDocumentTitle(raw, relPath),
          updatedAt: stat.mtime.toISOString(),
          openComments
        });
      }
    }
  }

  walk(root);

  entries.sort((a, b) => {
    if (a.path === project.defaultDoc) return -1;
    if (b.path === project.defaultDoc) return 1;
    return a.path.localeCompare(b.path);
  });

  return entries;
}

function scanProjectEmbeds(projectRoot: string): EmbedAssetEntry[] {
  const embedsRoot = path.join(projectRoot, 'embeds');
  const results: EmbedAssetEntry[] = [];
  if (!fs.existsSync(embedsRoot) || !fs.statSync(embedsRoot).isDirectory()) {
    return results;
  }

  const subdirs = fs.readdirSync(embedsRoot, { withFileTypes: true });
  for (const dirent of subdirs) {
    if (dirent.isDirectory()) {
      const compDir = path.join(embedsRoot, dirent.name);
      const files = fs
        .readdirSync(compDir)
        .filter((f) => fs.statSync(path.join(compDir, f)).isFile())
        .sort();
      const htmlEntry = files.includes('index.html')
        ? 'index.html'
        : files.find((f) => f.endsWith('.html'));
      if (htmlEntry) {
        results.push({
          src: `embeds/${dirent.name}/${htmlEntry}`,
          name: dirent.name,
          directory: `embeds/${dirent.name}`,
          files
        });
      }
    } else if (dirent.isFile() && dirent.name.endsWith('.html')) {
      results.push({
        src: `embeds/${dirent.name}`,
        name: dirent.name.replace(/\.html$/i, ''),
        directory: 'embeds',
        files: [dirent.name]
      });
    }
  }

  results.sort((a, b) => a.src.localeCompare(b.src));
  return results;
}

function listConflictCopiesForDoc(projectRoot: string, docRelPath: string): string[] {
  const conflictDir = path.join(projectRoot, '.cairn', 'conflicts');
  if (!fs.existsSync(conflictDir)) return [];
  const safePrefix = docRelPath.replace(/[^a-zA-Z0-9._-]/g, '__');
  return fs
    .readdirSync(conflictDir)
    .filter((f) => f.startsWith(`${safePrefix}.`) && f.endsWith('.md'))
    .sort()
    .reverse()
    .map((f) => `.cairn/conflicts/${f}`);
}

export interface HubAppInstance {
  app: Express;
  watcherHub: ProjectWatcherHub;
  close: () => Promise<void>;
}

export function createHubApp(options: {
  projects: ProjectConfig[];
  clientDistDir?: string;
  enableWatcher?: boolean;
}): HubAppInstance {
  const app = express();
  const startedAt = Date.now();
  const projectMap = new Map<string, ProjectConfig>();
  for (const p of options.projects) {
    projectMap.set(p.id, {
      ...p,
      rootPath: fs.existsSync(p.rootPath) ? fs.realpathSync(p.rootPath) : path.resolve(p.rootPath)
    });
  }

  const watcherHub = new ProjectWatcherHub();
  if (options.enableWatcher !== false) {
    watcherHub.start(Array.from(projectMap.values()));
  }

  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  function getProjectOrThrow(projectId: string): ProjectConfig {
    const project = projectMap.get(projectId);
    if (!project) {
      throw new PathBoundaryError(`Unregistered project "${projectId}".`, 404);
    }
    if (!fs.existsSync(project.rootPath)) {
      throw new PathBoundaryError(`Working copy missing for "${projectId}".`, 404);
    }
    return project;
  }

  // Healthcheck
  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'cairn-wiki-hub',
      projectCount: projectMap.size,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000)
    });
  });

  // SSE stream for external file & comment updates
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`);
    watcherHub.addClient(res);
    req.on('close', () => {
      res.end();
    });
  });

  // List registered projects + git status + doc tree + discovered embeds
  app.get('/api/projects', async (_req, res, next) => {
    try {
      const summaries: ProjectSummary[] = [];
      for (const project of projectMap.values()) {
        const git = await getGitRepoStatus(project.rootPath);
        const docs = scanMarkdownDocs(project);
        const embeds = scanProjectEmbeds(project.rootPath);
        summaries.push({
          ...project,
          git,
          docs,
          embeds
        });
      }
      res.json({ projects: summaries });
    } catch (err) {
      next(err);
    }
  });

  // Full-text search across all registered projects
  app.get('/api/search', (req, res, next) => {
    try {
      const q = String(req.query.q ?? '').trim();
      if (!q) {
        res.json({ results: [] });
        return;
      }
      const needle = q.toLowerCase();
      const results: SearchResultItem[] = [];

      for (const project of projectMap.values()) {
        const docs = scanMarkdownDocs(project);
        for (const doc of docs) {
          const { absolutePath } = resolveSafeProjectPath(project.rootPath, doc.path);
          const raw = fs.readFileSync(absolutePath, 'utf8');
          const lines = raw.split(/\r?\n/);
          for (let idx = 0; idx < lines.length; idx++) {
            if (lines[idx].toLowerCase().includes(needle)) {
              results.push({
                projectId: project.id,
                projectName: project.name,
                path: doc.path,
                title: doc.title,
                line: idx + 1,
                snippet: lines[idx].trim().slice(0, 180)
              });
              if (results.length >= 60) break;
            }
          }
          if (results.length >= 60) break;
        }
      }

      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  // Read Markdown document + AST + resolved comments
  app.get('/api/projects/:projectId/doc', (req, res, next) => {
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
      const conflicts = listConflictCopiesForDoc(project.rootPath, normalizedRelPath);

      const payload: DocumentPayload = {
        projectId: project.id,
        path: normalizedRelPath,
        markdown,
        revision: computeRevision(markdown),
        mtimeMs: stat.mtimeMs,
        docJson,
        comments,
        conflicts
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
  app.put('/api/projects/:projectId/doc', (req, res, next) => {
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
      if (!normalizedRelPath.endsWith('.md')) {
        throw new PathBoundaryError('Only Markdown (.md) files can be written via document save.', 400);
      }

      if (fs.existsSync(absolutePath)) {
        const diskMarkdown = fs.readFileSync(absolutePath, 'utf8');
        const diskRevision = computeRevision(diskMarkdown);

        if (!forceOverwrite && baseRevision !== diskRevision && diskMarkdown !== markdown) {
          const conflictDir = path.join(project.rootPath, '.cairn', 'conflicts');
          fs.mkdirSync(conflictDir, { recursive: true, mode: 0o770 });
          const safePrefix = normalizedRelPath.replace(/[^a-zA-Z0-9._-]/g, '__');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const conflictFileName = `${safePrefix}.${stamp}.md`;
          const conflictAbsPath = path.join(conflictDir, conflictFileName);
          fs.writeFileSync(conflictAbsPath, markdown, { encoding: 'utf8', mode: 0o660 });

          const conflictPayload: ConflictErrorPayload = {
            error: 'revision_conflict',
            message:
              'File changed externally on disk since this editor loaded it. Both versions are preserved.',
            path: normalizedRelPath,
            diskRevision,
            diskMarkdown,
            yourMarkdown: markdown,
            savedConflictCopyPath: `.cairn/conflicts/${conflictFileName}`
          };
          res.status(409).json(conflictPayload);
          return;
        }
      } else {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o770 });
      }

      fs.writeFileSync(absolutePath, markdown, { encoding: 'utf8', mode: 0o660 });
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
        conflicts: listConflictCopiesForDoc(project.rootPath, normalizedRelPath)
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
  app.post('/api/projects/:projectId/comments', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.body?.path ?? '');
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, docParam);
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
    } catch (err) {
      next(err);
    }
  });

  // Reply to an existing comment thread
  app.post('/api/projects/:projectId/comments/:threadId/replies', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.body?.path ?? '');
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, docParam);
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
    } catch (err) {
      next(err);
    }
  });

  // Resolve or reopen a comment thread
  app.post('/api/projects/:projectId/comments/:threadId/status', (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const docParam = String(req.body?.path ?? '');
      const { absolutePath, normalizedRelPath } = resolveSafeProjectPath(project.rootPath, docParam);
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
  app.get('/api/projects/:projectId/git/diff', async (req, res, next) => {
    try {
      const project = getProjectOrThrow(req.params.projectId);
      const result = await getGitWorkingDiff(project.rootPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

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

      const committed = await commitWorkingTree(
        project.rootPath,
        message,
        authorName,
        authorEmail,
        expectedSnapshotDigest
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
      const host = req.get('host') ?? '127.0.0.1:8088';
      const proto = req.protocol || 'http';
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
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    res.status(500).json({
      error: 'server_error',
      message
    });
  });

  return {
    app,
    watcherHub,
    close: async () => {
      await watcherHub.close();
    }
  };
}
