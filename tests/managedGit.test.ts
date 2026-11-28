import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubApp, type HubAppInstance } from '../server/app.js';
import { loadEnrollment, loadEnrollmentEntries } from '../server/enrollment.js';
import { GitQueue } from '../server/gitQueue.js';
import type { ProposalContext, ProposalService } from '../server/gitProtocol.js';
import { startGitRunner } from '../server/gitRunner.js';
import { GitSocketClient } from '../server/gitSocketClient.js';
import { ProjectRegistry } from '../server/projectRegistry.js';

const fixture = vi.hoisted(() => ({
  source: '',
  fetches: [] as string[][],
  fetchEnvs: [] as Array<NodeJS.ProcessEnv | undefined>
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(command: string, args: string[], options: Parameters<typeof actual.spawn>[2] & { env?: NodeJS.ProcessEnv }) {
      const fetchIndex = args.indexOf('fetch');
      if (command !== '/usr/bin/git' || fetchIndex < 0) return actual.spawn(command, args, options);

      const remote = args[fetchIndex + 6];
      const allowed = new Set([
        'https://github.com/fictional-observatory/amber-wiki.git',
        'https://git.invalid.ts.net/fictional-lan/lan-docs.git'
      ]);
      if (!allowed.has(remote) || !fixture.source) {
        throw new Error('Only disposable test transport is allowed.');
      }
      const origin = new URL(remote).origin;
      expect(options.env?.GIT_CONFIG_KEY_0).toBe(`http.${origin}/.extraHeader`);
      expect(options.env?.GIT_CONFIG_VALUE_0).toBe('Authorization: Basic ' +
        Buffer.from('x-access-token:fictional-read-token').toString('base64'));
      expect(args.join(' ')).not.toContain('fictional-read-token');
      fixture.fetches.push(args);
      fixture.fetchEnvs.push({ ...options.env });
      const localArgs = [...args.slice(0, fetchIndex), '-c', 'protocol.file.allow=always', ...args.slice(fetchIndex)];
      localArgs[fetchIndex + 8] = fixture.source;
      const env = { ...options.env };
      delete env.GIT_CONFIG_COUNT;
      delete env.GIT_CONFIG_KEY_0;
      delete env.GIT_CONFIG_VALUE_0;
      delete env.GIT_CONFIG_KEY_1;
      delete env.GIT_CONFIG_VALUE_1;
      delete env.GIT_CONFIG_KEY_2;
      delete env.GIT_CONFIG_VALUE_2;
      return actual.spawn(command, localArgs, { ...options, env });
    }
  };
});

