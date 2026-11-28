import { execFileSync, type ExecFileException, type ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRepoToken, publishProposal, reviewProposal, type ProposalContext } from '../server/proposalService.js';

const upstream = vi.hoisted(() => ({
  localUrl: '',
  pushes: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
  beforePush: undefined as (() => void) | undefined,
  losePushResponse: false
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: string[], options: ExecFileOptionsWithBufferEncoding,
      callback: (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void) => {
      if (!args.includes('push')) return actual.execFile(file, args, options, callback);
      upstream.pushes.push({ args, env: options.env ?? {} });
      upstream.beforePush?.();
      return actual.execFile(file, args.map((arg) =>
        arg === 'https://github.com/ExampleOrg/FableDocs.git' || arg === 'https://git.invalid.ts.net/ExampleOrg/LanDocs.git'
          ? upstream.localUrl : arg
      ), { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } }, (error, stdout, stderr) => {
        if (!error && upstream.losePushResponse) {
          upstream.losePushResponse = false;
          return callback(new Error('mock lost push response with fictional-write-token'), stdout, stderr);
        }
        return callback(error, stdout, stderr);
      });
    }
  };
});

const remote = 'https://github.com/ExampleOrg/FableDocs.git';
const slug = 'ExampleOrg/FableDocs';
const installationId = '303';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const readToken = 'fictional-read-token';
const writeToken = 'fictional-write-token';
const pullRequestUrl = 'https://github.com/ExampleOrg/FableDocs/pull/17';
const baseBranch = 'main';
const privateText = 'fictional protected inventory';
let root: string;
let ctx: ProposalContext;
let upstreamDir: string;
let base: string;
let calls: ReturnType<typeof mockGitHub>;

