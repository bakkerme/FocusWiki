import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
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
  reason: 'imported' | 'updated' | 'removed' | 'synced' | 'checkout';
  at: string;
}

export type HubSseEvent = WorkspaceChangeEvent | ProjectsUpdatedEvent;

const IGNORED_AGENT_DOC_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

export class ProjectWatcherHub {
  private clients = new Set<Response>();
  private watchers = new Map<string, FSWatcher>();

  public start(projects: ProjectConfig[]): void {
    for (const project of projects) {
      this.addProject(project);
    }
  }

  public addProject(project: ProjectConfig): void {
    if (this.watchers.has(project.id)) return;
    const watcher = chokidar.watch(project.rootPath, {
      ignoreInitial: true,
      ignored: (watchedPath: string) => {
        const rel = path.relative(project.rootPath, watchedPath).split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) return false;
        const parts = rel.split('/');
        return parts.includes('.git') || parts.includes('node_modules');
      },
      awaitWriteFinish: {
        stabilityThreshold: 80,
        pollInterval: 30
      }
    });

    const emitFor = (absPath: string) => {
      const relPath = path.relative(project.rootPath, absPath).split(path.sep).join('/');
      if (!relPath || relPath.startsWith('..')) return;
      const parts = relPath.split('/');
      const baseName = parts[parts.length - 1] ?? '';
      const inHiddenDir = parts.slice(0, -1).some((p) => p.startsWith('.'));
      let kind: WorkspaceChangeEvent['kind'] = 'other';
      if (relPath.endsWith('.comments.json') && !inHiddenDir) {
        kind = 'comments';
      } else if (
        relPath.endsWith('.md') &&
        !inHiddenDir &&
        !baseName.startsWith('.') &&
        !IGNORED_AGENT_DOC_NAMES.has(baseName) &&
        !relPath.startsWith('embeds/')
      ) {
        kind = 'doc';
      } else if (relPath.startsWith('embeds/')) {
        kind = 'embed';
      }
      this.broadcast({
        type: 'workspace:changed',
        projectId: project.id,
        relPath,
        kind,
        at: new Date().toISOString()
      });
    };

    watcher.on('add', emitFor);
    watcher.on('change', emitFor);
    watcher.on('unlink', emitFor);
    this.watchers.set(project.id, watcher);
  }

  public async removeProject(projectId: string): Promise<void> {
    const existing = this.watchers.get(projectId);
    if (!existing) return;
    this.watchers.delete(projectId);
    await existing.close();
  }

  public addClient(res: Response): void {
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  public broadcast(event: HubSseEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  public async close(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    await Promise.all(Array.from(this.watchers.values()).map((w) => w.close()));
    this.watchers.clear();
  }
}