const entry = {
  id: 'amber', name: 'Amber Observatory', remote: 'https://github.com/Fictional-Observatory/Amber-Wiki',
  branch: 'main', defaultDoc: 'README.md'
};
const proposalInput = { reviewId: 'test-review', message: 'Calibrate fictional optics', paths: ['README.md'] };

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('managed Git service', () => {
  let root: string;
  let reposDir: string;
  let stateDir: string;
  let enrollmentFile: string;
  let socketPath: string;
  let workTree: string;
  let gitDir: string;
  let hub: HubAppInstance | undefined;
  let runner: Awaited<ReturnType<typeof startGitRunner>> | undefined;

  beforeEach(() => {
    fixture.source = '';
    fixture.fetches.length = 0;
    fixture.fetchEnvs.length = 0;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-git-'));
    reposDir = path.join(root, 'repos');
    stateDir = path.join(root, 'state');
    const socketDir = path.join(root, 'socket');
    for (const dir of [reposDir, stateDir, socketDir]) fs.mkdirSync(dir, { mode: 0o700 });
    workTree = path.join(reposDir, entry.id);
    gitDir = path.join(stateDir, entry.id, 'git');
    socketPath = path.join(socketDir, 'git.sock');
    enrollmentFile = path.join(root, 'enrollment.json');
    fs.writeFileSync(enrollmentFile, JSON.stringify({ projects: [entry] }), { mode: 0o444 });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await hub?.close();
    await runner?.close();
    hub = undefined;
    runner = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function start(proposalService?: ProposalService) {
    runner = await startGitRunner({ enrollmentFile, reposDir, stateDir, socketPath, proposalService });
    return new GitSocketClient(socketPath);
  }

  function app(auth?: 'allow' | 'deny', branch = 'main', actor = 'fictional-reviewer') {
    const projects = loadEnrollment(enrollmentFile).map((project) => ({ ...project, branch }));
    return createHubApp({
      registry: new ProjectRegistry([], { projects, reposDir }),
      gitSocketPath: socketPath,
      proposalAuth: auth === 'allow' ? (_req, res, next) => {
        res.locals.proposalActor = actor;
        next();
      } :
        auth === 'deny' ? (_req, res) => { res.sendStatus(403); } : undefined,
      enableWatcher: false
    });
  }

  function upstream() {
    fixture.source = path.join(root, 'upstream');
    fs.mkdirSync(fixture.source);
    git(fixture.source, ['init', '-b', 'main']);
    git(fixture.source, ['config', 'user.name', 'Fictional optical bench maintainer']);
    git(fixture.source, ['config', 'user.email', 'optics@example.invalid']);
    fs.writeFileSync(path.join(fixture.source, 'README.md'), '# Amber Observatory\n');
    git(fixture.source, ['add', 'README.md']);
    git(fixture.source, ['commit', '-m', 'Initial fictional optics document']);
    return git(fixture.source, ['rev-parse', 'HEAD']);
  }

  function companion(base: string): ProposalService {
    return {
      enforcesManagedBase: true,
      getRepoToken: vi.fn(async (ctx: ProposalContext, mode) => {
        expect(mode).toBe('read');
        expect(ctx).toMatchObject({ gitDir, remote: 'https://github.com/fictional-observatory/amber-wiki.git', branch: 'focuswiki/bootstrap' });
        expect(fs.statSync(ctx.workTree).isDirectory()).toBe(true);
        return 'fictional-read-token';
      }),
      reviewProposal: vi.fn(async () => ({
        reviewId: 'test-review', snapshotDigest: 'test-snapshot', diff: 'reviewed text', commitScopeNote: '',
        files: [], status: {
          branch: 'main', headSha: base, headSubject: '', isClean: false,
          changedFiles: [{ path: 'README.md', status: 'modified' }]
        }
      })),
      publishProposal: vi.fn(async () => ({
        url: 'https://github.com/Fictional-Observatory/Amber-Wiki/pull/7', sha: base
      }))
    };
  }

  it('rejects non-canonical authority, duplicate IDs, filesystem paths, and dangerous refs in enrollment', () => {
    const cases = [
      [{ ...entry, remote: 'file:///fictional/wiki.git' }],
      [{ ...entry, remote: 'https://github.com.example.test/fictional/wiki' }],
      [{ ...entry, remote: 'https://fictional@github.com/fictional/wiki' }],
      [{ ...entry, remote: 'https://github.com:443/fictional/wiki' }],
      [{ ...entry, remote: 'https://github.com/fictional/wiki?ref=main' }],
      [{ ...entry, remote: 'https://github.com/fictional/%2e%2e' }],
      [{ ...entry, rootPath: '/fictional/wiki' }],
      [{ ...entry, id: '../fictional' }],
      [{ ...entry, branch: 'main:refs/heads/fictional' }],
      [{ ...entry, branch: 'main/.hidden' }],
      [{ ...entry, defaultDoc: '.git/index.md' }],
      [entry, entry]
    ];
    const candidate = path.join(root, 'candidate.json');
    for (const projects of cases) {
      fs.writeFileSync(candidate, JSON.stringify({ projects }));
      expect(() => loadEnrollment(candidate)).toThrow('Invalid managed project');
    }
  });

  it('keeps existing working files browsable and fails closed without worker or auth dependencies', async () => {
    fs.mkdirSync(path.join(workTree, '.git'), { recursive: true });
    fs.writeFileSync(path.join(workTree, '.git', 'config'), 'fictional legacy metadata');
    fs.writeFileSync(path.join(workTree, 'README.md'), '# Keep my local draft\n');
    hub = app();
    const list = await request(hub.app).get('/api/projects').expect(200);
    expect(list.body.projects[0]).toMatchObject({
      workingTreeAvailable: true,
      git: { state: 'unavailable', isClean: null, headSha: '' },
      docs: [{ path: 'README.md' }]
    });
    await request(hub.app).get('/api/projects/amber/doc').expect(200);
    await request(hub.app).get('/api/search?q=local%20draft').expect(200).expect(({ body }) => {
      expect(body.results).toHaveLength(1);
    });
    for (const route of [
      '/api/projects/import', '/api/projects/inspect-remote', '/api/projects/inspect-local',
      '/api/settings/credentials/test', '/api/projects/amber/git/commit', '/api/projects/amber/git/pull',
      '/api/projects/amber/git/fetch', '/api/projects/amber/git/checkout', '/api/projects/amber/git/push'
    ]) await request(hub.app).post(route).send({ url: 'file:///fictional/repo' }).expect(410);
    await request(hub.app).get('/api/settings/credentials').expect(410);
    await request(hub.app).get('/api/projects/amber/git/refs').expect(410);
    await request(hub.app).delete('/api/projects/amber').expect(410);
    await request(hub.app).get('/api/projects/amber/git/diff').expect(503);
    await request(hub.app).post('/api/projects/amber/git/propose').send(proposalInput).expect(503);

    const service = companion('0'.repeat(40));
    const client = await start(service);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o660);
    await expect(client.review(loadEnrollment(enrollmentFile)[0], 'fictional-reviewer')).rejects.toMatchObject({ code: 'git_not_ready' });
    expect(service.reviewProposal).not.toHaveBeenCalled();
    expect(service.getRepoToken).not.toHaveBeenCalled();
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(fs.readFileSync(path.join(workTree, '.git', 'config'), 'utf8')).toBe('fictional legacy metadata');
  });

  it('materializes only the initial base, reports dirty status, fetches updates and dispatches authenticated proposals', async () => {
    const base = upstream();
    const service = companion(base);
    const client = await start(service);
    await vi.waitFor(async () => {
      expect((await client.statuses()).amber).toMatchObject({
        state: 'ready', headSha: base, isClean: true, fetchState: 'current', behind: 0
      });
    }, { timeout: 10_000 });
    expect(fs.existsSync(path.join(workTree, '.git'))).toBe(false);
    expect(fs.readFileSync(path.join(workTree, 'README.md'), 'utf8')).toBe('# Amber Observatory\n');
    expect(git(gitDir, ['--git-dir=.', 'symbolic-ref', 'HEAD'])).toBe('refs/heads/main');

    fs.writeFileSync(path.join(workTree, 'README.md'), '# An external draft\n');
    fs.writeFileSync(path.join(workTree, 'local-only.md'), '# A new local page\n');
    fs.mkdirSync(path.join(workTree, '.focuswiki'));
    fs.writeFileSync(path.join(workTree, '.focuswiki', 'recovery.md'), '# Recover this draft\n');
    fs.writeFileSync(path.join(fixture.source, 'README.md'), '# A different upstream revision\n');
    git(fixture.source, ['add', 'README.md']);
    git(fixture.source, ['commit', '-m', 'Change the upstream draft base']);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + 65_000);

    await vi.waitFor(async () => {
      expect((await client.statuses()).amber).toMatchObject({
        state: 'ready', headSha: base, isClean: false, behind: 1, fetchState: 'current',
        changedFiles: [{ path: 'README.md' }, { path: 'local-only.md' }]
      });
    }, { timeout: 10_000 });
    expect(fixture.fetches).toHaveLength(2);
    expect(fixture.fetches[0].at(-1)).toBe('+refs/heads/main:refs/remotes/origin/main');
    expect(fs.readFileSync(path.join(workTree, 'README.md'), 'utf8')).toBe('# An external draft\n');
    expect(fs.readFileSync(path.join(workTree, 'local-only.md'), 'utf8')).toBe('# A new local page\n');
    expect(fs.readFileSync(path.join(workTree, '.focuswiki/recovery.md'), 'utf8')).toBe('# Recover this draft\n');

    const unauthorized = app('deny');
    await request(unauthorized.app).get('/api/projects/amber/git/diff').expect(403);
    await request(unauthorized.app).post('/api/projects/amber/git/propose').send(proposalInput).expect(403);
    await unauthorized.close();
    expect(service.reviewProposal).not.toHaveBeenCalled();
    expect(service.publishProposal).not.toHaveBeenCalled();

    hub = app('allow');
    await request(hub.app).get('/api/projects').expect(200).expect(({ body }) => {
      expect(body.projects[0].git).toMatchObject({ state: 'ready', behind: 1 });
    });
    const review = await request(hub.app).get('/api/projects/amber/git/diff').expect('Cache-Control', 'no-store').expect(200);
    expect(review.body).toMatchObject({ status: { branch: 'main' }, diff: 'reviewed text' });
    expect(review.body.reviewId).toMatch(/^[a-f0-9-]{36}\.test-review$/);
    const ctx = vi.mocked(service.reviewProposal).mock.calls[0][0];
    expect(ctx).toEqual({
      projectId: 'amber', workTree, gitDir, branch: expect.stringMatching(/^focuswiki\/[a-f0-9]{40}$/),
      remote: 'https://github.com/fictional-observatory/amber-wiki.git'
    });
    const input = { ...proposalInput, reviewId: review.body.reviewId };

    await request(hub.app).post('/api/projects/amber/git/propose').send({ ...input, paths: [] }).expect(400);
    await request(hub.app).post('/api/projects/amber/git/propose').send({ ...input, paths: ['../README.md'] }).expect(400);
    await request(hub.app).post('/api/projects/amber/git/propose').send({ ...input, remote: 'https://elsewhere.test/r' }).expect(400);
    expect(service.publishProposal).not.toHaveBeenCalled();
    delete service.enforcesManagedBase;
    await request(hub.app).post('/api/projects/amber/git/propose').send(input).expect(503);
    expect(service.publishProposal).not.toHaveBeenCalled();
    service.enforcesManagedBase = true;
    await request(hub.app).post('/api/projects/amber/git/propose').send(input).expect(200, {
      url: 'https://github.com/Fictional-Observatory/Amber-Wiki/pull/7', sha: base
    });
    expect(service.publishProposal).toHaveBeenCalledWith(ctx, proposalInput);

    const differentActor = app('allow', 'main', 'fictional-other-reviewer');
    vi.mocked(service.publishProposal).mockImplementationOnce(async (other) => {
      expect(other.branch).not.toBe(ctx.branch);
      throw Object.assign(new Error('Review unavailable for this actor'), { statusCode: 409 });
    });
    await request(differentActor.app).post('/api/projects/amber/git/propose').send(input).expect(409);
    await differentActor.close();

    vi.mocked(service.publishProposal).mockRejectedValueOnce(Object.assign(new Error('fictional-token-sensitive-error'), { statusCode: 409 }));
    const conflict = await request(hub.app).post('/api/projects/amber/git/propose').send(input).expect(409);
    expect(conflict.body.error).toBe('proposal_conflict');
    expect(conflict.text).not.toContain('fictional-token-sensitive-error');

    const staleWeb = app('allow', 'other');
    await request(staleWeb.app).get('/api/projects/amber/git/diff').expect(404);
    await staleWeb.close();

    await runner?.close();
    const restarted = await start();
    await vi.waitFor(async () => {
      expect((await restarted.statuses()).amber).toMatchObject({
        state: 'ready', headSha: base, isClean: false, behind: 1, fetchState: 'unavailable'
      });
    });
    expect(fs.readFileSync(path.join(workTree, 'README.md'), 'utf8')).toBe('# An external draft\n');
  });

  it('rejects generic socket commands and does not adopt a project directory or replace a symlink', async () => {
    const base = upstream();
    const service = companion(base);
    fs.symlinkSync(fixture.source, workTree, 'dir');
    const client = await start(service);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let body = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ verb: 'fetch', remote: 'file:///fictional' }) + '\n'));
      socket.on('data', (data) => { body += data; });
      socket.on('end', () => resolve(body));
      socket.on('error', reject);
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, error: 'invalid_git_request' });
    expect((await client.statuses()).amber).toMatchObject({ state: 'unavailable', isClean: null });
    expect(service.getRepoToken).not.toHaveBeenCalled();
    expect(fs.readlinkSync(workTree)).toBe(fixture.source);
    hub = app('allow');
    await request(hub.app).get('/api/projects/amber/doc').expect(404);
  });

  it('checks out repositories containing tracked .env templates while keeping them blocked from web and proposals', async () => {
    const base = upstream();
    fs.writeFileSync(path.join(fixture.source, '.env.example'), 'APP_ENV=example\n');
    git(fixture.source, ['add', '.env.example']);
    git(fixture.source, ['commit', '-m', 'Add .env.example template']);
    const head = git(fixture.source, ['rev-parse', 'HEAD']);
    expect(head).not.toBe(base);

    const service = companion(head);
    const client = await start(service);
    await vi.waitFor(async () => {
      expect((await client.statuses()).amber).toMatchObject({
        state: 'ready', headSha: head, isClean: true, fetchState: 'current'
      });
    }, { timeout: 10_000 });
    expect(fs.readFileSync(path.join(workTree, '.env.example'), 'utf8')).toBe('APP_ENV=example\n');

    hub = app('allow');
    await request(hub.app).get('/api/projects/amber/doc').expect(200);
    await request(hub.app).get('/api/projects/amber/doc?path=.env.example').expect(403);
    const review = await request(hub.app).get('/api/projects/amber/git/diff').expect(200);
    await request(hub.app).post('/api/projects/amber/git/propose')
      .send({ reviewId: review.body.reviewId, message: 'Attempt env proposal', paths: ['.env.example'] })
      .expect(400);
    expect(service.publishProposal).not.toHaveBeenCalled();
  });

  it('still refuses initial checkout when the repository tree contains symlinks or forbidden directories', async () => {
    upstream();
    fs.symlinkSync('README.md', path.join(fixture.source, 'link.md'));
    git(fixture.source, ['add', 'link.md']);
    git(fixture.source, ['commit', '-m', 'Add symlink entry']);
    const head = git(fixture.source, ['rev-parse', 'HEAD']);

    const service = companion(head);
    const client = await start(service);
    await vi.waitFor(async () => {
      expect((await client.statuses()).amber).toMatchObject({
        state: 'unavailable', fetchState: 'current'
      });
    }, { timeout: 10_000 });
    expect(fs.existsSync(workTree)).toBe(false);
  });

  it('supports unmanaged local projects alongside managed GitHub projects while keeping git-worker isolated', async () => {
    const localReposDir = path.join(root, 'local-repos');
    const localProjectDir = path.join(localReposDir, 'lan-docs');
    fs.mkdirSync(localProjectDir, { recursive: true, mode: 0o770 });
    fs.writeFileSync(path.join(localProjectDir, 'README.md'), '# Internal LAN Docs\n\nPrivate runbook.\n');
    fs.writeFileSync(path.join(localProjectDir, '.env'), 'SECRET=nope\n');

    const localEntry = { id: 'lan-docs', name: 'LAN Docs', local: true as const, defaultDoc: 'README.md' };
    fs.unlinkSync(enrollmentFile);
    fs.writeFileSync(enrollmentFile, JSON.stringify({ projects: [entry, localEntry] }), { mode: 0o444 });

    // Local project entries reject remote/branch/rootPath fields and require localReposDir.
    const invalidCandidate = path.join(root, 'invalid-local.json');
    for (const projects of [
      [{ ...localEntry, rootPath: '/tmp/lan-docs' }],
      [{ ...localEntry, remote: 'https://github.com/fictional-observatory/lan-docs.git' }],
      [{ ...localEntry, branch: 'main' }],
      [{ id: 'lan-docs', name: 'LAN Docs', local: false }],
      [entry, { ...localEntry, id: entry.id }]
    ]) {
      fs.writeFileSync(invalidCandidate, JSON.stringify({ projects }));
      expect(() => loadEnrollmentEntries(invalidCandidate)).toThrow(/Invalid (?:local|managed) project/);
    }
    expect(() => new ProjectRegistry([], { projects: loadEnrollmentEntries(enrollmentFile), reposDir }))
      .toThrow('requires FOCUSWIKI_LOCAL_REPOS_DIR');

    const base = upstream();
    const service = companion(base);
    const client = await start(service);
    await vi.waitFor(async () => {
      const statuses = await client.statuses();
      expect(Object.keys(statuses)).toEqual(['amber']);
      expect(statuses.amber).toMatchObject({ state: 'ready', headSha: base });
    }, { timeout: 10_000 });

    hub = createHubApp({
      registry: new ProjectRegistry([], {
        projects: loadEnrollmentEntries(enrollmentFile),
        reposDir,
        localReposDir
      }),
      gitSocketPath: socketPath,
      proposalAuth: (_req, res, next) => {
        res.locals.proposalActor = 'fictional-reviewer';
        next();
      },
      enableWatcher: false
    });

    const envRes = await request(hub.app).get('/api/settings/environment').expect(200);
    expect(envRes.body).toEqual({ projectCount: 2, managedProjectCount: 1 });

    const list = await request(hub.app).get('/api/projects').expect(200);
    const localSummary = list.body.projects.find((p: { id: string }) => p.id === 'lan-docs');
    expect(localSummary).toMatchObject({
      id: 'lan-docs',
      name: 'LAN Docs',
      workingTreeAvailable: true,
      git: { state: 'unmanaged', remoteUrl: null, isClean: null },
      docs: [{ path: 'README.md' }]
    });

    const doc = await request(hub.app).get('/api/projects/lan-docs/doc').expect(200);
    expect(doc.body.markdown).toContain('Private runbook.');

    await request(hub.app).put('/api/projects/lan-docs/doc')
      .send({ path: 'README.md', markdown: '# Internal LAN Docs\n\nUpdated locally.\n', baseRevision: doc.body.revision })
      .expect(200);
    expect(fs.readFileSync(path.join(localProjectDir, 'README.md'), 'utf8')).toContain('Updated locally.');

    await request(hub.app).get('/api/projects/lan-docs/doc?path=.env').expect(403);
    await request(hub.app).get('/api/projects/lan-docs/git/diff').expect(404);
    await request(hub.app).post('/api/projects/lan-docs/git/propose').send(proposalInput).expect(404);
  });

  it('auto fast-forwards clean checkouts, preserves .focuswiki metadata, and supports on-demand update with conflict guards', async () => {
    const base = upstream();
    const service = companion(base);
    const client = await start(service);
    await vi.waitFor(async () => {
      expect((await client.statuses()).amber).toMatchObject({
        state: 'ready', headSha: base, isClean: true, behind: 0
      });
    }, { timeout: 10_000 });

    // Local metadata under .focuswiki must survive fast-forward updates.
    fs.mkdirSync(path.join(workTree, '.focuswiki'));
    fs.writeFileSync(path.join(workTree, '.focuswiki', 'recovery.md'), '# Keep recovery\n');

    // Advance upstream with modified and added files; background fetch auto fast-forwards clean tree.
    fs.writeFileSync(path.join(fixture.source, 'README.md'), '# Amber Observatory v2\n');
    fs.writeFileSync(path.join(fixture.source, 'guide.md'), '# New Guide\n');
    git(fixture.source, ['add', 'README.md', 'guide.md']);
    git(fixture.source, ['commit', '-m', 'Advance upstream while clean']);
    const second = git(fixture.source, ['rev-parse', 'HEAD']);

    const startNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => startNow + 65_000);
    await vi.waitFor(async () => {
      expect((await client.statuses()).amber).toMatchObject({
        state: 'ready', headSha: second, isClean: true, behind: 0
      });
    }, { timeout: 10_000 });
    expect(fs.readFileSync(path.join(workTree, 'README.md'), 'utf8')).toBe('# Amber Observatory v2\n');
    expect(fs.readFileSync(path.join(workTree, 'guide.md'), 'utf8')).toBe('# New Guide\n');
    expect(fs.readFileSync(path.join(workTree, '.focuswiki', 'recovery.md'), 'utf8')).toBe('# Keep recovery\n');

    hub = app('allow');
    // On-demand update when already up to date returns updated: false.
    const noop = await request(hub.app).post('/api/projects/amber/git/update').expect(200);
    expect(noop.body).toMatchObject({ updated: false, previousSha: second, headSha: second });

    // Advance upstream again (including a file deletion) while dirty -> 409 git_dirty_worktree.
    fs.writeFileSync(path.join(workTree, 'README.md'), '# Local unsaved edit\n');
    fs.unlinkSync(path.join(fixture.source, 'guide.md'));
    fs.writeFileSync(path.join(fixture.source, 'README.md'), '# Amber Observatory v3\n');
    git(fixture.source, ['add', '-A']);
    git(fixture.source, ['commit', '-m', 'Remove guide and bump README']);
    const third = git(fixture.source, ['rev-parse', 'HEAD']);

    const dirtyRes = await request(hub.app).post('/api/projects/amber/git/update').expect(409);
    expect(dirtyRes.body.error).toBe('git_dirty_worktree');
    expect(fs.readFileSync(path.join(workTree, 'README.md'), 'utf8')).toBe('# Local unsaved edit\n');

    // Restore clean working tree -> on-demand update fast-forwards immediately without waiting for poll.
    fs.writeFileSync(path.join(workTree, 'README.md'), '# Amber Observatory v2\n');
    const updatedRes = await request(hub.app).post('/api/projects/amber/git/update').expect(200);
    expect(updatedRes.body).toMatchObject({
      updated: true,
      previousSha: second,
      headSha: third,
      status: { state: 'ready', headSha: third, isClean: true, behind: 0 }
    });
    expect(fs.readFileSync(path.join(workTree, 'README.md'), 'utf8')).toBe('# Amber Observatory v3\n');
    expect(fs.existsSync(path.join(workTree, 'guide.md'))).toBe(false);
    expect(fs.readFileSync(path.join(workTree, '.focuswiki', 'recovery.md'), 'utf8')).toBe('# Keep recovery\n');

    // Upstream introduces a symlink -> update refuses (503 git_not_ready) and keeps existing tree intact.
    fs.symlinkSync('README.md', path.join(fixture.source, 'bad-link.md'));
    git(fixture.source, ['add', 'bad-link.md']);
    git(fixture.source, ['commit', '-m', 'Add forbidden symlink']);
    const symlinkRes = await request(hub.app).post('/api/projects/amber/git/update').expect(503);
    expect(symlinkRes.body.error).toBe('git_not_ready');
    expect(fs.existsSync(path.join(workTree, 'bad-link.md'))).toBe(false);

    // Diverged / force-pushed upstream history -> 409 git_not_fast_forward.
    git(fixture.source, ['reset', '--hard', base]);
    fs.writeFileSync(path.join(fixture.source, 'README.md'), '# Force pushed history\n');
    git(fixture.source, ['add', 'README.md']);
    git(fixture.source, ['commit', '-m', 'Force pushed branch']);
    const divergedRes = await request(hub.app).post('/api/projects/amber/git/update').expect(409);
    expect(divergedRes.body.error).toBe('git_not_fast_forward');
    expect(fs.readFileSync(path.join(workTree, 'README.md'), 'utf8')).toBe('# Amber Observatory v3\n');
  });

  it('refuses fast-forward when upstream paths collide with ignored local files or directories', async () => {
    upstream();
    fs.writeFileSync(path.join(fixture.source, '.gitignore'), '.env\ndrafts/\nnotes\n');
    git(fixture.source, ['add', '.gitignore']);
    git(fixture.source, ['commit', '-m', 'Add .gitignore']);
    const base = git(fixture.source, ['rev-parse', 'HEAD']);

    const service = companion(base);
    const client = await start(service);
    await vi.waitFor(async () => {
      expect((await client.statuses()).amber).toMatchObject({ state: 'ready', headSha: base, isClean: true });
    }, { timeout: 10_000 });

    // Create ignored local files and directories that git status omits.
    fs.writeFileSync(path.join(workTree, '.env'), 'LOCAL_SECRET=keep\n');
    fs.mkdirSync(path.join(workTree, 'drafts'));
    fs.writeFileSync(path.join(workTree, 'drafts', 'wip.md'), '# Keep local ignored draft\n');
    fs.writeFileSync(path.join(workTree, 'notes'), 'local ignored file\n');

    hub = app('allow');

    // 1. Exact file collision: upstream force-adds tracked .env.
    fs.writeFileSync(path.join(fixture.source, '.env'), 'UPSTREAM=overwrite\n');
    git(fixture.source, ['add', '-f', '.env']);
    git(fixture.source, ['commit', '-m', 'Track .env upstream']);
    const envCollision = await request(hub.app).post('/api/projects/amber/git/update').expect(409);
    expect(envCollision.body.error).toBe('git_dirty_worktree');
    expect(fs.readFileSync(path.join(workTree, '.env'), 'utf8')).toBe('LOCAL_SECRET=keep\n');

    // Remove .env collision from upstream, test file-replacing-ignored-directory collision.
    git(fixture.source, ['reset', '--hard', base]);
    fs.writeFileSync(path.join(fixture.source, 'drafts'), 'upstream file replacing dir\n');
    git(fixture.source, ['add', '-f', 'drafts']);
    git(fixture.source, ['commit', '-m', 'Add drafts file upstream']);
    const dirCollision = await request(hub.app).post('/api/projects/amber/git/update').expect(409);
    expect(dirCollision.body.error).toBe('git_dirty_worktree');
    expect(fs.readFileSync(path.join(workTree, 'drafts', 'wip.md'), 'utf8')).toBe('# Keep local ignored draft\n');

    // Remove drafts collision from upstream, test directory-replacing-ignored-file collision.
    git(fixture.source, ['reset', '--hard', base]);
    fs.mkdirSync(path.join(fixture.source, 'notes'));
    fs.writeFileSync(path.join(fixture.source, 'notes', 'page.md'), '# Upstream nested page\n');
    git(fixture.source, ['add', '-f', 'notes/page.md']);
    git(fixture.source, ['commit', '-m', 'Add notes/page.md upstream']);
    const fileCollision = await request(hub.app).post('/api/projects/amber/git/update').expect(409);
    expect(fileCollision.body.error).toBe('git_dirty_worktree');
    expect(fs.readFileSync(path.join(workTree, 'notes'), 'utf8')).toBe('local ignored file\n');

    // Non-colliding upstream update still succeeds while preserving all ignored files.
    git(fixture.source, ['reset', '--hard', base]);
    fs.writeFileSync(path.join(fixture.source, 'README.md'), '# Safe upstream update\n');
    git(fixture.source, ['add', 'README.md']);
    git(fixture.source, ['commit', '-m', 'Safe non-colliding change']);
    const safeHead = git(fixture.source, ['rev-parse', 'HEAD']);
    const okRes = await request(hub.app).post('/api/projects/amber/git/update').expect(200);
    expect(okRes.body).toMatchObject({ updated: true, headSha: safeHead });
    expect(fs.readFileSync(path.join(workTree, 'README.md'), 'utf8')).toBe('# Safe upstream update\n');
    expect(fs.readFileSync(path.join(workTree, '.env'), 'utf8')).toBe('LOCAL_SECRET=keep\n');
    expect(fs.readFileSync(path.join(workTree, 'drafts', 'wip.md'), 'utf8')).toBe('# Keep local ignored draft\n');
    expect(fs.readFileSync(path.join(workTree, 'notes'), 'utf8')).toBe('local ignored file\n');
  });

  it('supports Forgejo managed projects with origin-scoped auth/proxy headers and /pulls/ URL validation', async () => {
    const forgejoEntry = {
      id: 'lan-docs',
      name: 'LAN Docs',
      provider: 'forgejo' as const,
      remote: 'https://git.invalid.ts.net/Fictional-LAN/LAN-Docs',
      branch: 'main',
      defaultDoc: 'README.md'
    };

    const invalidCandidate = path.join(root, 'invalid-forgejo.json');
    for (const projects of [
      [{ ...forgejoEntry, remote: 'http://git.invalid.ts.net/fictional-lan/lan-docs.git' }],
      [{ ...forgejoEntry, remote: 'https://github.com/fictional-lan/lan-docs.git' }],
      [{ ...forgejoEntry, remote: 'https://user@git.invalid.ts.net/fictional-lan/lan-docs.git' }],
      [{ ...forgejoEntry, remote: 'https://git.invalid.ts.net/fictional-lan/lan-docs?ref=main' }],
      [{ ...forgejoEntry, remote: 'https://git.invalid.ts.net/fictional-lan/lan-docs.git.git' }],
      [{ ...forgejoEntry, provider: 'gitlab' }],
      [{ id: 'lan-docs', name: 'LAN Docs', remote: 'https://git.invalid.ts.net/fictional-lan/lan-docs.git', branch: 'main' }]
    ]) {
      fs.writeFileSync(invalidCandidate, JSON.stringify({ projects }));
      expect(() => loadEnrollmentEntries(invalidCandidate)).toThrow('Invalid managed project');
    }

    vi.stubEnv('FOCUSWIKI_FORGEJO_PROXY', 'http://127.0.0.1:1055');
    fs.unlinkSync(enrollmentFile);
    fs.writeFileSync(enrollmentFile, JSON.stringify({ projects: [entry, forgejoEntry] }), { mode: 0o444 });
    const parsed = loadEnrollment(enrollmentFile);
    expect(parsed[1]).toMatchObject({
      id: 'lan-docs',
      provider: 'forgejo',
      remote: 'https://git.invalid.ts.net/fictional-lan/lan-docs.git'
    });

    const base = upstream();
    const service: ProposalService = {
      enforcesManagedBase: true,
      getRepoToken: vi.fn(async () => 'fictional-read-token'),
      reviewProposal: vi.fn(async () => ({
        reviewId: 'forgejo-review', snapshotDigest: 'forgejo-snapshot', diff: 'forgejo diff', commitScopeNote: '',
        files: [], status: {
          branch: 'main', headSha: base, headSubject: '', isClean: false,
          changedFiles: [{ path: 'README.md', status: 'modified' }]
        }
      })),
      publishProposal: vi.fn(async (ctx) => ({
        url: ctx.remote.startsWith('https://github.com/')
          ? 'https://github.com/fictional-observatory/amber-wiki/pull/7'
          : 'https://git.invalid.ts.net/fictional-lan/lan-docs/pulls/3',
        sha: base
      }))
    };

    const client = await start(service);
    await vi.waitFor(async () => {
      const statuses = await client.statuses();
      expect(statuses.amber).toMatchObject({ state: 'ready', headSha: base });
      expect(statuses['lan-docs']).toMatchObject({
        state: 'ready',
        headSha: base,
        remoteUrl: 'https://git.invalid.ts.net/fictional-lan/lan-docs.git'
      });
    }, { timeout: 10_000 });

    // GitHub fetch must NOT receive FOCUSWIKI_FORGEJO_PROXY; Forgejo fetch MUST receive it.
    const ghEnv = fixture.fetchEnvs.find((e) => e?.GIT_CONFIG_KEY_0 === 'http.https://github.com/.extraHeader');
    const fjEnv = fixture.fetchEnvs.find((e) => e?.GIT_CONFIG_KEY_0 === 'http.https://git.invalid.ts.net/.extraHeader');
    expect(ghEnv?.GIT_CONFIG_COUNT).toBe('1');
    expect(ghEnv?.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(fjEnv?.GIT_CONFIG_COUNT).toBe('2');
    expect(fjEnv?.GIT_CONFIG_KEY_1).toBe('http.https://git.invalid.ts.net/.proxy');
    expect(fjEnv?.GIT_CONFIG_VALUE_1).toBe('http://127.0.0.1:1055');

    hub = app('allow');
    const review = await request(hub.app).get('/api/projects/lan-docs/git/diff').expect(200);
    await request(hub.app).post('/api/projects/lan-docs/git/propose')
      .send({ reviewId: review.body.reviewId, message: 'Update LAN docs', paths: ['README.md'] })
      .expect(200, {
        url: 'https://git.invalid.ts.net/fictional-lan/lan-docs/pulls/3',
        sha: base
      });

    // Reject a malformed or mismatched-origin PR URL from the companion for Forgejo.
    vi.mocked(service.publishProposal).mockResolvedValueOnce({
      url: 'https://git.invalid.ts.net/fictional-lan/lan-docs/pull/3',
      sha: base
    });
    await request(hub.app).post('/api/projects/lan-docs/git/propose')
      .send({ reviewId: review.body.reviewId, message: 'Wrong path', paths: ['README.md'] })
      .expect(502);

    vi.mocked(service.publishProposal).mockResolvedValueOnce({
      url: 'https://github.com/fictional-lan/lan-docs/pulls/3',
      sha: base
    });
    await request(hub.app).post('/api/projects/lan-docs/git/propose')
      .send({ reviewId: review.body.reviewId, message: 'Wrong origin', paths: ['README.md'] })
      .expect(502);
  });

  it('live-reloads enrollment.json additions, removals, atomic renames, and keeps last valid config on invalid edits', async () => {
    const localReposDir = path.join(root, 'local-repos');
    const localDocDir = path.join(localReposDir, 'notes');
    fs.mkdirSync(localDocDir, { recursive: true, mode: 0o770 });
    fs.writeFileSync(path.join(localDocDir, 'README.md'), '# Live Local Notes\n');

    const base = upstream();
    const service: ProposalService = {
      enforcesManagedBase: true,
      getRepoToken: vi.fn(async () => 'fictional-read-token'),
      reviewProposal: vi.fn(async () => ({
        reviewId: 'live-review', snapshotDigest: 'live-snapshot', diff: 'live diff', commitScopeNote: '',
        files: [], status: {
          branch: 'main', headSha: base, headSubject: '', isClean: true, changedFiles: []
        }
      })),
      publishProposal: vi.fn(async () => ({
        url: 'https://git.invalid.ts.net/fictional-lan/lan-docs/pulls/5', sha: base
      }))
    };

    runner = await startGitRunner({
      enrollmentFile,
      reposDir,
      stateDir,
      socketPath,
      proposalService: service,
      enrollmentDebounceMs: 30
    });
    const client = new GitSocketClient(socketPath);
    await vi.waitFor(async () => {
      expect((await client.statuses()).amber).toMatchObject({ state: 'ready', headSha: base });
    }, { timeout: 10_000 });

    hub = createHubApp({
      registry: new ProjectRegistry([], {
        projects: loadEnrollmentEntries(enrollmentFile),
        reposDir,
        localReposDir
      }),
      enrollmentWatch: { file: enrollmentFile, debounceMs: 30 },
      gitSocketPath: socketPath,
      proposalAuth: (_req, res, next) => {
        res.locals.proposalActor = 'fictional-reviewer';
        next();
      },
      enableWatcher: true
    });

    const broadcastSpy = vi.spyOn(hub.watcherHub, 'broadcast');

    // 1. Add a Forgejo repo and a local repo via atomic rename (new inode).
    const forgejoEntry = {
      id: 'lan-docs',
      name: 'LAN Docs',
      provider: 'forgejo' as const,
      remote: 'https://git.invalid.ts.net/fictional-lan/lan-docs.git',
      branch: 'main',
      defaultDoc: 'README.md'
    };
    const localEntry = { id: 'notes', name: 'Live Notes', local: true as const, defaultDoc: 'README.md' };
    const tmpEnrollment = path.join(root, 'enrollment.next.json');
    fs.writeFileSync(tmpEnrollment, JSON.stringify({ projects: [entry, forgejoEntry, localEntry] }), { mode: 0o644 });
    fs.renameSync(tmpEnrollment, enrollmentFile);

    await vi.waitFor(async () => {
      const statuses = await client.statuses();
      expect(statuses['lan-docs']).toMatchObject({ state: 'ready', headSha: base });
      const res = await request(hub!.app).get('/api/projects').expect(200);
      const ids = res.body.projects.map((p: { id: string }) => p.id);
      expect(ids).toEqual(['amber', 'lan-docs', 'notes']);
      const lanDocs = res.body.projects.find((p: { id: string }) => p.id === 'lan-docs');
      expect(lanDocs.git).toMatchObject({ state: 'ready', headSha: base });
    }, { timeout: 10_000 });
    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'projects:updated', reason: 'updated' }));

    // 2. Write broken JSON in place -> both web and git-worker keep last valid config.
    fs.writeFileSync(enrollmentFile, '{ broken json');
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(Object.keys(await client.statuses()).sort()).toEqual(['amber', 'lan-docs']);
    const duringBroken = await request(hub.app).get('/api/projects').expect(200);
    expect(duringBroken.body.projects.map((p: { id: string }) => p.id)).toEqual(['amber', 'lan-docs', 'notes']);

    // 3. Recover with valid JSON removing `amber` -> disappears from both web and git-worker without deleting files.
    fs.writeFileSync(enrollmentFile, JSON.stringify({ projects: [forgejoEntry, localEntry] }));
    await vi.waitFor(async () => {
      expect(Object.keys(await client.statuses())).toEqual(['lan-docs']);
      const res = await request(hub!.app).get('/api/projects').expect(200);
      expect(res.body.projects.map((p: { id: string }) => p.id)).toEqual(['lan-docs', 'notes']);
    }, { timeout: 10_000 });
    await request(hub.app).get('/api/projects/amber/git/diff').expect(404);
    expect(fs.existsSync(path.join(workTree, 'README.md'))).toBe(true);
  });
});

it('bounds the queue, withdraws canceled work, and serializes jobs on the same checkout', async () => {
  const queue = new GitQueue(1, 1);
  const controller = new AbortController();
  let finish!: () => void;
  const running = queue.run('amber', controller.signal, () => new Promise<void>((resolve) => { finish = resolve; }));
  const waiting = new AbortController();
  const work = vi.fn(async () => 'done');
  const canceled = queue.run('amber', waiting.signal, work);
  await expect(queue.run('amber', controller.signal, work)).rejects.toMatchObject({ code: 'git_busy' });
  waiting.abort();
  await expect(canceled).rejects.toMatchObject({ code: 'git_timeout' });
  const next = queue.run('amber', controller.signal, work);
  expect(work).not.toHaveBeenCalled();
  finish();
  await running;
  await expect(next).resolves.toBe('done');
  expect(work).toHaveBeenCalledTimes(1);
  queue.close();
});
