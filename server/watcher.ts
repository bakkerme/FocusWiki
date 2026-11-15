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

export class ProjectWatcherHub {
  private clients = new Set<Response>();
  private watchers: FSWatcher[] = [];

  public start(projects: ProjectConfig[]): void {
    for (const project of projects) {
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
        let kind: WorkspaceChangeEvent['kind'] = 'other';
        if (relPath.endsWith('.comments.json')) {
          kind = 'comments';
        } else if (relPath.endsWith('.md') && !relPath.startsWith('.cairn/conflicts/')) {
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
      this.watchers.push(watcher);
    }
  }

  public addClient(res: Response): void {
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  public broadcast(event: WorkspaceChangeEvent): void {
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
    await Promise.all(this.watchers.map((w) => w.close()));
    this.watchers = [];
  }
}
