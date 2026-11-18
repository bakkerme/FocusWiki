import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHubApp } from '../server/app.js';

const origin = 'https://wiki.example.ts.net';
const publisher = 'publisher@example.test';
const reader = 'editor@example.test';
const upstream = { Host: 'localhost', 'X-Forwarded-Host': 'wiki.example.ts.net', 'X-Forwarded-Proto': 'https' };

function send(
  address: string | number,
  path: string,
  { method = 'GET', headers = {} }: { method?: string; headers?: http.OutgoingHttpHeaders } = {}
) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const destination = typeof address === 'number' ? { host: '127.0.0.1', port: address } : { socketPath: address };
    const request = http.request({ ...destination, path, method, headers: { ...upstream, ...headers } }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      res.on('error', reject);
    });
    request.setTimeout(2000, () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
    request.end();
  });
}

describe('Tailscale Serve access', () => {
  let root: string;
  let socketPath: string;
  let serve: http.Server;
  let tcp: http.Server;
  let reviewActor: unknown;
  let publishActor: unknown;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-access-'));
    const client = path.join(root, 'client');
    const project = path.join(root, 'project');
    fs.mkdirSync(client);
    fs.mkdirSync(path.join(project, 'embeds', 'clock'), { recursive: true });
    fs.writeFileSync(path.join(client, 'index.html'), '<p>Fictional wiki</p>');
    fs.writeFileSync(path.join(client, 'asset.js'), '/* client */');
    fs.writeFileSync(path.join(project, 'README.md'), '# Fictional project\n');
    fs.writeFileSync(path.join(project, 'embeds/clock/index.html'), '<p>Fictional embed</p>');

    socketPath = path.join(root, 'serve.sock');
    const trustedConnections = new WeakSet<Socket>();
    const hub = createHubApp({
      projects: [{ id: 'fictional', rootPath: project, name: 'Fictional', description: '', defaultDoc: 'README.md' }],
      clientDistDir: client,
      enableWatcher: false,
      serveAccess: { origin, publishers: [publisher], trustedConnections }
    });
    serve = http.createServer(hub.app);
    serve.prependListener('connection', (socket: Socket) => trustedConnections.add(socket));
    serve.prependListener('request', (req, res) => {
      if (req.url === '/api/projects/fictional/git/diff') {
        res.once('finish', () => { reviewActor = (res as Response).locals.proposalActor; });
      }
      if (req.url?.toLowerCase() === '/api/projects/fictional/git/propose/?review=1') {
        res.once('finish', () => { publishActor = (res as Response).locals.proposalActor; });
      }
    });
    tcp = http.createServer(hub.app);
    await Promise.all([
      new Promise<void>((resolve) => serve.listen(socketPath, resolve)),
      new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
    ]);
  });

  afterAll(async () => {
    await Promise.all([serve, tcp].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['/', '/nested/spa', '/asset.js', '/api/projects', '/api/projects/fictional/git/diff', '/api/events', '/embed-sandbox/fictional/embeds/clock/index.html', '/healthz', '/api/health'])('requires identity on %s', async (route) => {
    expect(await send(socketPath, route)).toMatchObject({ status: 401, body: '{"error":"identity_required"}' });
    expect(await send((tcp.address() as AddressInfo).port, route, {
      headers: { 'Tailscale-User-Login': publisher, 'X-Forwarded-For': '100.64.0.1' }
    })).toMatchObject({ status: 403, body: '{"error":"untrusted_proxy"}' });
  });

  it('serves a verified editor, including minimal health and embed resources at the HTTPS origin', async () => {
    const headers = { 'Tailscale-User-Login': reader };
    expect(await send(socketPath, '/', { headers })).toMatchObject({ status: 200, body: '<p>Fictional wiki</p>' });
    expect(await send(socketPath, '/asset.js', { headers })).toMatchObject({ status: 200 });
    expect(await send(socketPath, '/api/projects', { headers })).toMatchObject({ status: 200 });
    expect(await send(socketPath, '/healthz', { headers })).toMatchObject({ status: 200, body: '{"ok":true}' });
    const navigation = await send(socketPath, '/embed-sandbox/fictional/embeds/clock/index.html', { headers });
    expect(navigation.status).toBe(302);
    expect(navigation.headers.location).toMatch(/^\/embed-sandbox\/fictional\/_assets\//);
    const embed = await send(socketPath, navigation.headers.location!, { headers });
    expect(embed.status).toBe(200);
    expect(embed.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(embed.headers['content-security-policy']).toContain(`${origin}/embed-sandbox/fictional/`);
  });

  it.each([
    { 'Tailscale-User-Login': [publisher, publisher] },
    { 'Tailscale-User-Login': `${publisher}, ${reader}` },
    { 'Tailscale-User-Login': 'unknown' },
    { 'Tailscale-User-Login': publisher, 'Tailscale-Funnel-Request': '?1' },
    { 'Tailscale-User-Name': publisher }
  ])('rejects invalid or non-Serve identity headers', async (headers) => {
    expect(await send(socketPath, '/api/projects', { headers })).toMatchObject({ status: 401 });
  });

  it.each([
    { 'X-Forwarded-Host': 'other.example.ts.net' },
    { 'X-Forwarded-Host': ['wiki.example.ts.net', 'wiki.example.ts.net'] },
    { 'X-Forwarded-Proto': 'http' },
    { 'X-Forwarded-Proto': ['https', 'https'] }
  ])('requires a single Serve authority and HTTPS scheme', async (forwarding) => {
    expect(await send(socketPath, '/', { headers: { ...forwarding, 'Tailscale-User-Login': publisher } }))
      .toMatchObject({ status: 403, body: '{"error":"origin_blocked"}' });
  });

  it.each([
    {}, { Origin: 'null' }, { Origin: 'http://wiki.example.ts.net' },
    { Origin: 'https://wiki.example.ts.net:8443' }, { Origin: 'https://sibling.example.ts.net' },
    { Origin: [origin, origin] }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
    { Origin: origin, 'Sec-Fetch-Site': 'same-site' }
  ])('requires an exact browser origin on proposal POSTs', async (browser) => {
    expect(await send(socketPath, '/api/projects/fictional/git/propose', {
      method: 'POST', headers: { ...browser, 'Tailscale-User-Login': publisher }
    })).toMatchObject({ status: 403, body: '{"error":"csrf_blocked"}' });
  });

  it('checks the exact publisher on the Express route, even with case, slash and query variations', async () => {
    const route = '/API/PROJECTS/fictional/GIT/PROPOSE/?review=1';
    for (const login of [reader, publisher.toUpperCase()]) {
      expect(await send(socketPath, route, { method: 'POST', headers: { Origin: origin, 'Tailscale-User-Login': login } }))
        .toMatchObject({ status: 403, body: '{"error":"publisher_required"}' });
      expect(publishActor).toBeUndefined();
    }
    await send(socketPath, route, {
      method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Tailscale-User-Login': publisher, 'X-Proposal-Actor': reader }
    });
    expect(publishActor).toBe(publisher);
    expect(await send((tcp.address() as AddressInfo).port, route, {
      method: 'POST', headers: { Origin: origin, 'Tailscale-User-Login': publisher }
    })).toMatchObject({ status: 403, body: '{"error":"untrusted_proxy"}' });
  });

  it('sets the verified actor for review without requiring publish permission', async () => {
    await send(socketPath, '/api/projects/fictional/git/diff', {
      headers: { 'Tailscale-User-Login': reader, 'X-Proposal-Actor': publisher }
    });
    expect(reviewActor).toBe(reader);
  });

  it('requires same origin for other writes without making editing publisher-only', async () => {
    const route = '/api/projects/fictional/doc';
    expect(await send(socketPath, route, { method: 'PUT', headers: { 'Tailscale-User-Login': reader } }))
      .toMatchObject({ status: 403, body: '{"error":"csrf_blocked"}' });
    // A same-origin request reaches the existing route's body validation.
    expect((await send(socketPath, route, { method: 'PUT', headers: { Origin: origin, 'Tailscale-User-Login': reader } })).status)
      .toBe(400);
  });
});
