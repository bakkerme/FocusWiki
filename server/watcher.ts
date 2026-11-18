import type { FSWatcher } from 'node:fs';
import { repositoryEntry, ScanBudget, watchRepositoryDirectories } from './repositoryScan.js';
import type { Response } from 'express';
import type { ProjectConfig } from '../shared/types.js';

export interface WorkspaceChangeEvent {
  type: 'workspace:changed';
  projectId: string;
  relPath: string;
  kind: 'doc' | 'comments' | 'embed' | 'other';
  at: string;
}

export interface ProjectsUpdatedEvent {
  type: 'projects:updated';
  projectId?: string;
  reason: 'imported' | 'updated' | 'removed' | 'synced' | 'checkout' | 'watch-overflow';
  at: string;
}

export type HubSseEvent = WorkspaceChangeEvent | ProjectsUpdatedEvent;

const IGNORED_AGENT_DOC_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
const MAX_WATCHED_PROJECTS = 32;
const MAX_WATCHES_PER_PROJECT = 128;
const MAX_PENDING_EVENTS = 128;

interface ProjectWatch {
  controller: AbortController;
  directories: Map<string, { watcher: FSWatcher; isCurrent: () => Promise<boolean> }>;
  pending: Map<string, boolean>;
  timer?: NodeJS.Timeout;
  scan?: Promise<void>;
  flush?: Promise<void>;
  incomplete: boolean;
  overflow: boolean;
  failed: boolean;
}

export interface WatcherHubOptions {
  maxClients?: number;
  heartbeatMs?: number;
}

export class ProjectWatcherHub {
  private clients = new Map<Response, () => void>();
  private readonly maxClients: number;
  private readonly heartbeatMs: number;

  constructor(options: WatcherHubOptions = {}) {
    const positive = (value: number, fallback: number) => Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
    this.maxClients = positive(options.maxClients ?? Number(process.env.FOCUSWIKI_SSE_MAX_CLIENTS ?? 64), 64);
    this.heartbeatMs = positive(options.heartbeatMs ?? Number(process.env.FOCUSWIKI_SSE_HEARTBEAT_MS ?? 15000), 15000);
  }

  public get clientCount(): number { return this.clients.size; }
  private watchers = new Map<string, ProjectWatch>();

  public start(projects: ProjectConfig[]): void {
    for (const project of projects) this.addProject(project);
  }

  public isWatchIncomplete(projectId: string): boolean {
    const state = this.watchers.get(projectId);
    return !state || state.incomplete || state.failed;
  }

  public addProject(project: ProjectConfig): void {
    if (this.watchers.has(project.id) || this.watchers.size >= MAX_WATCHED_PROJECTS) return;
    const state: ProjectWatch = {
      controller: new AbortController(),
      directories: new Map(),
      pending: new Map(),
      incomplete: false,
      overflow: false,
      failed: false
    };
    this.watchers.set(project.id, state);
    this.discover(project, state);
  }

  private invalidate(projectId: string, reason: 'updated' | 'watch-overflow' = 'updated'): void {
    this.broadcast({ type: 'projects:updated', projectId, reason, at: new Date().toISOString() });
  }

  private fail(projectId: string, state: ProjectWatch): void {
    if (state.failed || state.controller.signal.aborted) return;
    state.failed = true;
    this.stop(state);
    this.invalidate(projectId);
  }

  private discover(project: ProjectConfig, state: ProjectWatch): void {
    if (state.scan || state.controller.signal.aborted) return;
    const budget = new ScanBudget({ entries: 4_000, files: 0, bytes: 0, depth: 16 }, state.controller.signal);
    const seen = new Set<string>();
    state.scan = watchRepositoryDirectories(project.rootPath, budget, (rel, openWatch, isCurrent) => {
      if (state.controller.signal.aborted || seen.size >= MAX_WATCHES_PER_PROJECT) return false;
      seen.add(rel);
      if (!state.directories.has(rel)) {
        if (state.directories.size >= MAX_WATCHES_PER_PROJECT) return false;
        const watcher = openWatch((event, name) => this.queue(project, state, rel, event, name));
        watcher.on('error', () => this.fail(project.id, state));
        state.directories.set(rel, { watcher, isCurrent });
      }
      return true;
    }).then((complete) => {
      for (const [rel, { watcher }] of state.directories) {
        if (seen.has(rel)) continue;
        watcher.close();
        state.directories.delete(rel);
      }
      if (state.incomplete !== !complete && !state.controller.signal.aborted) {
        state.incomplete = !complete;
        this.invalidate(project.id);
      }
    }).catch(() => this.fail(project.id, state)).finally(() => {
      state.scan = undefined;
    });
  }