function git(...args: string[]): string {
  return execFileSync('git', [
    `--git-dir=${ctx.gitDir}`, `--work-tree=${ctx.workTree}`, ...args
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function origin(...args: string[]): string {
  return execFileSync('git', [`--git-dir=${upstreamDir}`, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trimEnd();
}

function write(relative: string, content: string | Buffer): void {
  const pathname = path.join(ctx.workTree, relative);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, content);
}

function draft() {
  write('Guide.md', '# Fable guide\n\nFollow the lantern.\n');
  write('New.md', '# A new route\n');
}

function mockGitHub() {
  const state = {
    installation: Number(installationId),
    tokenScope: undefined as Record<string, string> | undefined,
    otherRepo: false,
    defaultBranch: baseBranch,
    postCount: 0,
    failCreate: false,
    losePrResponse: false,
    pulls: [] as unknown[],
    fetch: vi.fn()
  };
  state.fetch.mockImplementation(async (urlString: string, init: RequestInit) => {
    const url = new URL(urlString);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const auth = new Headers(init.headers).get('Authorization');
    expect(url.origin).toBe('https://api.github.com');
    expect(url.username + url.password).toBe('');
    expect(url.href).not.toContain('fictional-');
    expect(init.redirect).toBe('error');
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const requireJwt = () => {
      const [header, payload, signature] = auth!.slice('Bearer '.length).split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('RS256');
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss).toBe('101');
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey.publicKey,
        Buffer.from(signature, 'base64url'))).toBe(true);
    };
    if (url.pathname === `/repos/${slug}/installation`) {
      requireJwt();
      return json({ id: state.installation });
    }
    if (url.pathname === `/app/installations/${installationId}/access_tokens`) {
      requireJwt();
      expect(body.repositories).toEqual(['FableDocs']);
      const writeGrant = body.permissions.contents === 'write';
      expect(body.permissions).toEqual(writeGrant
        ? { contents: 'write', pull_requests: 'write' } : { contents: 'read' });
      return json({
        token: writeGrant ? writeToken : readToken,
        permissions: state.tokenScope ?? { ...body.permissions, metadata: 'read' },
        repositories: [{ full_name: state.otherRepo ? 'DifferentOrg/FableDocs' : slug }]
      }, 201);
    }
    const endpoint = `/repos/${slug}`;
    if (url.pathname === endpoint) {
      expect(auth).toBe(`Bearer ${readToken}`);
      return json({ full_name: slug, default_branch: state.defaultBranch });
    }
    if (url.pathname.startsWith(`${endpoint}/git/ref/`)) {
      expect(auth).toBe(`Bearer ${readToken}`);
      const ref = `refs/${url.pathname.slice(`${endpoint}/git/ref/`.length)}`;
      try {
        return json({ ref, object: { type: 'commit', sha: origin('rev-parse', '--verify', ref) } });
      } catch {
        return json({}, 404);
      }
    }
    if (url.pathname === `${endpoint}/pulls`) {
      expect(auth).toBe(`Bearer ${writeToken}`);
      if (init.method === 'GET') {
        expect(url.searchParams.get('head')).toBe(`ExampleOrg:${ctx.branch}`);
        expect(url.searchParams.get('base')).toBe(baseBranch);
        return json(state.pulls);
      }
      state.postCount++;
      if (state.failCreate) return json({ error: writeToken }, 500);
      expect(body.head).toBe(ctx.branch);
      expect(body.base).toBe(baseBranch);
      const pull = {
        html_url: pullRequestUrl,
        head: { ref: ctx.branch, sha: origin('rev-parse', `refs/heads/${ctx.branch}`), repo: { full_name: slug } },
        base: { ref: body.base, repo: { full_name: slug } }
      };
      state.pulls.push(pull);
      if (state.losePrResponse) {
        state.losePrResponse = false;
        throw new Error(`mock lost PR response: ${writeToken}`);
      }
      return json(pull, 201);
    }
    throw new Error('Unexpected API route.');
  });
  vi.stubGlobal('fetch', state.fetch);
  return state;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-service-'));
  ctx = { projectId: 'fables', gitDir: path.join(root, 'git'), workTree: path.join(root, 'docs'), remote, branch: 'focuswiki/review/lantern' };
  upstreamDir = path.join(root, 'upstream');
  fs.mkdirSync(ctx.workTree, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', baseBranch, `--separate-git-dir=${ctx.gitDir}`, ctx.workTree]);
  git('config', 'user.name', 'Fictional Reviewer');
  git('config', 'user.email', 'reviewer@example.invalid');
  write('Guide.md', '# Fable guide\n\nFollow the river.\n');
  write('Unrelated.md', '# Background\n');
  write('Old.md', '# Retired route\n');
  write('.gitignore', 'private-notes.md\n');
  git('add', '.');
  git('commit', '-qm', 'Fictional base');
  base = git('rev-parse', 'HEAD');
  execFileSync('git', ['init', '-q', '--bare', '-b', baseBranch, upstreamDir]);
  git('push', '-q', upstreamDir, `HEAD:refs/heads/${baseBranch}`);

  const keyPath = path.join(root, 'app.pem');
  fs.writeFileSync(keyPath, privateKey.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o400 });
  vi.stubEnv('FOCUSWIKI_GITHUB_APP_KEY_FILE', keyPath);
  vi.stubEnv('FOCUSWIKI_GITHUB_APP_ID', '101');
  vi.stubEnv('FOCUSWIKI_GITHUB_INSTALLATION_ID', installationId);
  upstream.localUrl = pathToFileURL(upstreamDir).href;
  upstream.pushes = [];
  upstream.beforePush = undefined;
  upstream.losePushResponse = false;
  calls = mockGitHub();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('proposal worker', () => {
  it('issues a repository-specific and permission-specific App token', async () => {
    await expect(getRepoToken(ctx, 'read')).resolves.toBe(readToken);
    await expect(getRepoToken(ctx, 'write')).resolves.toBe(writeToken);
    calls.tokenScope = { contents: 'write', metadata: 'read' };
    await expect(getRepoToken(ctx, 'read')).rejects.toThrow(/unexpected scope/);
    calls.tokenScope = undefined;
    calls.otherRepo = true;
    await expect(getRepoToken(ctx, 'read')).rejects.toThrow(/unexpected scope/);
    calls.installation++;
    await expect(getRepoToken(ctx, 'read')).rejects.toThrow(/does not belong/);
    expect(calls.fetch).toHaveBeenCalledTimes(9);
  });

  it('rejects noncanonical remotes, unsafe branches, and non-isolated metadata before access', async () => {
    for (const invalid of [
      { remote: 'https://example.invalid/ExampleOrg/FableDocs.git' },
      { remote: 'https://name:fictional@github.com/ExampleOrg/FableDocs.git' },
      { remote: 'https://github.com:443/ExampleOrg/FableDocs.git' },
      { remote: 'https://github.com/ExampleOrg%2fOther/FableDocs.git' },
      { remote: 'https://github.com/ExampleOrg/FableDocs.git?access=fictional' },
      { branch: 'main' }, { branch: 'focuswiki/../main' }, { branch: 'focuswiki/ref.lock' },
      { gitDir: ctx.workTree }
    ]) {
      await expect(getRepoToken({ ...ctx, ...invalid }, 'read')).rejects.toThrow();
    }
    const linkedKey = path.join(root, 'linked-key');
    fs.symlinkSync(process.env.FOCUSWIKI_GITHUB_APP_KEY_FILE!, linkedKey);
    vi.stubEnv('FOCUSWIKI_GITHUB_APP_KEY_FILE', linkedKey);
    await expect(getRepoToken(ctx, 'read')).rejects.toThrow(/secret file/);
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it('reviews only bounded safe content and omits protected paths before reading their bytes', async () => {
    draft();
    write('private-notes.md', privateText);
    write('.github/workflows/draft.yml', privateText);
    write('keys/signing.pem', privateText);
    write('Large.md', Buffer.alloc(64 * 1024 + 1, 'z'));
    write('Binary.md', Buffer.from([10, 0, 255]));
    write('Notes.md', 'password=fictional-credential-value');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, privateText);
    fs.symlinkSync(outside, path.join(ctx.workTree, 'Alias.md'));
    fs.linkSync(outside, path.join(ctx.workTree, 'Hardlink.md'));
    fs.symlinkSync(root, path.join(ctx.workTree, 'Outside'));
    const review = await reviewProposal(ctx);
    expect(review.files.map((entry) => entry.path)).toEqual(['Guide.md', 'New.md']);
    expect(review.files[0].markdownReview?.substantiveCount).toBe(1);
    expect(review.diff).toContain('+Follow the lantern.');
    expect(JSON.stringify(review)).not.toMatch(/fictional protected inventory|fictional-credential-value|Alias\.md|Hardlink\.md|signing\.pem/);
    await expect(publishProposal(ctx, { ...review, paths: ['Outside/outside.txt'], message: 'Submit route' }))
      .rejects.toThrow(/outside the review/);
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it.each(['staged', 'unstaged'] as const)('quarantines a %s move of a protected old path', async (mode) => {
    write('.env', privateText);
    git('add', '.env');
    git('commit', '-qm', 'Protected fixture');
    if (mode === 'staged') git('mv', '.env', 'Renamed.md');
    else fs.renameSync(path.join(ctx.workTree, '.env'), path.join(ctx.workTree, 'Renamed.md'));
    if (mode === 'staged') write('.env', privateText);
    await expect(reviewProposal(ctx)).rejects.toThrow(/^A protected base path/);
    expect(fs.existsSync(path.join(ctx.gitDir, 'focuswiki-proposals'))).toBe(false);
  });

  it('quarantines an old symlink or secret-looking old blob before producing a review', async () => {
    fs.symlinkSync('Guide.md', path.join(ctx.workTree, 'OldLink.md'));
    write('Historical.md', 'api_key=fictional-historical-value');
    git('add', 'OldLink.md', 'Historical.md');
    git('commit', '-qm', 'Protected fixtures');
    fs.renameSync(path.join(ctx.workTree, 'OldLink.md'), path.join(ctx.workTree, 'MovedLink.md'));
    await expect(reviewProposal(ctx)).rejects.toThrow(/protected base path/);
    fs.renameSync(path.join(ctx.workTree, 'MovedLink.md'), path.join(ctx.workTree, 'OldLink.md'));
    fs.renameSync(path.join(ctx.workTree, 'Historical.md'), path.join(ctx.workTree, 'Renamed.md'));
    await expect(reviewProposal(ctx)).rejects.toThrow(/protected content/);
  });

  it('fails closed when the aggregate diff cannot fit in one review', async () => {
    for (let i = 0; i < 10; i++) write(`Page-${i}.txt`, 'a'.repeat(32 * 1024) + '\n');
    git('add', '.');
    git('commit', '-qm', 'Fictional large catalog');
    for (let i = 0; i < 10; i++) write(`Page-${i}.txt`, 'b'.repeat(32 * 1024) + '\n');
    await expect(reviewProposal(ctx)).rejects.toThrow(/diff exceeds the review limit/);
  });

  it('publishes one real commit with exact selected bytes, intent and user attribution', async () => {
    draft();
    write('Guide.md', '# Fable guide\r\n\r\nFollow the lantern.\r\n');
    write('Unrelated.md', 'External staged work\n');
    git('add', 'Unrelated.md', 'Guide.md');
    write('Guide.md', '# Fable guide\r\n\r\nFollow the lantern twice.\r\n');
    fs.chmodSync(path.join(ctx.workTree, 'Guide.md'), 0o755);
    fs.unlinkSync(path.join(ctx.workTree, 'Old.md'));
    write('.git', 'gitdir: ../missing-from-enrollment\n');
    const beforeIndex = fs.readFileSync(path.join(ctx.gitDir, 'index'));
    const review = await reviewProposal(ctx);
    expect(review.diff).toContain('new mode 100755');
    expect(review.diff).toContain('Follow the lantern twice.');
    const message = 'Update the lantern route\n\nReviewed by the map keeper.\n';
    const result = await publishProposal(ctx, { reviewId: review.reviewId, message, paths: ['Old.md', 'Guide.md'] });
    expect(result.url).toBe(pullRequestUrl);
    expect(origin('rev-list', '--parents', '-n', '1', result.sha)).toBe(`${result.sha} ${base}`);
    expect(origin('diff-tree', '--no-commit-id', '--name-only', '-r', result.sha)).toBe('Guide.md\nOld.md');
    expect(origin('show', '-s', '--format=%an <%ae>%n%B', result.sha)).toBe(
      'Fictional Reviewer <reviewer@example.invalid>\n' + message.trimEnd()
    );
    expect(execFileSync('git', [`--git-dir=${upstreamDir}`, 'show', `${result.sha}:Guide.md`]))
      .toEqual(fs.readFileSync(path.join(ctx.workTree, 'Guide.md')));
    expect(origin('ls-tree', result.sha, 'Guide.md')).toMatch(/^100755 /);
    expect(git('rev-parse', 'HEAD')).toBe(base);
    expect(fs.readFileSync(path.join(ctx.gitDir, 'index'))).toEqual(beforeIndex);
    expect(upstream.pushes).toHaveLength(1);
    const [{ args, env }] = upstream.pushes;
    expect(args).toContain(remote);
    expect(args.join(' ')).not.toMatch(/fictional-|--force|\+refs/);
    expect(env).toMatchObject({ FOCUSWIKI_PUSH_TOKEN: writeToken, GIT_ALLOW_PROTOCOL: 'https' });
  });

  it('represents safe moves as selected additions and deletions', async () => {
    fs.renameSync(path.join(ctx.workTree, 'Old.md'), path.join(ctx.workTree, 'Route.md'));
    const review = await reviewProposal(ctx);
    expect(review.status.changedFiles).toEqual([
      { path: 'Old.md', status: 'deleted' }, { path: 'Route.md', status: 'added' }
    ]);
    const { sha } = await publishProposal(ctx, { reviewId: review.reviewId, paths: ['Route.md', 'Old.md'], message: 'Rename the route' });
    expect(origin('diff-tree', '--no-commit-id', '--name-status', '-M', '-r', sha)).toBe('R100\tOld.md\tRoute.md');
  });

  it('rejects stale, unrelated, replayed or unsafe selections before minting a write token', async () => {
    draft();
    const review = await reviewProposal(ctx);
    const message = 'Accept lantern route';
    const input = { reviewId: review.reviewId, message, paths: ['Guide.md'] };
    write('Unrelated.md', 'Unreviewed work');
    await expect(publishProposal(ctx, { ...input, paths: ['Unrelated.md'] })).rejects.toThrow(/outside the review/);
    await expect(publishProposal(ctx, { ...input, paths: ['../Guide.md'] })).rejects.toThrow();
    await expect(publishProposal({ ...ctx, projectId: 'different-fables' }, input)).rejects.toThrow(/unavailable/);
    write('Guide.md', 'New bytes after review');
    await expect(publishProposal(ctx, input)).rejects.toThrow(/reviewed paths have changed/);
    fs.unlinkSync(path.join(ctx.workTree, 'Guide.md'));
    fs.symlinkSync('Old.md', path.join(ctx.workTree, 'Guide.md'));
    await expect(publishProposal(ctx, input)).rejects.toThrow(/reviewed paths have changed/);
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it('rejects base advancement without rebasing or resetting the checkout', async () => {
    draft();
    const review = await reviewProposal(ctx);
    const input = { reviewId: review.reviewId, message: 'Accept route', paths: ['Guide.md'] };
    git('commit', '--allow-empty', '-qm', 'Advanced local base');
    const newBase = git('rev-parse', 'HEAD');
    await expect(publishProposal(ctx, input)).rejects.toThrow(/local base changed/);
    const rebased = await reviewProposal(ctx);
    origin('update-ref', `refs/heads/${baseBranch}`, base);
    await expect(publishProposal(ctx, { ...input, reviewId: rebased.reviewId })).rejects.toThrow(/repository base changed/);
    expect(git('rev-parse', 'HEAD')).toBe(newBase);
    expect(upstream.pushes).toHaveLength(0);
  });

  it('publishes against the reviewed branch, not the GitHub default or a same-SHA replacement', async () => {
    draft();
    calls.defaultBranch = 'other';
    origin('update-ref', 'refs/heads/other', base);
    const review = await reviewProposal(ctx);
    const input = { reviewId: review.reviewId, message: 'Review the guide', paths: ['Guide.md'] };
    git('branch', 'other', base);
    git('symbolic-ref', 'HEAD', 'refs/heads/other');
    await expect(publishProposal(ctx, input)).rejects.toThrow(/unavailable/);
    expect(calls.fetch).not.toHaveBeenCalled();
    git('symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`);
    expect((await publishProposal(ctx, input)).url).toBe(pullRequestUrl);
  });

  it('does not overwrite a proposal branch created before Git advertises refs', async () => {
    draft();
    const review = await reviewProposal(ctx);
    upstream.beforePush = () => { origin('update-ref', `refs/heads/${ctx.branch}`, base); };
    const input = { reviewId: review.reviewId, message: 'Accept route', paths: ['Guide.md'] };
    await expect(publishProposal(ctx, input)).rejects.toThrow(/^Proposal push failed\.$/);
    expect(origin('rev-parse', `refs/heads/${ctx.branch}`)).toBe(base);
    expect(calls.postCount).toBe(0);
    await expect(publishProposal(ctx, input)).rejects.toThrow(/occupied/);
  });

  it('recovers the same pushed commit when the push response is lost', async () => {
    draft();
    const review = await reviewProposal(ctx);
    const input = { reviewId: review.reviewId, message: 'Accept route', paths: ['Guide.md'] };
    upstream.losePushResponse = true;
    await expect(publishProposal(ctx, input)).rejects.toThrow(/^Proposal push failed\.$/);
    const sha = origin('rev-parse', `refs/heads/${ctx.branch}`);
    expect(calls.postCount).toBe(0);
    vi.resetModules();
    const restarted = await import('../server/proposalService.js');
    await expect(restarted.publishProposal(ctx, input)).resolves.toEqual({ url: pullRequestUrl, sha });
    expect(upstream.pushes).toHaveLength(1);
    expect(calls.postCount).toBe(1);
  });

  it('recovers push and PR partial failures after restart without resubmitting either', async () => {
    draft();
    const review = await reviewProposal(ctx);
    const input = { reviewId: review.reviewId, message: 'Accept route', paths: ['Guide.md'] };
    calls.failCreate = true;
    await expect(publishProposal(ctx, input)).rejects.toThrow(/^GitHub request failed \(HTTP 500\)\.$/);
    const sha = origin('rev-parse', `refs/heads/${ctx.branch}`);
    expect(git('rev-parse', `refs/focuswiki/proposals/${review.reviewId}`)).toBe(sha);
    write('Guide.md', 'Continued draft after push');
    git('commit', '--allow-empty', '-qm', 'Separate base update');
    git('push', '-q', upstreamDir, `HEAD:refs/heads/${baseBranch}`);
    calls.failCreate = false;
    calls.losePrResponse = true;
    vi.resetModules();
    const restarted = await import('../server/proposalService.js');
    await expect(restarted.publishProposal(ctx, input)).rejects.toThrow(/^GitHub request could not be completed\.$/);
    await expect(restarted.publishProposal(ctx, input)).resolves.toEqual({ url: pullRequestUrl, sha });
    expect(upstream.pushes).toHaveLength(1);
    expect(calls.postCount).toBe(2);
    calls.fetch.mockClear();
    await expect(restarted.publishProposal(ctx, input)).resolves.toEqual({ url: pullRequestUrl, sha });
    await expect(restarted.publishProposal(ctx, { ...input, message: 'Different approval' })).rejects.toThrow(/different publication/);
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it('leaves an already-pushed branch deleted when an operator removes it', async () => {
    draft();
    const review = await reviewProposal(ctx);
    const input = { reviewId: review.reviewId, message: 'Accept route', paths: ['Guide.md'] };
    calls.failCreate = true;
    await expect(publishProposal(ctx, input)).rejects.toThrow(/HTTP 500/);
    origin('update-ref', '-d', `refs/heads/${ctx.branch}`);
    await expect(publishProposal(ctx, input)).rejects.toThrow(/branch was removed/);
    expect(upstream.pushes).toHaveLength(1);
    expect(calls.postCount).toBe(1);
  });

  it('recovers a PR with a lost response after GitHub removes the topic branch', async () => {
    draft();
    const review = await reviewProposal(ctx);
    const input = { reviewId: review.reviewId, message: 'Accept route', paths: ['Guide.md'] };
    calls.losePrResponse = true;
    await expect(publishProposal(ctx, input)).rejects.toThrow(/could not be completed/);
    const sha = origin('rev-parse', `refs/heads/${ctx.branch}`);
    origin('update-ref', '-d', `refs/heads/${ctx.branch}`);
    await expect(publishProposal(ctx, input)).resolves.toEqual({ url: pullRequestUrl, sha });
    expect(upstream.pushes).toHaveLength(1);
    expect(calls.postCount).toBe(1);
  });

  it('supports Forgejo proposals, exact ref matching, token file guards, and crash recovery', async () => {
    const forgejoOrigin = 'https://git.invalid.ts.net';
    const forgejoRemote = `${forgejoOrigin}/ExampleOrg/LanDocs.git`;
    const forgejoPrUrl = `${forgejoOrigin}/ExampleOrg/LanDocs/pulls/12`;
    const forgejoToken = 'fictional-forgejo-token-value';
    const tokenPath = path.join(root, 'forgejo.token');
    fs.writeFileSync(tokenPath, `${forgejoToken}\n`, { mode: 0o400 });
    const forgejoCtx: ProposalContext = { ...ctx, projectId: 'lan-docs', remote: forgejoRemote };

    // Rejects Forgejo remote with actionable config errors when FOCUSWIKI_FORGEJO_ORIGIN is unset, invalid, or mismatched.
    await expect(getRepoToken(forgejoCtx, 'read')).rejects.toThrow(/requires FOCUSWIKI_FORGEJO_ORIGIN to be set/);
    vi.stubEnv('FOCUSWIKI_FORGEJO_ORIGIN', 'https://github.com');
    await expect(getRepoToken(forgejoCtx, 'read')).rejects.toThrow(/valid non-GitHub https:\/\/ origin/);
    vi.stubEnv('FOCUSWIKI_FORGEJO_ORIGIN', 'https://other.invalid.ts.net');
    vi.stubEnv('FOCUSWIKI_FORGEJO_TOKEN_FILE', tokenPath);
    await expect(getRepoToken(forgejoCtx, 'read')).rejects.toThrow(/does not match FOCUSWIKI_FORGEJO_ORIGIN/);

    // Reports missing/unconfigured token file clearly and rejects symlinked token file.
    vi.stubEnv('FOCUSWIKI_FORGEJO_ORIGIN', forgejoOrigin);
    vi.stubEnv('FOCUSWIKI_FORGEJO_TOKEN_FILE', '');
    await expect(getRepoToken(forgejoCtx, 'read')).rejects.toThrow(/FOCUSWIKI_FORGEJO_TOKEN_FILE/);
    vi.stubEnv('FOCUSWIKI_FORGEJO_TOKEN_FILE', path.join(root, 'missing-forgejo.token'));
    await expect(getRepoToken(forgejoCtx, 'read')).rejects.toThrow(/FOCUSWIKI_OPENBAO_FORGEJO_SECRET_PATH/);
    const linkedToken = path.join(root, 'linked-forgejo.token');
    fs.symlinkSync(tokenPath, linkedToken);
    vi.stubEnv('FOCUSWIKI_FORGEJO_TOKEN_FILE', linkedToken);
    await expect(getRepoToken(forgejoCtx, 'read')).rejects.toThrow(/Forgejo token could not be read/);

    vi.stubEnv('FOCUSWIKI_FORGEJO_TOKEN_FILE', tokenPath);
    await expect(getRepoToken(forgejoCtx, 'read')).resolves.toBe(forgejoToken);
    await expect(getRepoToken(forgejoCtx, 'write')).resolves.toBe(forgejoToken);

    const pulls: unknown[] = [];
    let postCount = 0;
    let losePrResponse = true;
    const forgejoFetch = vi.fn(async (urlString: string, init: RequestInit) => {
      const url = new URL(urlString);
      const auth = new Headers(init.headers).get('Authorization');
      expect(url.origin).toBe(forgejoOrigin);
      expect(auth).toBe(`token ${forgejoToken}`);
      expect(init.redirect).toBe('error');
      const apiBase = '/api/v1/repos/ExampleOrg/LanDocs';
      if (url.pathname.startsWith(`${apiBase}/git/refs/heads/`)) {
        const suffix = decodeURIComponent(url.pathname.slice(`${apiBase}/git/refs/heads/`.length));
        const ref = `refs/heads/${suffix}`;
        try {
          const sha = origin('rev-parse', '--verify', ref);
          // Include a prefix-matching sibling ref to verify exact ref filtering.
          return Response.json([
            { ref: `${ref}-extra`, object: { type: 'commit', sha: '0'.repeat(40) } },
            { ref, object: { type: 'commit', sha } }
          ]);
        } catch {
          // Return only a prefix-matching sibling when the exact branch does not exist yet.
          return Response.json([
            { ref: `${ref}-extra`, object: { type: 'commit', sha: base } }
          ]);
        }
      }
      if (url.pathname === `${apiBase}/pulls`) {
        if (init.method === 'GET') {
          expect(url.searchParams.get('state')).toBe('all');
          return Response.json(pulls);
        }
        postCount++;
        const body = JSON.parse(String(init.body));
        expect(body.head).toBe(forgejoCtx.branch);
        expect(body.base).toBe(baseBranch);
        const pull = {
          html_url: forgejoPrUrl,
          head: { ref: forgejoCtx.branch, sha: origin('rev-parse', `refs/heads/${forgejoCtx.branch}`), repo: { full_name: 'ExampleOrg/LanDocs' } },
          base: { ref: body.base, repo: { full_name: 'ExampleOrg/LanDocs' } }
        };
        pulls.push(pull);
        if (losePrResponse) {
          losePrResponse = false;
          throw new Error(`mock lost Forgejo PR response: ${forgejoToken}`);
        }
        return Response.json(pull, { status: 201 });
      }
      throw new Error(`Unexpected Forgejo route: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', forgejoFetch);

    draft();
    const review = await reviewProposal(forgejoCtx);
    const input = { reviewId: review.reviewId, message: 'Update internal LAN guide', paths: ['Guide.md'] };
    await expect(publishProposal(forgejoCtx, input)).rejects.toThrow(/^Forgejo request could not be completed\.$/);
    const sha = origin('rev-parse', `refs/heads/${forgejoCtx.branch}`);
    await expect(publishProposal(forgejoCtx, input)).resolves.toEqual({ url: forgejoPrUrl, sha });
    expect(upstream.pushes).toHaveLength(1);
    expect(upstream.pushes[0].args).toContain(forgejoRemote);
    expect(upstream.pushes[0].env.FOCUSWIKI_PUSH_TOKEN).toBe(forgejoToken);
    expect(postCount).toBe(1);
  });

  it('tunnels Forgejo API and Git push through FOCUSWIKI_FORGEJO_PROXY without local DNS lookup', async () => {
    const forgejoOrigin = 'https://git.invalid.ts.net';
    const forgejoRemote = `${forgejoOrigin}/ExampleOrg/LanDocs.git`;
    const forgejoPrUrl = `${forgejoOrigin}/ExampleOrg/LanDocs/pulls/19`;
    const forgejoToken = 'fictional-proxied-forgejo-token';
    const tokenPath = path.join(root, 'forgejo-proxy.token');
    fs.writeFileSync(tokenPath, `${forgejoToken}\n`, { mode: 0o400 });

    const keyPath = path.join(root, 'forgejo.key');
    const certPath = path.join(root, 'forgejo.crt');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=git.invalid.ts.net',
      '-addext', 'subjectAltName=DNS:git.invalid.ts.net,IP:127.0.0.1'
    ], { stdio: 'ignore' });

    const pulls: unknown[] = [];
    const seenHosts: Array<string | undefined> = [];
    const forgejoServer = https.createServer({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    }, (req, res) => {
      seenHosts.push(req.headers.host);
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.headers.authorization !== `token ${forgejoToken}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        const url = new URL(req.url ?? '/', forgejoOrigin);
        const apiBase = '/api/v1/repos/ExampleOrg/LanDocs';
        if (req.method === 'GET' && url.pathname.startsWith(`${apiBase}/git/refs/heads/`)) {
          const suffix = decodeURIComponent(url.pathname.slice(`${apiBase}/git/refs/heads/`.length));
          const ref = `refs/heads/${suffix}`;
          try {
            const sha = origin('rev-parse', '--verify', ref);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([{ ref, object: { type: 'commit', sha } }]));
          } catch {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Not Found' }));
          }
          return;
        }
        if (url.pathname === `${apiBase}/pulls`) {
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(pulls));
            return;
          }
          const body = JSON.parse(raw);
          const pull = {
            html_url: forgejoPrUrl,
            head: { ref: ctx.branch, sha: origin('rev-parse', `refs/heads/${ctx.branch}`), repo: { full_name: 'ExampleOrg/LanDocs' } },
            base: { ref: body.base, repo: { full_name: 'ExampleOrg/LanDocs' } }
          };
          pulls.push(pull);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(pull));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    const tunnels: string[] = [];
    const activeSockets = new Set<{ destroy(): unknown }>();
    const proxyServer = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    await new Promise<void>((resolve) => forgejoServer.listen(0, '127.0.0.1', resolve));
    const forgejoPort = (forgejoServer.address() as AddressInfo).port;
    proxyServer.on('connect', (req, clientSocket, head) => {
      const authority = req.url ?? '';
      tunnels.push(authority);
      activeSockets.add(clientSocket);
      clientSocket.once('close', () => activeSockets.delete(clientSocket));
      if (authority !== 'git.invalid.ts.net:443') {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      const sock = net.connect(forgejoPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) sock.write(head);
        sock.pipe(clientSocket);
        clientSocket.pipe(sock);
      });
      activeSockets.add(sock);
      sock.once('close', () => activeSockets.delete(sock));
      sock.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => sock.destroy());
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxyServer.address() as AddressInfo).port;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    try {
      vi.stubEnv('FOCUSWIKI_FORGEJO_ORIGIN', forgejoOrigin);
      vi.stubEnv('FOCUSWIKI_FORGEJO_TOKEN_FILE', tokenPath);
      vi.stubEnv('FOCUSWIKI_FORGEJO_PROXY', proxyUrl);
      vi.stubEnv('FOCUSWIKI_FORGEJO_CA_FILE', certPath);

      const forgejoCtx: ProposalContext = { ...ctx, projectId: 'lan-docs', remote: forgejoRemote };
      draft();
      const review = await reviewProposal(forgejoCtx);
      const result = await publishProposal(forgejoCtx, {
        reviewId: review.reviewId,
        message: 'Proxied Forgejo proposal',
        paths: ['Guide.md']
      });
      expect(result.url).toBe(forgejoPrUrl);
      expect(tunnels.length).toBeGreaterThanOrEqual(4);
      expect(tunnels.every((target) => target === 'git.invalid.ts.net:443')).toBe(true);
      expect(seenHosts.every((host) => host === 'git.invalid.ts.net')).toBe(true);
      expect(upstream.pushes).toHaveLength(1);
      expect(upstream.pushes[0].args).toContain(`http.proxy=${proxyUrl}`);
      expect(upstream.pushes[0].args).toContain(`http.sslCAInfo=${certPath}`);
    } finally {
      for (const s of activeSockets) s.destroy();
      forgejoServer.closeAllConnections();
      proxyServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => forgejoServer.close(() => resolve())),
        new Promise<void>((resolve) => proxyServer.close(() => resolve()))
      ]);
    }
  });
});
