import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startGitRunner } from '../server/gitRunner.js';
import {
  bootstrapOpenBaoKey,
  normalizeAndValidateForgejoToken,
  normalizeAndValidateRsaPem,
  parseOpenBaoConfig,
  writeWorkerSecretFile
} from '../server/openbaoBootstrap.js';

function createSelfSignedCert(dir: string): { certPath: string; cert: Buffer; key: Buffer } {
  const keyPath = path.join(dir, 'server.key');
  const certPath = path.join(dir, 'server.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:openbao.invalid.ts.net'
  ], { stdio: 'ignore' });
  return {
    certPath,
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
}

describe('OpenBao AppRole bootstrap', () => {
  let certDir: string;
  let tlsCert: { certPath: string; cert: Buffer; key: Buffer };
  let rsaPem: string;
  let workDir: string;
  let secretsDir: string;
  let server: https.Server | undefined;
  let proxyServer: http.Server | undefined;

  beforeAll(() => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-openbao-cert-'));
    tlsCert = createSelfSignedCert(certDir);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    rsaPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  });

  afterAll(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-openbao-work-'));
    secretsDir = path.join(workDir, 'secrets');
    fs.mkdirSync(secretsDir, { mode: 0o700 });
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (proxyServer) {
      proxyServer.closeAllConnections();
      await new Promise<void>((resolve) => proxyServer!.close(() => resolve()));
      proxyServer = undefined;
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function startMockOpenBao(handler: http.RequestListener): Promise<string> {
    server = https.createServer({ cert: tlsCert.cert, key: tlsCert.key }, handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `https://127.0.0.1:${port}`;
  }

  async function startConnectProxy(
    resolveTarget?: (authority: string) => { host: string; port: number }
  ): Promise<{ url: string; tunnels: string[] }> {
    const tunnels: string[] = [];
    const activeSockets = new Set<{ destroy(): unknown }>();
    proxyServer = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxyServer.on('connect', (req, clientSocket, head) => {
      const authority = req.url ?? '';
      tunnels.push(authority);
      activeSockets.add(clientSocket);
      clientSocket.once('close', () => activeSockets.delete(clientSocket));
      const target = resolveTarget
        ? resolveTarget(authority)
        : (() => {
            const [host, portText] = authority.split(':');
            return { host, port: Number(portText) };
          })();
      const upstream = net.connect(target.port, target.host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      activeSockets.add(upstream);
      upstream.once('close', () => activeSockets.delete(upstream));
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    const origClose = proxyServer.close.bind(proxyServer);
    proxyServer.close = ((cb?: (err?: Error) => void) => {
      for (const s of activeSockets) s.destroy();
      return origClose(cb);
    }) as typeof proxyServer.close;
    await new Promise<void>((resolve) => proxyServer!.listen(0, '127.0.0.1', resolve));
    const { port } = proxyServer.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, tunnels };
  }

  it('authenticates via AppRole, reads KV v2 secret, revokes the client token, and writes 0600 PEM', async () => {
    const seen: { loginBody?: unknown; token?: string; namespace?: string; revoked: boolean } = { revoked: false };
    const addr = await startMockOpenBao((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/v1/auth/approle/login') {
          seen.loginBody = JSON.parse(raw);
          seen.namespace = req.headers['x-vault-namespace'] as string | undefined;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ auth: { client_token: 'hvs.fictional-short-lived-token' } }));
          return;
        }
        if (req.method === 'GET' && req.url === '/v1/secret/data/focuswiki/github-app') {
          seen.token = req.headers['x-vault-token'] as string | undefined;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { data: { private_key: rsaPem }, metadata: { version: 1 } } }));
          return;
        }
        if (req.method === 'POST' && req.url === '/v1/auth/token/revoke-self') {
          if (req.headers['x-vault-token'] === 'hvs.fictional-short-lived-token') seen.revoked = true;
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    const keyFile = path.join(secretsDir, 'focuswiki-github-app.pem');
    await bootstrapOpenBaoKey({
      FOCUSWIKI_OPENBAO_ADDR: addr,
      FOCUSWIKI_OPENBAO_ROLE_ID: 'fictional-role-id',
      FOCUSWIKI_OPENBAO_SECRET_ID: 'fictional-secret-id',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'secret/data/focuswiki/github-app',
      FOCUSWIKI_OPENBAO_NAMESPACE: 'fictional-ns',
      FOCUSWIKI_OPENBAO_CA_FILE: tlsCert.certPath,
      FOCUSWIKI_GITHUB_APP_KEY_FILE: keyFile
    });

    expect(seen.loginBody).toEqual({ role_id: 'fictional-role-id', secret_id: 'fictional-secret-id' });
    expect(seen.namespace).toBe('fictional-ns');
    expect(seen.token).toBe('hvs.fictional-short-lived-token');
    expect(seen.revoked).toBe(true);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(rsaPem);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('supports KV v1 responses, literal newline PEMs, *_FILE credentials, and HTTP CONNECT proxy tunneling', async () => {
    const addr = await startMockOpenBao((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/auth/custom-approle/login') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ auth: { client_token: 'hvs.fictional-proxy-token' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/kv1/focuswiki/app') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { pem: rsaPem.trim().replace(/\n/g, '\\n') } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/token/revoke-self') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const proxy = await startConnectProxy();
    const roleFile = path.join(secretsDir, 'role-id');
    const secretFile = path.join(secretsDir, 'secret-id');
    fs.writeFileSync(roleFile, 'fictional-file-role\n', { mode: 0o600 });
    fs.writeFileSync(secretFile, 'fictional-file-secret\n', { mode: 0o600 });

    const keyFile = path.join(secretsDir, 'focuswiki-github-app.pem');
    await bootstrapOpenBaoKey({
      FOCUSWIKI_OPENBAO_ADDR: addr,
      FOCUSWIKI_OPENBAO_ROLE_ID_FILE: roleFile,
      FOCUSWIKI_OPENBAO_SECRET_ID_FILE: secretFile,
      FOCUSWIKI_OPENBAO_AUTH_MOUNT: 'custom-approle',
      FOCUSWIKI_OPENBAO_SECRET_PATH: '/kv1/focuswiki/app',
      FOCUSWIKI_OPENBAO_SECRET_FIELD: 'pem',
      FOCUSWIKI_OPENBAO_CA_FILE: tlsCert.certPath,
      FOCUSWIKI_OPENBAO_PROXY: proxy.url,
      FOCUSWIKI_GITHUB_APP_KEY_FILE: keyFile
    });

    expect(proxy.tunnels.length).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(rsaPem);
  });

  it('tunnels unresolvable hostnames through FOCUSWIKI_OPENBAO_PROXY without local DNS lookup', async () => {
    const seenHosts: Array<string | undefined> = [];
    let revoked = false;
    const addr = await startMockOpenBao((req, res) => {
      seenHosts.push(req.headers.host);
      if (req.method === 'POST' && req.url === '/v1/auth/approle/login') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ auth: { client_token: 'hvs.fictional-magicdns-token' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/secret/data/focuswiki/github-app') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { data: { private_key: rsaPem } } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/token/revoke-self') {
        revoked = true;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const mockPort = Number(new URL(addr).port);
    const proxy = await startConnectProxy((authority) => {
      if (authority !== 'openbao.invalid.ts.net:443') {
        throw new Error(`Unexpected CONNECT target: ${authority}`);
      }
      return { host: '127.0.0.1', port: mockPort };
    });

    const keyFile = path.join(secretsDir, 'focuswiki-github-app.pem');
    await bootstrapOpenBaoKey({
      FOCUSWIKI_OPENBAO_ADDR: 'https://openbao.invalid.ts.net',
      FOCUSWIKI_OPENBAO_ROLE_ID: 'fictional-role',
      FOCUSWIKI_OPENBAO_SECRET_ID: 'fictional-secret',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'secret/data/focuswiki/github-app',
      FOCUSWIKI_OPENBAO_CA_FILE: tlsCert.certPath,
      FOCUSWIKI_OPENBAO_PROXY: proxy.url,
      FOCUSWIKI_GITHUB_APP_KEY_FILE: keyFile
    });

    expect(proxy.tunnels).toEqual([
      'openbao.invalid.ts.net:443',
      'openbao.invalid.ts.net:443',
      'openbao.invalid.ts.net:443'
    ]);
    expect(seenHosts).toEqual([
      'openbao.invalid.ts.net',
      'openbao.invalid.ts.net',
      'openbao.invalid.ts.net'
    ]);
    expect(revoked).toBe(true);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(rsaPem);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('retries transient 503 responses and fails fast on 403 or invalid key payloads', async () => {
    let attempts = 0;
    const addr = await startMockOpenBao((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/auth/approle/login') {
        attempts++;
        if (attempts === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errors: ['sealed'] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ auth: { client_token: 'hvs.retry-ok' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/secret/data/focuswiki/github-app') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { data: { private_key: rsaPem } } }));
        return;
      }
      res.writeHead(204);
      res.end();
    });

    const keyFile = path.join(secretsDir, 'focuswiki-github-app.pem');
    await bootstrapOpenBaoKey({
      FOCUSWIKI_OPENBAO_ADDR: addr,
      FOCUSWIKI_OPENBAO_ROLE_ID: 'r',
      FOCUSWIKI_OPENBAO_SECRET_ID: 's',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'secret/data/focuswiki/github-app',
      FOCUSWIKI_OPENBAO_CA_FILE: tlsCert.certPath,
      FOCUSWIKI_OPENBAO_RETRIES: '3',
      FOCUSWIKI_OPENBAO_RETRY_DELAY_MS: '10',
      FOCUSWIKI_GITHUB_APP_KEY_FILE: keyFile
    });
    expect(attempts).toBe(2);

    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    let deniedCalls = 0;
    const deniedAddr = await startMockOpenBao((_req, res) => {
      deniedCalls++;
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: ['permission denied'] }));
    });
    await expect(bootstrapOpenBaoKey({
      FOCUSWIKI_OPENBAO_ADDR: deniedAddr,
      FOCUSWIKI_OPENBAO_ROLE_ID: 'r',
      FOCUSWIKI_OPENBAO_SECRET_ID: 's',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'secret/data/focuswiki/github-app',
      FOCUSWIKI_OPENBAO_CA_FILE: tlsCert.certPath,
      FOCUSWIKI_OPENBAO_RETRIES: '3',
      FOCUSWIKI_OPENBAO_RETRY_DELAY_MS: '10',
      FOCUSWIKI_GITHUB_APP_KEY_FILE: keyFile
    })).rejects.toThrow('HTTP 403');
    expect(deniedCalls).toBe(1);
  });

  it('rejects insecure configuration, non-RSA keys, redirects, and unsafe secret file paths', async () => {
    expect(() => parseOpenBaoConfig({
      FOCUSWIKI_OPENBAO_ADDR: 'http://openbao.example.ts.net',
      FOCUSWIKI_OPENBAO_ROLE_ID: 'r',
      FOCUSWIKI_OPENBAO_SECRET_ID: 's',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'secret/data/focuswiki/github-app',
      FOCUSWIKI_GITHUB_APP_KEY_FILE: '/run/secrets/key.pem'
    })).toThrow('HTTPS URL');

    expect(() => parseOpenBaoConfig({
      FOCUSWIKI_OPENBAO_ADDR: 'https://openbao.example.ts.net',
      FOCUSWIKI_OPENBAO_ROLE_ID: 'r',
      FOCUSWIKI_OPENBAO_SECRET_ID: 's',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'v1/secret/data/focuswiki/github-app',
      FOCUSWIKI_GITHUB_APP_KEY_FILE: '/run/secrets/key.pem'
    })).toThrow('relative to /v1/');

    const { privateKey: ecKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => normalizeAndValidateRsaPem(ecKey.export({ type: 'pkcs8', format: 'pem' }).toString()))
      .toThrow('valid RSA private key');

    const looseDir = path.join(workDir, 'loose');
    fs.mkdirSync(looseDir, { mode: 0o755 });
    expect(() => writeWorkerSecretFile(path.join(looseDir, 'key.pem'), rsaPem)).toThrow('private 0700');

    const symlinkTarget = path.join(secretsDir, 'symlink.pem');
    fs.symlinkSync(path.join(workDir, 'outside.pem'), symlinkTarget);
    expect(() => writeWorkerSecretFile(symlinkTarget, rsaPem)).toThrow('unsafe');

    const redirectAddr = await startMockOpenBao((_req, res) => {
      res.writeHead(302, { Location: 'https://evil.example.test' });
      res.end();
    });
    await expect(bootstrapOpenBaoKey({
      FOCUSWIKI_OPENBAO_ADDR: redirectAddr,
      FOCUSWIKI_OPENBAO_ROLE_ID: 'r',
      FOCUSWIKI_OPENBAO_SECRET_ID: 's',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'secret/data/focuswiki/github-app',
      FOCUSWIKI_OPENBAO_CA_FILE: tlsCert.certPath,
      FOCUSWIKI_OPENBAO_RETRIES: '1',
      FOCUSWIKI_GITHUB_APP_KEY_FILE: path.join(secretsDir, 'key.pem')
    })).rejects.toThrow('unexpected redirect');
  });

  it('recovers a stale Git worker Unix socket after an unclean shutdown', async () => {
    const reposDir = path.join(workDir, 'repos');
    const stateDir = path.join(workDir, 'state');
    const socketDir = path.join(workDir, 'socket');
    for (const dir of [reposDir, stateDir, socketDir]) fs.mkdirSync(dir, { mode: 0o700 });
    const enrollmentFile = path.join(workDir, 'enrollment.json');
    fs.writeFileSync(enrollmentFile, JSON.stringify({ projects: [] }), { mode: 0o444 });
    const socketPath = path.join(socketDir, 'git.sock');

    // Create an orphaned Unix socket file by binding and abandoning a server without unlinking.
    const orphan = net.createServer();
    await new Promise<void>((resolve) => orphan.listen(socketPath, resolve));
    // Duplicate the socket inode link so closing the server leaves a stale socket behind.
    const staleCopy = path.join(socketDir, 'stale.sock');
    fs.linkSync(socketPath, staleCopy);
    await new Promise<void>((resolve) => orphan.close(() => resolve()));
    fs.renameSync(staleCopy, socketPath);

    const runner = await startGitRunner({ enrollmentFile, reposDir, stateDir, socketPath });
    try {
      await new Promise<void>((resolve, reject) => {
        const client = net.createConnection(socketPath);
        client.once('connect', () => { client.destroy(); resolve(); });
        client.once('error', reject);
      });
    } finally {
      await runner.close();
    }
  });

  it('loads both GitHub App PEM and Forgejo token in one AppRole session, and supports Forgejo-only bootstrap', async () => {
    let logins = 0;
    let revokes = 0;
    const addr = await startMockOpenBao((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/auth/approle/login') {
        logins++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ auth: { client_token: `hvs.combined-${logins}` } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/secret/data/apps/focuswiki/github-app') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { data: { private_key: rsaPem } } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/secret/data/apps/focuswiki/forgejo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { data: { token: 'fictional-forgejo-secret-token' } } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/token/revoke-self') {
        revokes++;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const keyFile = path.join(secretsDir, 'focuswiki-github-app.pem');
    const forgejoFile = path.join(secretsDir, 'focuswiki-forgejo.token');
    const both = await bootstrapOpenBaoKey({
      FOCUSWIKI_OPENBAO_ADDR: addr,
      FOCUSWIKI_OPENBAO_ROLE_ID: 'r',
      FOCUSWIKI_OPENBAO_SECRET_ID: 's',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'secret/data/apps/focuswiki/github-app',
      FOCUSWIKI_OPENBAO_FORGEJO_SECRET_PATH: 'secret/data/apps/focuswiki/forgejo',
      FOCUSWIKI_OPENBAO_CA_FILE: tlsCert.certPath,
      FOCUSWIKI_GITHUB_APP_KEY_FILE: keyFile,
      FOCUSWIKI_FORGEJO_TOKEN_FILE: forgejoFile
    });

    expect(both).toEqual({ githubAppLoaded: true, forgejoTokenLoaded: true });
    expect(logins).toBe(1);
    expect(revokes).toBe(1);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(rsaPem);
    expect(fs.readFileSync(forgejoFile, 'utf8')).toBe('fictional-forgejo-secret-token\n');
    expect(fs.statSync(forgejoFile).mode & 0o777).toBe(0o600);

    // Forgejo-only bootstrap works without GitHub App secret path or key file.
    const forgejoOnlyFile = path.join(secretsDir, 'forgejo-only.token');
    const only = await bootstrapOpenBaoKey({
      FOCUSWIKI_OPENBAO_ADDR: addr,
      FOCUSWIKI_OPENBAO_ROLE_ID: 'r',
      FOCUSWIKI_OPENBAO_SECRET_ID: 's',
      FOCUSWIKI_OPENBAO_FORGEJO_SECRET_PATH: 'secret/data/apps/focuswiki/forgejo',
      FOCUSWIKI_OPENBAO_CA_FILE: tlsCert.certPath,
      FOCUSWIKI_FORGEJO_TOKEN_FILE: forgejoOnlyFile
    });
    expect(only).toEqual({ githubAppLoaded: false, forgejoTokenLoaded: true });
    expect(logins).toBe(2);
    expect(revokes).toBe(2);
    expect(fs.readFileSync(forgejoOnlyFile, 'utf8')).toBe('fictional-forgejo-secret-token\n');

    expect(() => normalizeAndValidateForgejoToken('has whitespace')).toThrow('Forgejo token is invalid');
    expect(() => parseOpenBaoConfig({
      FOCUSWIKI_OPENBAO_ADDR: addr,
      FOCUSWIKI_OPENBAO_ROLE_ID: 'r',
      FOCUSWIKI_OPENBAO_SECRET_ID: 's',
      FOCUSWIKI_OPENBAO_SECRET_PATH: 'secret/data/apps/focuswiki/github-app',
      FOCUSWIKI_OPENBAO_FORGEJO_SECRET_PATH: 'secret/data/apps/focuswiki/forgejo',
      FOCUSWIKI_GITHUB_APP_KEY_FILE: keyFile,
      FOCUSWIKI_FORGEJO_TOKEN_FILE: keyFile
    })).toThrow('distinct paths');
  });
});