  private queue(project: ProjectConfig, state: ProjectWatch, dir: string, event: string, name: string | null): void {
    if (state.controller.signal.aborted) return;
    if (name && (name.startsWith('.') || name === 'node_modules' || /[\\/]/.test(name))) return;
    if (!name || state.pending.size >= MAX_PENDING_EVENTS) {
      state.overflow = true;
    } else {
      const rel = dir ? dir + '/' + name : name;
      state.pending.set(rel, event === 'rename' || state.pending.get(rel) === true);
    }
    this.scheduleFlush(project, state);
  }

  private scheduleFlush(project: ProjectConfig, state: ProjectWatch): void {
    if (state.timer || state.flush || state.controller.signal.aborted) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.flush = this.flush(project, state).catch(() => this.fail(project.id, state)).finally(() => {
        state.flush = undefined;
        if (state.pending.size || state.overflow) this.scheduleFlush(project, state);
      });
    }, 180);
    state.timer.unref();
  }

  private async flush(project: ProjectConfig, state: ProjectWatch): Promise<void> {
    const pending = state.pending;
    state.pending = new Map();
    let rediscover = state.overflow;
    if (state.overflow) this.invalidate(project.id, 'watch-overflow');
    state.overflow = false;
    const checked = new Map<string, boolean>();
    for (const [relPath, renamed] of pending) {
      const parent = relPath.slice(0, Math.max(0, relPath.lastIndexOf('/')));
      let current = checked.get(parent);
      if (current === undefined) {
        current = (await state.directories.get(parent)?.isCurrent()) === true;
        checked.set(parent, current);
      }
      if (!current) {
        this.removeDirectoryWatches(state, parent);
        rediscover = true;
        continue;
      }
      if (state.controller.signal.aborted) return;
      if (renamed) {
        const entry = await repositoryEntry(project.rootPath, relPath);
        if (state.directories.has(relPath)) {
          this.removeDirectoryWatches(state, relPath);
          rediscover = true;
        }
        if (entry?.isDirectory()) rediscover = true;
        if (entry?.isSymbolicLink()) continue;
      }
      if (state.controller.signal.aborted) return;
      const baseName = relPath.split('/').at(-1) ?? '';
      const kind = relPath.startsWith('embeds/') ? 'embed'
        : relPath.endsWith('.comments.json') ? 'comments'
        : relPath.endsWith('.md') && !IGNORED_AGENT_DOC_NAMES.has(baseName) ? 'doc' : 'other';
      this.broadcast({ type: 'workspace:changed', projectId: project.id, relPath, kind, at: new Date().toISOString() });
    }
    if (rediscover) {
      await state.scan;
      this.discover(project, state);
    }
  }

  private removeDirectoryWatches(state: ProjectWatch, relPath: string): void {
    for (const [watchedPath, { watcher }] of state.directories) {
      if (relPath && watchedPath !== relPath && !watchedPath.startsWith(relPath + '/')) continue;
      watcher.close();
      state.directories.delete(watchedPath);
    }
  }

  private stop(state: ProjectWatch): void {
    state.controller.abort();
    clearTimeout(state.timer);
    state.pending.clear();
    this.removeDirectoryWatches(state, '');
  }

  public async removeProject(projectId: string): Promise<void> {
    const state = this.watchers.get(projectId);
    if (!state) return;
    this.stop(state);
    await Promise.all([state.scan, state.flush]);
    this.watchers.delete(projectId);
  }

  /** Reserve capacity before the route sends stream headers. */
  public addClient(res: Response): boolean {
    if (this.clients.has(res)) return true;
    if (this.clients.size >= this.maxClients || res.destroyed || res.writableEnded) return false;
    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
      res.off('close', cleanup);
      res.off('error', disconnect);
    };
    const disconnect = () => {
      cleanup();
      res.destroy();
    };
    const heartbeat = setInterval(() => {
      this.writeClient(res, ': heartbeat\n\n');
    }, this.heartbeatMs);
    heartbeat.unref();
    this.clients.set(res, cleanup);
    res.once('close', cleanup);
    res.once('error', disconnect);
    return true;
  }

  private writeClient(client: Response, payload: string): void {
    try {
      if (!client.destroyed && !client.writableEnded && client.write(payload)) return;
    } catch {
      // Broken sockets and slow consumers must not retain buffered events indefinitely.
    }
    this.clients.get(client)?.();
    client.destroy();
  }

  public broadcast(event: HubSseEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients.keys()) this.writeClient(client, payload);
  }

  public async close(): Promise<void> {
    for (const [client, cleanup] of this.clients) {
      cleanup();
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await Promise.all(Array.from(this.watchers.keys(), (id) => this.removeProject(id)));
  }
}
