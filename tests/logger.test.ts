import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubApp } from '../server/app.js';
import { loadEnrollment } from '../server/enrollment.js';
import type { ProposalService } from '../server/gitProtocol.js';
import { startGitRunner } from '../server/gitRunner.js';
import { createLogger, parseLogLevel, sanitizeLogText } from '../server/logger.js';
import { ProjectRegistry } from '../server/projectRegistry.js';

describe('server diagnostic logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('redacts tokens, PEM blocks, credentials, and newlines from log text', () => {
    const raw = [
      'Authorization: Basic dXNlcjpzZWNyZXQ=',
      'Bearer eyJhbGciOiJSUzI1NiJ9.abcdef123456',
      'token=ghs_1234567890abcdefghij',
      'url=https://x-access-token:secret123@github.com/org/repo.git',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
      'line1\nline2\r\tline3'
    ].join(' ');
    const sanitized = sanitizeLogText(raw, 500);
    expect(sanitized).not.toContain('dXNlcjpzZWNyZXQ');
    expect(sanitized).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(sanitized).not.toContain('ghs_1234567890abcdefghij');
    expect(sanitized).not.toContain('secret123');
    expect(sanitized).not.toContain('MIIE');
    expect(sanitized).not.toMatch(/[\r\n\t]/);
    expect(sanitized).toContain('[REDACTED_TOKEN]');
    expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('respects FOCUSWIKI_LOG_LEVEL filtering', () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('test-comp');

    vi.stubEnv('FOCUSWIKI_LOG_LEVEL', 'warn');
    expect(parseLogLevel()).toBe('warn');
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg', { project: 'airpg', status: 503 });
    logger.error('error msg');

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('WARN [test-comp] warn msg project=airpg status=503');
    expect(errorSpy).toHaveBeenCalledTimes(1);

    vi.stubEnv('FOCUSWIKI_LOG_LEVEL', 'silent');
    logger.error('suppressed');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('logs deduplicated repository token/checkout failures and RPC errors in git-worker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-log-'));
    const reposDir = path.join(root, 'repos');
    const stateDir = path.join(root, 'state');
    const socketDir = path.join(root, 'socket');
    for (const dir of [reposDir, stateDir, socketDir]) fs.mkdirSync(dir, { mode: 0o700 });
    const socketPath = path.join(socketDir, 'git.sock');
    const enrollmentFile = path.join(root, 'enrollment.json');
    const entry = {
      id: 'airpg',
      name: 'AI RPG',
      remote: 'https://github.com/fictional-observatory/ai-rpg.git',
      branch: 'main',
      defaultDoc: 'README.md'
    };
    fs.writeFileSync(enrollmentFile, JSON.stringify({ projects: [entry] }), { mode: 0o444 });

    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const proposalService: ProposalService = {
      enforcesManagedBase: true,
      getRepoToken: vi.fn(async () => {
        throw new Error('The enrolled repository does not belong to the configured GitHub App installation.');
      }),
      reviewProposal: vi.fn(),
      publishProposal: vi.fn()
    };

    const runner = await startGitRunner({ enrollmentFile, reposDir, stateDir, socketPath, proposalService });
    const hub = createHubApp({
      registry: new ProjectRegistry([], { projects: loadEnrollment(enrollmentFile), reposDir }),
      gitSocketPath: socketPath,
      proposalAuth: (_req, res, next) => {
        res.locals.proposalActor = 'reviewer@example.test';
        next();
      },
      enableWatcher: false
    });

    try {
      await vi.waitFor(() => {
        const warns = warnSpy.mock.calls.map((args) => String(args[0]));
        expect(warns.some((line) =>
          line.includes('Managed repository sync failed') &&
          line.includes('project=airpg') &&
          line.includes('phase=token') &&
          line.includes('does not belong to the configured GitHub App installation')
        )).toBe(true);
      }, { timeout: 5_000 });

      const infos = infoSpy.mock.calls.map((args) => String(args[0]));
      expect(infos.some((line) => line.includes('Loaded enrolled projects') && line.includes('airpg@main'))).toBe(true);

      await request(hub.app).get('/api/projects/airpg/git/diff').expect(503);
      const warns = warnSpy.mock.calls.map((args) => String(args[0]));
      expect(warns.some((line) =>
        line.includes('Git worker RPC failed') &&
        line.includes('verb=review') &&
        line.includes('project=airpg') &&
        line.includes('code=git_not_ready')
      )).toBe(true);
      expect(warns.some((line) =>
        line.includes('Managed Git request failed') &&
        line.includes('status=503') &&
        line.includes('code=git_not_ready')
      )).toBe(true);
    } finally {
      await hub.close();
      await runner.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('logs the exact blocked tree entry when initial checkout rejects a symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-log-tree-'));
    const upstream = path.join(root, 'upstream');
    fs.mkdirSync(upstream);
    execFileSync('/usr/bin/git', ['init', '-b', 'main'], { cwd: upstream });
    execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: upstream });
    execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.invalid'], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, 'README.md'), '# Test\n');
    fs.symlinkSync('README.md', path.join(upstream, 'bad-link.md'));
    execFileSync('/usr/bin/git', ['add', 'README.md', 'bad-link.md'], { cwd: upstream });
    execFileSync('/usr/bin/git', ['commit', '-m', 'Add symlink'], { cwd: upstream });

    const reposDir = path.join(root, 'repos');
    const stateDir = path.join(root, 'state');
    const socketDir = path.join(root, 'socket');
    for (const dir of [reposDir, stateDir, socketDir]) fs.mkdirSync(dir, { mode: 0o700 });
    const gitDir = path.join(stateDir, 'demo', 'git');
    fs.mkdirSync(path.dirname(gitDir), { mode: 0o700 });
    execFileSync('/usr/bin/git', ['init', '--bare', '--initial-branch=main', gitDir]);
    execFileSync('/usr/bin/git', ['--git-dir=' + gitDir, 'fetch', upstream, '+refs/heads/main:refs/remotes/origin/main']);
    fs.chmodSync(gitDir, 0o700);
    fs.writeFileSync(
      path.join(stateDir, 'demo', 'binding.json'),
      JSON.stringify({ remote: 'https://github.com/fictional/demo.git', branch: 'main' })
    );

    const enrollmentFile = path.join(root, 'enrollment.json');
    fs.writeFileSync(enrollmentFile, JSON.stringify({
      projects: [{ id: 'demo', name: 'Demo', remote: 'https://github.com/fictional/demo.git', branch: 'main' }]
    }), { mode: 0o444 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ManagedRepository } = await import('../server/managedGit.js');
    const repo = new ManagedRepository(loadEnrollment(enrollmentFile)[0], reposDir, stateDir, {
      enforcesManagedBase: true,
      getRepoToken: vi.fn(async () => 'ghs_fictionaltokenvalue1234567890'),
      reviewProposal: vi.fn(),
      publishProposal: vi.fn()
    });
    // Trigger prepareCheckout directly against the pre-fetched remote ref.
    await expect((repo as unknown as { prepareCheckout(s: AbortSignal): Promise<void> }).prepareCheckout(AbortSignal.timeout(5000)))
      .rejects.toMatchObject({
        code: 'git_not_ready',
        detail: expect.stringContaining('bad-link.md')
      });
    expect(warnSpy.mock.calls.every((args) => !String(args[0]).includes('ghs_fictionaltokenvalue1234567890'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
