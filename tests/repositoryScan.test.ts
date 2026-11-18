import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubApp } from '../server/app.js';
import { getGitWorkingDiff } from '../server/gitService.js';
import { ScanBudget, listConflictCopies, scanRepository, searchRepositories, watchRepositoryDirectories } from '../server/repositoryScan.js';
import { ProjectWatcherHub } from '../server/watcher.js';
import type { ProjectConfig } from '../shared/types.js';

const { fakeWatch } = vi.hoisted(() => ({ fakeWatch: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, watch: fakeWatch };
});

let workspace: string;
let project: ProjectConfig;
let outside: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-scan-'));
  outside = path.join(workspace, 'outside');
  const rootPath = path.join(workspace, 'garden');
  fs.mkdirSync(outside);
  fs.mkdirSync(rootPath);
  project = { id: 'garden', name: 'Garden', description: '', rootPath, defaultDoc: 'README.md' };
});

afterEach(() => {
  fakeWatch.mockReset();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const full = path.join(project.rootPath, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function bounded(overrides: Partial<{ entries: number; files: number; bytes: number; depth: number }> = {}) {
  return new ScanBudget({ entries: 30, files: 10, bytes: 8192, depth: 3, ...overrides });
}

describe('repository discovery', () => {
  it('preserves the default page and reports entry, file, byte and depth limits', async () => {
    write('README.md', '# Garden');
    write('docs/elm.md', '# Elm\n\nCanopy');
    write('docs/trees/oak.md', '# Oak');
    const complete = await scanRepository(project, bounded());
    expect(complete.docs.map((doc) => doc.title)).toEqual(['Garden', 'Elm', 'Oak']);
    expect(complete.scanIncomplete).toBeUndefined();
    for (const limits of [{ entries: 1 }, { files: 1 }, { depth: 0 }]) {
      const result = await scanRepository(project, bounded(limits));
      expect(result.scanIncomplete).toBe(true);
      expect(result.docs[0]?.path).toBe('README.md');
      expect(result.docs).toHaveLength(1);
    }

    expect(await scanRepository(project, bounded({ bytes: 1 }))).toMatchObject({
      scanIncomplete: true, docs: [{ title: 'README' }, { title: 'elm' }, { title: 'oak' }]
    });
    const search = await searchRepositories([project], 'canopy', bounded({ bytes: 1 }));
    expect(search).toEqual({ results: [], scanIncomplete: true });
  });

  it('skips links during discovery and search and refreshes pages and comment counts from disk', async () => {
    write('README.md', '# Garden');
    write('embeds/demo/index.html', '<p>Garden</p>');
    fs.writeFileSync(path.join(outside, 'private.md'), '# Hidden orchid');
    fs.writeFileSync(path.join(outside, 'comments.json'), '{"threads":[{"status":"open"}]}');
    fs.symlinkSync(outside, path.join(project.rootPath, 'link'));
    fs.symlinkSync(outside, path.join(project.rootPath, 'embeds', 'alias'));
    fs.symlinkSync(path.join(outside, 'comments.json'), path.join(project.rootPath, 'README.comments.json'));
    fs.symlinkSync(path.join(outside, 'private.md'), path.join(project.rootPath, 'embeds', 'demo', 'private.txt'));
    expect(await scanRepository(project)).toMatchObject({
      docs: [{ path: 'README.md', title: 'Garden', openComments: 0 }],
      embeds: [{ src: 'embeds/demo/index.html', files: ['index.html'] }]
    });
    expect(await searchRepositories([project], 'orchid', bounded())).toEqual({ results: [] });

    fs.unlinkSync(path.join(project.rootPath, 'README.comments.json'));
    write('README.comments.json', '{"threads":[{"status":"open"},{"status":"resolved"}]}');
    write('README.md', '# Orchard');
    expect((await scanRepository(project)).docs).toMatchObject([{ title: 'Orchard', openComments: 1 }]);

    fs.rmSync(path.join(project.rootPath, 'embeds'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'index.html'), '<p>Outside</p>');
    fs.symlinkSync(outside, path.join(project.rootPath, 'embeds'));
    expect((await scanRepository(project)).embeds).toEqual([]);
  });

  it('reports oversized description and comment metadata without reading the full files', async () => {
    write('README.md', '# Garden\n' + 'a'.repeat(17_000));
    write('README.comments.json', '{"threads":[{"status":"open","body":"' + 'a'.repeat(66_000) + '"}]}');
    expect(await scanRepository(project)).toMatchObject({ scanIncomplete: true, docs: [{ title: 'Garden', openComments: 0 }] });
  });

  it('bounds conflict listings and excludes linked records', async () => {
    for (let i = 0; i < 101; i++) write(`.focuswiki/conflicts/README.md.${i}.md`, '');
    fs.symlinkSync(path.join(outside, 'external.md'), path.join(project.rootPath, '.focuswiki/conflicts/README.md.link.md'));
    const result = await listConflictCopies(project.rootPath, 'README.md');
    expect(result.conflictsIncomplete).toBe(true);
    expect(result.conflicts).toHaveLength(100);
    expect(result.conflicts).not.toContain('.focuswiki/conflicts/README.md.link.md');
  });

  it('honors an aborted signal and shares resource allowances across projects', async () => {
    write('README.md', '# Garden');
    const controller = new AbortController();
    controller.abort();
    await expect(scanRepository(project, new ScanBudget(undefined, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    const aggregate = bounded({ files: 1 });
    expect((await scanRepository(project, aggregate.child())).scanIncomplete).toBeUndefined();
    expect(await scanRepository(project, aggregate.child())).toMatchObject({ scanIncomplete: true, docs: [] });
  });

  it('reports partial browse and inspection and rate-limits repeated local inspection', async () => {
    write('README.md', '# Garden\n' + 'a'.repeat(17_000));
    const hub = createHubApp({
      projects: [project], allowedImportRoots: [workspace], enableWatcher: false,
      rateLimit: { maxRequests: 2, windowMs: 60_000 }
    });
    try {
      const api = request(hub.app);
      const list = await api.get('/api/projects').expect(200);
      expect(list.body.projects[0]).toMatchObject({ scanIncomplete: true, docs: [{ title: 'Garden' }] });
      const inspect = () => api.post('/api/projects/inspect-local').send({ path: project.rootPath });
      expect((await inspect().expect(200)).body).toMatchObject({ scanIncomplete: true, docCount: 1 });
      await inspect().expect(200);
      await inspect().expect(429);
    } finally {
      await hub.close();
    }
  });
});

describe('watch subscriptions', () => {
  it('does not descend into symlinks and stops when the subscription budget refuses a path', async () => {
    fs.mkdirSync(path.join(outside, 'foreign'));
    fs.symlinkSync(outside, path.join(project.rootPath, 'alias'));
    write('docs/grove/page.md', '# Garden');
    const paths: string[] = [];
    expect(await watchRepositoryDirectories(project.rootPath, bounded(), (rel) => {
      paths.push(rel);
      return true;
    })).toBe(true);
    expect(paths).toEqual(['', 'docs', 'docs/grove']);

    const limited: string[] = [];
    expect(await watchRepositoryDirectories(project.rootPath, bounded(), (rel) => {
      if (limited.length === 2) return false;
      limited.push(rel);
      return true;
    })).toBe(false);
    expect(limited).toEqual(['', 'docs']);
  });

  it('reports edits and discovers new directories with native nonrecursive watches', async () => {
    const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    fakeWatch.mockImplementation(nativeFs.watch);
    write('docs/page.md', '# Grove');
    const hub = new ProjectWatcherHub();
    const broadcast = vi.spyOn(hub, 'broadcast');
    try {
      hub.addProject(project);
      await expect.poll(() => fakeWatch.mock.calls.length).toBe(2);
      write('docs/page.md', '# Orchard');
      await expect.poll(() => broadcast.mock.calls.flat()).toContainEqual(expect.objectContaining({
        type: 'workspace:changed', relPath: 'docs/page.md', kind: 'doc'
      }));

      write('docs/trees/oak.md', '# Oak');
      await expect.poll(() => fakeWatch.mock.calls.length).toBe(3);
      write('docs/trees/oak.md', '# Oak Grove');
      await expect.poll(() => broadcast.mock.calls.flat()).toContainEqual(expect.objectContaining({
        type: 'workspace:changed', relPath: 'docs/trees/oak.md', kind: 'doc'
      }));
    } finally {
      await hub.close();
    }
  });

  it('reports a watcher event whose path is unavailable', async () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    fakeWatch.mockReturnValue(watcher);
    const hub = new ProjectWatcherHub();
    const broadcast = vi.spyOn(hub, 'broadcast');
    try {
      hub.addProject(project);
      await expect.poll(() => fakeWatch.mock.calls.length).toBe(1);
      fakeWatch.mock.calls[0][2]('rename', null);
      await expect.poll(() => broadcast.mock.calls.flat()).toContainEqual(expect.objectContaining({
        type: 'projects:updated', reason: 'watch-overflow', projectId: project.id
      }));
    } finally {
      await hub.close();
    }
  });

  it('contains an asynchronous watcher error and closes all watches for the project', async () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    fakeWatch.mockReturnValue(watcher);
    const hub = new ProjectWatcherHub();
    try {
      hub.addProject(project);
      await expect.poll(() => watcher.listenerCount('error')).toBe(1);
      expect(() => watcher.emit('error', new Error('Synthetic watch error'))).not.toThrow();
      expect(watcher.close).toHaveBeenCalledOnce();
      expect(hub.isWatchIncomplete(project.id)).toBe(true);
    } finally {
      await hub.close();
    }
  });
});

describe('aggregate Git review limits', () => {
  it('returns an explicit review error when the changed-file limit is exceeded', async () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: project.rootPath, stdio: 'ignore' });
    for (let index = 0; index < 49; index++) write(`page-${index}.md`, '# Garden');
    await expect(getGitWorkingDiff(project.rootPath)).rejects.toMatchObject({ statusCode: 413, message: expect.stringContaining('review limits') });
  });

  it('rejects oversized worktree inputs and labels a truncated untracked patch', async () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: project.rootPath, stdio: 'ignore' });
    const doc = path.join(project.rootPath, 'README.md');
    write('README.md', '# Garden\n' + 'a'.repeat(17_000));
    const review = await getGitWorkingDiff(project.rootPath);
    expect(review.diff).toContain('Untracked file preview truncated');
    fs.truncateSync(doc, 8 * 1024 * 1024 + 1);
    await expect(getGitWorkingDiff(project.rootPath)).rejects.toMatchObject({ statusCode: 413 });
  });
});
