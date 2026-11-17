import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertGitRemoteHostAllowed,
  buildGitEnv,
  checkoutGitTarget,
  cloneRepository,
  commitWorkingTree,
  fetchGitRemote,
  initNewWikiRepository,
  inspectRemoteRepository,
  isBlockedGitIp,
  isGitHostAllowed,
  pullGitRemote,
  validateGitRemoteUrl
} from '../server/gitService.js';
import { PathBoundaryError, resolveSafeEmbedAssetPath, resolveSafeProjectPath } from '../server/pathGuard.js';

function git(root: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', `safe.directory=${root}`, '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  });
}

let root: string;
let repo: string;
let bare: string;
let url: string;
beforeEach(async () => {
  for (const name of ['FOCUSWIKI_ALLOW_INSECURE_GIT_HTTP', 'FOCUSWIKI_ALLOW_GIT_SSH', 'FOCUSWIKI_ALLOW_FILE_REMOTES', 'FOCUSWIKI_ALLOWED_GIT_HOSTS', 'FOCUSWIKI_MAX_CONCURRENT_CLONES']) vi.stubEnv(name, undefined);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-git-security-'));
  repo = path.join(root, 'source');
  await initNewWikiRepository({ destDir: repo, title: 'Fictional Starling Handbook', defaultDoc: 'README.md' });
  fs.writeFileSync(path.join(repo, 'other.md'), '# Other fictional notes\n');
  git(repo, ['add', 'other.md']);
  git(repo, ['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@invalid', 'commit', '-m', 'Add second file']);
  git(repo, ['branch', 'feature']);
  bare = path.join(root, 'remote.git');
  git(root, ['clone', '--bare', repo, bare]);
  git(bare, ['update-ref', 'refs/pull/7/head', 'refs/heads/feature']);
  url = pathToFileURL(bare).href;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Git remote validation and SSRF boundaries', () => {
  it.each([
    '--upload-pack=/tmp/evil', 'ext::sh -c evil', 'git://example.com/wiki.git',
    'ftp://example.com/wiki.git', 'ftps://example.com/wiki.git',
    'https://example.com/wiki.git\n', ' https://example.com/wiki.git',
    'https://example.com/a b.git', 'https://example.com/a\x01.git', 'https://example.com/a\x7f.git'
  ])('rejects unsafe remote %j', (remote) => {
    expect(() => validateGitRemoteUrl(remote)).toThrow();
  });

  it('requires explicit HTTP and SSH transport policy opt-ins', () => {
    expect(() => validateGitRemoteUrl('http://git.example.com/wiki.git')).toThrow(/FOCUSWIKI_ALLOW_INSECURE_GIT_HTTP=1/);
    vi.stubEnv('FOCUSWIKI_ALLOW_INSECURE_GIT_HTTP', '1');
    expect(validateGitRemoteUrl('http://git.example.com/wiki.git')).toBe('http://git.example.com/wiki.git');
    expect(validateGitRemoteUrl('https://git.example.com/wiki.git')).toBe('https://git.example.com/wiki.git');
    expect(validateGitRemoteUrl('git@git.example.com:owner/wiki.git')).toContain('owner/wiki.git');
    expect(validateGitRemoteUrl('ssh://git@git.example.com/owner/wiki.git')).toContain('ssh://');
    vi.stubEnv('FOCUSWIKI_ALLOW_GIT_SSH', '0');
    expect(() => validateGitRemoteUrl('git@git.example.com:owner/wiki.git')).toThrow(/SSH/);
    expect(() => validateGitRemoteUrl('ssh://git@git.example.com/owner/wiki.git')).toThrow(/SSH/);
  });

  it('enforces real file boundaries, empty roots, strict containment and symlink escapes', async () => {
    expect(validateGitRemoteUrl(url, [root])).toBe(url);
    expect(() => validateGitRemoteUrl(url, [])).toThrow(PathBoundaryError);
    expect(() => validateGitRemoteUrl(url, [bare])).toThrow(PathBoundaryError);
    expect(() => validateGitRemoteUrl(url, [repo])).toThrow(PathBoundaryError);
    const link = path.join(repo, 'escape.git');
    fs.symlinkSync(bare, link);
    expect(() => validateGitRemoteUrl(pathToFileURL(link).href, [repo])).toThrow(PathBoundaryError);
    await expect(inspectRemoteRepository(url, { allowedFileRoots: [repo] })).rejects.toMatchObject({ statusCode: 403 });
    await expect(cloneRepository({ url, destDir: path.join(root, 'denied'), allowedFileRoots: [] })).rejects.toMatchObject({ statusCode: 403 });
    const info = await inspectRemoteRepository(url, { allowedFileRoots: [root] });
    expect(info.defaultBranch).toBe('main');
    vi.stubEnv('FOCUSWIKI_ALLOW_FILE_REMOTES', '0');
    expect(() => validateGitRemoteUrl(url)).toThrow(PathBoundaryError);
  });

  it.each([
    '0.0.0.0', '127.0.0.1', '127.255.255.255', '169.254.169.254', '169.254.0.1',
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255',
    '224.0.0.1', '239.255.255.255', '255.255.255.255', '::', '::1', '0:0:0:0:0:0:0:1',
    'fe80::1', 'febf::1', 'fc00::1', 'fdff::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:a00:1'
  ])('classifies restricted address %s without DNS', (ip) => expect(isBlockedGitIp(ip)).toBe(true));

  it.each(['8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.169.0.1', '2001:4860:4860::8888', '::ffff:808:808'])('permits public address %s', (ip) => expect(isBlockedGitIp(ip)).toBe(false));

  it('matches exact hosts, domain suffixes, IPs and explicit full-LAN permission', async () => {
    vi.stubEnv('FOCUSWIKI_ALLOWED_GIT_HOSTS', 'git.internal, .example.internal, 10.0.0.9, ::1');
    expect(isGitHostAllowed('GIT.INTERNAL.')).toBe(true);
    expect(isGitHostAllowed('repo.example.internal')).toBe(true);
    expect(isGitHostAllowed('evil-example.internal')).toBe(false);
    expect(isGitHostAllowed('git.internal.evil.com')).toBe(false);
    expect(isGitHostAllowed('another.internal', '10.0.0.9')).toBe(true);
    expect(isGitHostAllowed('[0:0:0:0:0:0:0:1]')).toBe(true);
    await expect(assertGitRemoteHostAllowed('ssh://git@[::1]/repo')).resolves.toBeUndefined();
    vi.stubEnv('FOCUSWIKI_ALLOWED_GIT_HOSTS', '*');
    await expect(assertGitRemoteHostAllowed('https://169.254.169.254/repo')).resolves.toBeUndefined();
  });

  it('checks all DNS answers and blocks every network operation before contacting private hosts', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation((async () => [
      { address: '8.8.8.8', family: 4 }, { address: '10.0.0.3', family: 4 }
    ]) as unknown as typeof dns.lookup);
    await expect(inspectRemoteRepository('https://git.internal/repo')).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('FOCUSWIKI_ALLOWED_GIT_HOSTS') });
    await expect(cloneRepository({ url: 'git@git.internal:owner/repo', destDir: path.join(root, 'blocked') })).rejects.toMatchObject({ statusCode: 403 });
    git(repo, ['remote', 'add', 'origin', 'https://git.internal/repo']);
    await expect(fetchGitRemote(repo)).rejects.toMatchObject({ statusCode: 403 });
    await expect(pullGitRemote(repo)).rejects.toMatchObject({ statusCode: 403 });
    expect(lookup).toHaveBeenCalledWith('git.internal', { all: true });
    vi.stubEnv('FOCUSWIKI_ALLOWED_GIT_HOSTS', 'git.internal');
    await expect(assertGitRemoteHostAllowed('https://git.internal/repo')).resolves.toBeUndefined();
    lookup.mockRejectedValue(new Error('DNS unavailable'));
    await expect(assertGitRemoteHostAllowed('https://missing.internal/repo')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('Git execution, atomic clones and commits', () => {
  it('never inherits process secrets, injected git config or executable overrides', () => {
    vi.stubEnv('GITHUB_TOKEN', 'should-not-inherit');
    vi.stubEnv('LD_PRELOAD', '/tmp/evil.so');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_SSH_COMMAND', 'sh /tmp/evil');
    vi.stubEnv('HTTPS_PROXY', 'http://169.254.169.254');
    const env = buildGitEnv();
    for (const key of ['GITHUB_TOKEN', 'LD_PRELOAD', 'GIT_CONFIG_COUNT', 'HTTPS_PROXY']) expect(env[key]).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toMatch(/^ssh -oBatchMode=yes/);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('neutralizes source, template and repo-local hooks and fsmonitor during clone, checkout and commit', async () => {
    const marker = path.join(root, 'HOOK_EXECUTED');
    const script = `#!/bin/sh\ntouch '${marker}'\n`;
    const hooks = path.join(root, 'malicious-hooks');
    fs.mkdirSync(hooks);
    for (const hook of ['post-checkout', 'pre-commit', 'post-commit', 'fsmonitor']) fs.writeFileSync(path.join(hooks, hook), script, { mode: 0o700 });
    fs.writeFileSync(path.join(bare, 'hooks', 'post-checkout'), script, { mode: 0o700 });
    git(bare, ['config', 'core.hooksPath', hooks]);
    git(bare, ['config', 'core.fsmonitor', path.join(hooks, 'fsmonitor')]);
    const template = path.join(root, 'template');
    fs.mkdirSync(path.join(template, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(template, 'hooks', 'post-checkout'), script, { mode: 0o700 });
    vi.stubEnv('GIT_TEMPLATE_DIR', template);
    const destDir = path.join(root, 'safe-clone');
    await cloneRepository({ url, destDir, allowedFileRoots: [root] });
    for (const key of ['core.hooksPath', 'core.fsmonitor', 'core.sshCommand', 'core.gitProxy', 'core.askPass', 'credential.helper']) {
      expect(() => git(destDir, ['config', '--local', '--get', key])).toThrow();
    }
    git(destDir, ['config', 'core.hooksPath', hooks]);
    git(destDir, ['config', 'core.fsmonitor', path.join(hooks, 'fsmonitor')]);
    fs.mkdirSync(path.join(destDir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(destDir, '.git', 'hooks', 'pre-commit'), script, { mode: 0o700 });
    await checkoutGitTarget(destDir, { kind: 'remote', ref: 'origin/feature' });
    fs.appendFileSync(path.join(destDir, 'README.md'), '\nA safe fictional edit.\n');
    await commitWorkingTree(destDir, 'Human-authored update', 'Fictional Author', 'author@invalid');
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(destDir, ['log', '-1', '--format=%B']).trim()).toBe('Human-authored update');
    expect(git(destDir, ['show', 'HEAD:.gitignore'])).toBe('.focuswiki/\n.cairn/\n');
  });

  it('cleans staging directories after clone and post-clone PR failures, without touching existing destinations', async () => {
    const destDir = path.join(root, 'failed');
    await expect(cloneRepository({ url, destDir, branch: 'missing-branch' })).rejects.toThrow(/clone failed/i);
    expect(fs.existsSync(destDir)).toBe(false);
    expect(fs.readdirSync(root).filter((entry) => entry.startsWith('.cloning-'))).toEqual([]);
    await expect(cloneRepository({ url, destDir, prNumber: 999 })).rejects.toMatchObject({ statusCode: 404 });
    expect(fs.existsSync(destDir)).toBe(false);
    expect(fs.readdirSync(root).filter((entry) => entry.startsWith('.cloning-'))).toEqual([]);
    fs.mkdirSync(destDir);
    fs.writeFileSync(path.join(destDir, 'keep'), 'existing data');
    await expect(cloneRepository({ url, destDir })).rejects.toMatchObject({ statusCode: 409 });
    expect(fs.readFileSync(path.join(destDir, 'keep'), 'utf8')).toBe('existing data');
  });

  it('supports shallow default and PR clones and leaves upstream tracked ignore files untouched', async () => {
    for (const prNumber of [undefined, 7]) {
      const destDir = path.join(root, `shallow-${prNumber ?? 'main'}`);
      const status = await cloneRepository({ url, destDir, shallow: true, prNumber });
      expect(status.branch).toBe(prNumber ? 'pr/7' : 'main');
      expect(git(destDir, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
      expect(git(destDir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
      expect(fs.readFileSync(path.join(destDir, '.gitignore'), 'utf8')).toBe(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'));
      expect(fs.readFileSync(path.join(destDir, '.git', 'info', 'exclude'), 'utf8')).toContain('.focuswiki/\n.cairn/');
    }
  });

  it('serializes duplicate destinations so exactly one clone succeeds', async () => {
    const destDir = path.join(root, 'duplicate');
    const results = await Promise.allSettled([cloneRepository({ url, destDir }), cloneRepository({ url, destDir })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ statusCode: 409 }) })]);
    expect(git(destDir, ['branch', '--show-current']).trim()).toBe('main');
    expect(fs.readdirSync(root).filter((entry) => entry.startsWith('.cloning-'))).toEqual([]);
  });

  it.each([undefined, '1'])('caps parallel clones with configured limit %s', async (limit) => {
    if (limit) vi.stubEnv('FOCUSWIKI_MAX_CONCURRENT_CLONES', limit);
    const bin = path.join(root, 'bin');
    const active = path.join(root, 'active');
    const counts = path.join(root, 'counts');
    fs.mkdirSync(bin);
    fs.mkdirSync(active);
    fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const active = ${JSON.stringify(active)};
const marker = active + '/' + process.pid;
if (args.includes('clone')) fs.writeFileSync(marker, '');
setTimeout(() => {
  if (args.includes('clone')) fs.appendFileSync(${JSON.stringify(counts)}, String(fs.readdirSync(active).length) + '\\n');
  const result = spawnSync('/usr/bin/git', args, { stdio: 'inherit', env: process.env });
  if (args.includes('clone')) fs.unlinkSync(marker);
  process.exit(result.status ?? 1);
}, args.includes('clone') ? 150 : 0);
`, { mode: 0o700 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const statuses = await Promise.all([0, 1, 2].map((i) => cloneRepository({ url, destDir: path.join(root, `parallel-${i}`) })));
    expect(statuses.every((status) => status.branch === 'main')).toBe(true);
    const observed = fs.readFileSync(counts, 'utf8').trim().split('\n').map(Number);
    expect(Math.max(...observed)).toBe(limit ? 1 : 2);
    expect(fs.readdirSync(active)).toEqual([]);
  }, 15_000);

  it('uses permission-restricted ephemeral askpass files and redacts stderr, stdout and URL credentials', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation((async () => [{ address: '8.8.8.8', family: 4 }]) as unknown as typeof dns.lookup);
    const bin = path.join(root, 'credential-bin');
    const observed = path.join(root, 'credential-observation.json');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const helper = process.env.GIT_ASKPASS;
const dir = path.dirname(helper);
const token = execFileSync(helper, ['Password'], {encoding:'utf8'});
const user = execFileSync(helper, ['Username'], {encoding:'utf8'});
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  dir, token, user, modes: [dir, helper, path.join(dir, 'token'), path.join(dir, 'username')].map(p => fs.statSync(p).mode & 511),
  env: Object.keys(process.env), args: process.argv.slice(2)
}));
process.stdout.write('stdout secret: ' + token);
process.stderr.write('fatal: https://' + user + ':' + token + '@example.com/repo using ' + token);
process.exit(1);
`, { mode: 0o700 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const secret = 'github_pat_EPHEMERAL_FICTIONAL_12345';
    const failure = await inspectRemoteRepository('https://example.com/fictional.git', {
      overrideCredential: { username: 'fictional-user', token: secret }
    }).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).message).not.toContain('fictional-user');
    const observation = JSON.parse(fs.readFileSync(observed, 'utf8')) as { dir: string; token: string; user: string; modes: number[]; env: string[]; args: string[] };
    expect(observation.token).toBe(secret);
    expect(observation.user).toBe('fictional-user');
    expect(observation.modes).toEqual([0o700, 0o700, 0o600, 0o600]);
    expect(observation.env).not.toContain('CAIRN_GIT_TOKEN');
    expect(observation.env).not.toContain('GITHUB_TOKEN');
    expect(observation.args.join(' ')).toContain('core.hooksPath=/dev/null');
    expect(observation.args.join(' ')).toContain('protocol.allow=never');
    expect(observation.args.join(' ')).not.toContain('protocol.file.allow=always');
    expect(fs.existsSync(observation.dir)).toBe(false);
  });

  it.each(['-dangerous', 'x..y', 'x@{1}', 'x.lock', 'a/x.lock/b', 'a\\b', 'a\n', '.hidden', 'x/', 'x//y', 'x.'])('rejects invalid branch %j before cloning or checkout', async (branch) => {
    await expect(cloneRepository({ url, destDir: path.join(root, 'bad-ref'), branch })).rejects.toMatchObject({ statusCode: 400 });
    await expect(checkoutGitTarget(repo, { kind: 'local', ref: branch })).rejects.toMatchObject({ statusCode: 400 });
    expect(fs.existsSync(path.join(root, 'bad-ref'))).toBe(false);
  });

  it('excludes app-private conflict state even when it was forcibly staged', async () => {
    for (const dir of ['.focuswiki', '.cairn']) {
      fs.mkdirSync(path.join(repo, dir, 'conflicts'), { recursive: true });
      fs.writeFileSync(path.join(repo, dir, 'conflicts', 'draft.md'), 'PRIVATE DRAFT');
      git(repo, ['add', '-f', '--', dir]);
    }
    fs.appendFileSync(path.join(repo, 'README.md'), '\nPublic update.\n');
    await commitWorkingTree(repo, 'Publish only repository documents');
    expect(git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toMatch(/\.focuswiki|\.cairn/);
    expect(fs.readFileSync(path.join(repo, '.focuswiki', 'conflicts', 'draft.md'), 'utf8')).toBe('PRIVATE DRAFT');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('commits only selected literal paths, preserving unrelated unstaged and staged edits', async () => {
    fs.appendFileSync(path.join(repo, 'README.md'), '\nSelected change.\n');
    fs.appendFileSync(path.join(repo, 'other.md'), '\nUnselected change.\n');
    fs.writeFileSync(path.join(repo, 'already-staged.md'), 'Pre-existing staged edit');
    git(repo, ['add', 'already-staged.md']);
    const result = await commitWorkingTree(repo, 'Only selected document', undefined, undefined, undefined, ['README.md']);
    expect(result.status.isClean).toBe(false);
    expect(git(repo, ['show', '--format=', '--name-only', 'HEAD']).trim()).toBe('README.md');
    expect(git(repo, ['diff', '--name-only']).trim()).toBe('other.md');
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('already-staged.md');
    fs.writeFileSync(path.join(repo, 'literal[1].md'), 'Literal name');
    await commitWorkingTree(repo, 'Literal path', undefined, undefined, undefined, ['literal[1].md']);
    expect(git(repo, ['show', '--format=', '--name-only', 'HEAD']).trim()).toBe('literal[1].md');
  });

  it.each(['../outside.md', '.git/config', '.focuswiki/conflicts/draft.md', '.cairn/private.md', 'x/../README.md', ':(glob)**'])('rejects protected or nonliteral selected path %j', async (selected) => {
    fs.appendFileSync(path.join(repo, 'README.md'), '\nEdit.\n');
    await expect(commitWorkingTree(repo, 'Bad path', undefined, undefined, undefined, [selected])).rejects.toThrow();
  });

  it('queues commits to separate paths on the same repository without index.lock failures', async () => {
    fs.appendFileSync(path.join(repo, 'README.md'), '\nFirst edit.\n');
    fs.appendFileSync(path.join(repo, 'other.md'), '\nSecond edit.\n');
    await Promise.all([
      commitWorkingTree(repo, 'First', undefined, undefined, undefined, ['README.md']),
      commitWorkingTree(repo, 'Second', undefined, undefined, undefined, ['other.md'])
    ]);
    expect(git(repo, ['log', '-2', '--format=%s']).trim()).toBe('Second\nFirst');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });
});

describe('Project path and metadata isolation', () => {
  it('blocks docs, assets, aliases, symlink chains and dangling symlinks into private state', () => {
    fs.mkdirSync(path.join(repo, '.focuswiki', 'conflicts'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.focuswiki', 'conflicts', 'draft.md'), 'Private');
    fs.mkdirSync(path.join(repo, '.cairn'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cairn', 'private.json'), '{}');
    fs.symlinkSync('.focuswiki', path.join(repo, 'alias'));
    fs.symlinkSync('alias', path.join(repo, 'chain'));
    fs.symlinkSync(path.join(root, 'missing'), path.join(repo, 'dangling'));
    fs.symlinkSync(bare, path.join(repo, 'outside'));
    for (const relative of ['.focuswiki/conflicts/draft.md', 'alias/conflicts/draft.md', 'chain/conflicts/new.md', 'dangling/new.md', 'outside/HEAD']) {
      expect(() => resolveSafeProjectPath(repo, relative)).toThrow(PathBoundaryError);
    }
    expect(() => resolveSafeEmbedAssetPath(repo, '.cairn/private.json')).toThrow(PathBoundaryError);
    fs.symlinkSync('README.md', path.join(repo, 'safe.md'));
    expect(resolveSafeProjectPath(repo, 'safe.md').normalizedRelPath).toBe('safe.md');
  });
});
