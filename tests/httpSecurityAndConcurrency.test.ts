import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubApp, type HubAppInstance } from '../server/app.js';
import { validateHost } from '../server/httpSecurity.js';
import { withKeyLock, writeFileAtomicSync } from '../server/fileLock.js';

describe('LAN HTTP security, safe assets, and concurrent writes', () => {
  let root: string;
  let repo: string;
  let hub: HubAppInstance;
  const docUrl = '/api/projects/fixture/doc?path=README.md';
  const commentsUrl = '/api/projects/fixture/comments';

  function makeHub(extra: Partial<Parameters<typeof createHubApp>[0]> = {}): HubAppInstance {
    return createHubApp({
      projects: [{ id: 'fixture', name: 'Fictional Observatory', description: 'Test fixture', rootPath: repo, defaultDoc: 'README.md' }],
      enableWatcher: false,
      ...extra
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-security-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'images'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'embeds'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Fictional Observatory\n\nMeasure the amber comet.\n');
    fs.writeFileSync(path.join(repo, 'images/comet.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    fs.writeFileSync(path.join(repo, 'images/orbit.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(repo, 'embeds/index.html'), '<!doctype html><p>Fictional orbit</p>');
    hub = makeHub();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'http://wiki.local:8088', 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'http://wiki.local:8089' },
    { Origin: 'http://wiki.local:8088/path' }
  ])('rejects untrusted browser mutations before writing: %j', async (headers) => {
    const response = await request(hub.app).post('/api/projects/fixture/docs')
      .set('Host', 'wiki.local:8088').set(headers)
      .send({ path: 'blocked.md', markdown: '# Blocked' }).expect(403);
    expect(response.body.error).toBe('csrf_blocked');
    expect(fs.existsSync(path.join(repo, 'blocked.md'))).toBe(false);
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)('protects every mutating API method: %s', async (method) => {
    await request(hub.app)[method]('/api/projects/fixture').set('Origin', 'null').send({}).expect(403);
  });

  it('also protects Express case-insensitive API route matches', async () => {
    await request(hub.app).post('/API/PROJECTS/fixture/DOCS').set('Origin', 'null')
      .send({ path: 'blocked-case.md' }).expect(403);
    expect(fs.existsSync(path.join(repo, 'blocked-case.md'))).toBe(false);
  });

  it('allows matching browser origins, header-free CLI writes, and read-only cross-origin requests', async () => {
    await request(hub.app).post('/api/projects/fixture/docs').set('Host', 'wiki.local:8088')
      .set('Origin', 'http://wiki.local:8088').set('Sec-Fetch-Site', 'same-origin')
      .send({ path: 'browser.md', markdown: '# Browser' }).expect(201);
    await request(hub.app).post('/api/projects/fixture/docs')
      .send({ path: 'cli.md', markdown: '# CLI' }).expect(201);
    const response = await request(hub.app).get(docUrl).set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site').expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('same-origin');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it.each(['evil.example.com', '127.0.0.1:8088; script-src evil', 'wiki.local/path', 'wiki local', 'wiki.local:99999', '[:::]', '-bad.local'])('rejects malicious or invalid Hosts: %s', async (host) => {
    const response = await request(hub.app).get('/embed-sandbox/fixture/embeds/index.html').set('Host', host);
    expect([400, 403]).toContain(response.status);
    expect(response.headers['content-security-policy'] ?? '').not.toContain('script-src evil');
  });

  it.each(['localhost', '127.0.0.1:8088', '192.168.40.5', '[::1]:8088', '[2001:db8::1]', 'aio', 'wiki.local', 'wiki.lan', 'wiki.internal', 'wiki.home.arpa', 'wiki.tailnet.ts.net'])('allows zero-config LAN Hosts: %s', async (host) => {
    await request(hub.app).get('/api/health').set('Host', host).expect(200, { ok: true });
  });

  it('strictly rejects control characters and unsupported authority syntax', () => {
    for (const host of [undefined, '', 'wiki\n.local', 'wiki\n', 'wiki\r', 'wiki\u2028', 'wiki\r.local', 'wiki\t.local', 'wiki\0.local', 'wiki:abc', 'wiki@evil', 'wiki\\evil']) {
      expect(validateHost(host)).toBeNull();
    }
  });

  it('permits explicitly configured public hosts and origins', async () => {
    await hub.close();
    hub = makeHub({ allowedHosts: ['docs.example.com'] });
    await request(hub.app).get('/api/health').set('Host', 'docs.example.com:8088').expect(200);
    await request(hub.app).post('/api/projects/fixture/docs').set('Host', 'wiki.local:8088')
      .set('Origin', 'https://docs.example.com').send({ path: 'proxy.md' }).expect(201);
  });

  it('uses an explicit validated sandbox asset prefix for the opaque iframe origin', async () => {
    const response = await request(hub.app).get('/embed-sandbox/fixture/embeds/index.html')
      .set('Host', 'wiki.local:8088').set('X-Forwarded-Proto', 'https; script-src evil').expect(200);
    expect(response.headers['content-security-policy']).toContain('http://wiki.local:8088/embed-sandbox/fixture/');
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.headers['x-frame-options']).toBeUndefined();
  });

  it('adds a compatible SPA CSP and baseline security headers to HTML', async () => {
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    await hub.close();
    hub = makeHub({ clientDistDir: dist });
    const response = await request(hub.app).get('/reading').expect(200);
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
    expect(response.headers['content-security-policy']).toContain("frame-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('bounds expensive API calls per peer and returns Retry-After without throttling health reads', async () => {
    await hub.close();
    hub = makeHub({ rateLimit: { maxRequests: 2, windowMs: 60000 } });
    await request(hub.app).post('/api/projects/import').send({ mode: 'invalid' }).expect(400);
    await request(hub.app).post('/api/projects/missing/git/fetch').send({}).expect(404);
    const response = await request(hub.app).post('/api/projects/missing/git/pull')
      .set('X-Forwarded-For', '203.0.113.90').send({}).expect(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    await request(hub.app).get('/api/health').expect(200);
  });

  it('preserves every concurrent comment thread, reply, and status history entry', async () => {
    const threads = await Promise.all(Array.from({ length: 25 }, (_, i) => request(hub.app)
      .post(commentsUrl).send({ path: 'README.md', quote: 'amber comet', body: `Thread ${i}` }).expect(201)));
    const targetId = threads[0].body.thread.id;
    await Promise.all(Array.from({ length: 100 }, (_, i) => request(hub.app)
      .post(`${commentsUrl}/${targetId}/replies`).send({ path: 'README.md', body: `Reply ${i}` }).expect(200)));
    await Promise.all(threads.map((thread) => request(hub.app)
      .post(`${commentsUrl}/${thread.body.thread.id}/status`).send({ path: 'README.md', status: 'resolved' }).expect(200)));
    const response = await request(hub.app).get(`${commentsUrl}?path=README.md`).expect(200);
    expect(response.body.threads).toHaveLength(25);
    const target = response.body.threads.find((thread: { id: string }) => thread.id === targetId);
    expect(target.messages).toHaveLength(101);
    expect(new Set(target.messages.slice(1).map((message: { body: string }) => message.body)).size).toBe(100);
    expect(target.history).toHaveLength(102);
    expect(response.body.threads.every((thread: { status: string }) => thread.status === 'resolved')).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(path.join(repo, 'README.comments.json'), 'utf8'));
    expect(persisted.threads).toHaveLength(25);
    expect(fs.readdirSync(repo).some((file) => file.includes('.tmp-'))).toBe(false);
  });

  it('returns 404 for unknown threads in reply and status mutations', async () => {
    for (const [suffix, body] of [['replies', { body: 'Lost reply' }], ['status', { status: 'resolved' }]] as const) {
      const response = await request(hub.app).post(`${commentsUrl}/missing/${suffix}`)
        .send({ path: 'README.md', ...body }).expect(404);
      expect(response.body.error).toBe('not_found');
    }
  });

  it('serializes stale document saves and preserves every conflicting draft atomically', async () => {
    const initial = await request(hub.app).get(docUrl).expect(200);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => request(hub.app)
      .put('/api/projects/fixture/doc').send({ path: 'README.md', baseRevision: initial.body.revision, markdown: `# Draft ${i}\n` })));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(conflicts).toHaveLength(11);
    expect(new Set(conflicts.map((response) => response.body.savedConflictCopyPath)).size).toBe(11);
    for (const response of conflicts) {
      expect(fs.readFileSync(path.join(repo, response.body.savedConflictCopyPath), 'utf8')).toBe(response.body.yourMarkdown);
    }
  });

  it('prevents conflict recovery writes through an escaping metadata symlink', async () => {
    const initial = await request(hub.app).get(docUrl).expect(200);
    const outside = path.join(root, 'outside-recovery');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, '.focuswiki'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# External version\n');
    await request(hub.app).put('/api/projects/fixture/doc')
      .send({ path: 'README.md', baseRevision: initial.body.revision, markdown: '# Stale version\n' }).expect(403);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('serves image assets with short private caching and isolates SVG scripting', async () => {
    const png = await request(hub.app).get('/api/projects/fixture/assets/images/comet.png').expect(200);
    expect(png.headers['content-type']).toMatch(/^image\/png/);
    expect(png.headers['cache-control']).toBe('private, max-age=60');
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    const svg = await request(hub.app).get('/api/projects/fixture/assets/images/orbit.svg').expect(200);
    expect(svg.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  });

  it.each(['', '%2e%2e%2foutside.png', 'images/%2e%2e%2fcomet.png', '.git/config', '.focuswiki/private.png', '.cairn/private.png', 'README.comments.json', 'embeds/index.html', 'README.md', 'images/nul%00.png'])('rejects unsafe asset paths: %s', async (asset) => {
    const response = await request(hub.app).get(`/api/projects/fixture/assets/${asset}`);
    expect([400, 403]).toContain(response.status);
  });

  it('blocks symlink escapes and aliases into private project metadata', async () => {
    fs.writeFileSync(path.join(root, 'outside.png'), 'secret');
    fs.symlinkSync(path.join(root, 'outside.png'), path.join(repo, 'images/escape.png'));
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git/private.png'), 'secret');
    fs.symlinkSync(path.join(repo, '.git/private.png'), path.join(repo, 'images/alias.png'));
    await request(hub.app).get('/api/projects/fixture/assets/images/escape.png').expect(403);
    await request(hub.app).get('/api/projects/fixture/assets/images/alias.png').expect(403);
  });

  it('skips oversized search documents and caps matches across the whole request', async () => {
    fs.writeFileSync(path.join(repo, 'huge.md'), `# oversizedneedle\n${'x'.repeat(2 * 1024 * 1024)}`);
    const skipped = await request(hub.app).get('/api/search?q=oversizedneedle').expect(200);
    expect(skipped.body.results).toEqual([]);
    fs.writeFileSync(path.join(repo, 'matches.md'), Array.from({ length: 100 }, () => 'cometmatch').join('\n'));
    const matches = await request(hub.app).get('/api/search?q=cometmatch').expect(200);
    expect(matches.body.results).toHaveLength(60);
  });

  it('returns safe JSON and logs unexpected internal errors with stack traces', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(hub.registry, 'list').mockImplementation(() => { throw new Error('private internal detail'); });
    const response = await request(hub.app).get('/api/projects').expect(500);
    expect(response.body).toEqual({ error: 'server_error', message: 'Unexpected server error.' });
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Error: private internal detail\n'));
  });

  it('queues async same-key operations, permits independent keys, and recovers after rejection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const first = withKeyLock('a', async () => { events.push('first'); await gate; throw new Error('expected'); });
    const rejected = expect(first).rejects.toThrow('expected');
    const second = withKeyLock('a', () => { events.push('second'); });
    await withKeyLock('b', () => { events.push('independent'); });
    expect(events).toEqual(['first', 'independent']);
    release();
    await rejected;
    await second;
    expect(events).toEqual(['first', 'independent', 'second']);
  });

  it('atomically replaces full files and cleans temporary siblings after rename failure', () => {
    const file = path.join(repo, 'atomic.txt');
    writeFileAtomicSync(file, 'first', 0o600);
    writeFileAtomicSync(file, Buffer.from('second'));
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => writeFileAtomicSync(path.join(repo, 'images'), 'cannot replace directory')).toThrow();
    expect(fs.readdirSync(repo).some((name) => name.includes('.tmp-'))).toBe(false);
  });
});
