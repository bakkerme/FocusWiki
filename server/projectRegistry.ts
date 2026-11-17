import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../shared/types.js';
import { PathBoundaryError } from './pathGuard.js';

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FORBIDDEN_ROOT_NAMES = new Set(['.git', 'node_modules', '.focuswiki', '.cairn']);

export function slugifyProjectId(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 64);
  return cleaned || 'wiki-repo';
}

export function deriveDisplayNameFromSlug(slug: string): string {
  const base = slug.replace(/\.git$/i, '').replace(/[-_]+/g, ' ').trim();
  if (!base) return 'Imported Repository';
  return base.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function deriveSlugFromRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\/+$/, '');
  const scpMatch = trimmed.match(/[:/]([^/:]+?)(?:\.git)?$/);
  const raw = scpMatch?.[1] ?? trimmed;
  return slugifyProjectId(raw);
}

export interface ProjectRegistryOptions {
  projects: ProjectConfig[];
  configPath?: string;
  baseDir?: string;
  managedReposDir?: string;
  allowedImportRoots?: string[];
}

export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectConfig>();
  public readonly configPath: string | null;
  public readonly baseDir: string;
  public readonly managedReposDir: string;
  public readonly allowedImportRoots: string[];

  constructor(options: ProjectRegistryOptions) {
    this.configPath = options.configPath ? path.resolve(options.configPath) : null;
    this.baseDir = options.baseDir
      ? path.resolve(options.baseDir)
      : this.configPath
        ? path.resolve(path.dirname(this.configPath), '..')
        : process.cwd();
    this.managedReposDir = options.managedReposDir
      ? path.resolve(options.managedReposDir)
      : path.join(this.baseDir, 'repos');

    const rawRoots =
      options.allowedImportRoots && options.allowedImportRoots.length > 0
        ? options.allowedImportRoots
        : [this.baseDir, this.managedReposDir];

    this.allowedImportRoots = Array.from(
      new Set(
        rawRoots
          .map((r) => path.resolve(r))
          .map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : r))
      )
    );

    for (const proj of options.projects) {
      this.projects.set(proj.id, {
        ...proj,
        rootPath: fs.existsSync(proj.rootPath)
          ? fs.realpathSync(proj.rootPath)
          : path.resolve(proj.rootPath)
      });
    }
  }

  public list(): ProjectConfig[] {
    return Array.from(this.projects.values());
  }

  public get(projectId: string): ProjectConfig | undefined {
    return this.projects.get(projectId);
  }

  public has(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  public findByRootPath(candidatePath: string): ProjectConfig | undefined {
    const resolved = fs.existsSync(candidatePath)
      ? fs.realpathSync(candidatePath)
      : path.resolve(candidatePath);
    for (const proj of this.projects.values()) {
      const existing = fs.existsSync(proj.rootPath)
        ? fs.realpathSync(proj.rootPath)
        : path.resolve(proj.rootPath);
      if (existing === resolved) {
        return proj;
      }
    }
    return undefined;
  }

  public ensureUniqueId(desired: string): string {
    const base = slugifyProjectId(desired);
    if (!this.projects.has(base)) return base;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${base.slice(0, 58)}-${i}`;
      if (!this.projects.has(candidate)) return candidate;
    }
    return `${base.slice(0, 54)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  public resolveManagedCloneTarget(slug: string): string {
    const safeSlug = slugifyProjectId(slug);
    if (!PROJECT_ID_RE.test(safeSlug)) {
      throw new PathBoundaryError(`Invalid repository id "${safeSlug}".`, 400);
    }
    fs.mkdirSync(this.managedReposDir, { recursive: true, mode: 0o770 });
    const realManaged = fs.realpathSync(this.managedReposDir);
    const target = path.resolve(realManaged, safeSlug);
    if (!target.startsWith(realManaged + path.sep)) {
      throw new PathBoundaryError('Clone destination escapes managed repository directory.', 403);
    }
    return target;
  }

  public validateLocalImportDirectory(userPath: string): {
    realRoot: string;
    displayPath: string;
  } {
    if (typeof userPath !== 'string' || !userPath.trim()) {
      throw new PathBoundaryError('Directory path is required.', 400);
    }
    if (userPath.includes('\0')) {
      throw new PathBoundaryError('Invalid characters in directory path.', 400);
    }

    const trimmed = userPath.trim();
    const resolvedCandidate = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(this.baseDir, trimmed);

    if (!fs.existsSync(resolvedCandidate)) {
      throw new PathBoundaryError(`Directory does not exist: ${resolvedCandidate}`, 404);
    }
    if (!fs.statSync(resolvedCandidate).isDirectory()) {
      throw new PathBoundaryError(`Path is not a directory: ${resolvedCandidate}`, 400);
    }

    const realRoot = fs.realpathSync(resolvedCandidate);
    const parsed = path.parse(realRoot);
    if (realRoot === parsed.root) {
      throw new PathBoundaryError('Cannot register filesystem root as a repository.', 403);
    }

    const segments = realRoot.split(path.sep).filter(Boolean);
    if (segments.some((seg) => FORBIDDEN_ROOT_NAMES.has(seg))) {
      throw new PathBoundaryError('Cannot register internal .git, node_modules, .focuswiki, or .cairn directory.', 403);
    }

    const insideAllowed = this.allowedImportRoots.some(
      (allowedRoot) => realRoot === allowedRoot || realRoot.startsWith(allowedRoot + path.sep)
    );
    if (!insideAllowed) {
      throw new PathBoundaryError(
        `Directory "${realRoot}" is outside allowed repository roots (${this.allowedImportRoots.join(', ')}).`,
        403
      );
    }

    return {
      realRoot,
      displayPath: realRoot
    };
  }

  public add(project: ProjectConfig): ProjectConfig {
    const id = project.id.trim();
    if (!PROJECT_ID_RE.test(id)) {
      throw new PathBoundaryError(
        'Project ID must start with a lowercase letter or digit and use only [a-z0-9._-].',
        400
      );
    }
    if (this.projects.has(id)) {
      throw new PathBoundaryError(`Repository "${id}" is already registered.`, 409);
    }

    const realRoot = fs.existsSync(project.rootPath)
      ? fs.realpathSync(project.rootPath)
      : path.resolve(project.rootPath);

    const existingSamePath = this.findByRootPath(realRoot);
    if (existingSamePath) {
      throw new PathBoundaryError(
        `Directory is already registered as "${existingSamePath.name}" (${existingSamePath.id}).`,
        409
      );
    }

    const normalized: ProjectConfig = {
      id,
      name: project.name.trim() || deriveDisplayNameFromSlug(id),
      description: project.description.trim(),
      rootPath: realRoot,
      defaultDoc: project.defaultDoc.trim() || 'README.md',
      ...(project.source ? { source: project.source } : {})
    };

    this.projects.set(id, normalized);
    try {
      this.persist();
    } catch (err) {
      this.projects.delete(id);
      throw err;
    }
    return normalized;
  }

  public update(
    projectId: string,
    patch: { name?: string; description?: string; defaultDoc?: string }
  ): ProjectConfig | undefined {
    const existing = this.projects.get(projectId);
    if (!existing) return undefined;

    const nextName =
      typeof patch.name === 'string' ? patch.name.trim() : existing.name;
    if (!nextName) {
      throw new PathBoundaryError('Repository display name cannot be empty.', 400);
    }

    const nextDefaultDoc =
      typeof patch.defaultDoc === 'string' ? patch.defaultDoc.trim() : existing.defaultDoc;
    if (!nextDefaultDoc) {
      throw new PathBoundaryError('Default page path cannot be empty.', 400);
    }

    const updated: ProjectConfig = {
      ...existing,
      name: nextName,
      description:
        typeof patch.description === 'string' ? patch.description.trim() : existing.description,
      defaultDoc: nextDefaultDoc
    };

    this.projects.set(projectId, updated);
    try {
      this.persist();
    } catch (err) {
      this.projects.set(projectId, existing);
      throw err;
    }
    return updated;
  }

  public remove(projectId: string): ProjectConfig | undefined {
    const existing = this.projects.get(projectId);
    if (!existing) return undefined;
    this.projects.delete(projectId);
    try {
      this.persist();
    } catch (err) {
      this.projects.set(projectId, existing);
      throw err;
    }
    return existing;
  }

  private persist(): void {
    if (!this.configPath) return;

    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
    const configAnchor = path.resolve(dir, '..');

    const serializable = Array.from(this.projects.values()).map((proj) => {
      const rel = path.relative(configAnchor, proj.rootPath);
      const useRelative = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      return {
        id: proj.id,
        name: proj.name,
        description: proj.description,
        rootPath: useRelative ? rel.split(path.sep).join('/') : proj.rootPath,
        defaultDoc: proj.defaultDoc,
        ...(proj.source ? { source: proj.source } : {})
      };
    });

    const payload = `${JSON.stringify({ projects: serializable }, null, 2)}\n`;
    const tmpPath = path.join(
      dir,
      `projects.json.tmp-${process.pid}-${crypto.randomUUID()}`
    );
    try {
      fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o660, flag: 'wx' });
      fs.renameSync(tmpPath, this.configPath);
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup failure
        }
      }
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
        throw new PathBoundaryError(
          `Cannot persist project registry to ${this.configPath} (${code}). Mount config directory writable to save imported repositories.`,
          500
        );
      }
      throw err;
    }
  }
}
