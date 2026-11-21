import fs from 'node:fs';
import http from 'node:http';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposalAuth } from './proposalAuth.js';
import type { ProjectConfig } from '../shared/types.js';
import { createHubApp } from './app.js';
import { loadEnrollment } from './enrollment.js';
import { ProjectRegistry } from './projectRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, __dirname.includes(`${path.sep}dist${path.sep}`) ? '../../..' : '..');

function loadProjectsConfig(configPath: string): ProjectConfig[] {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projects: ProjectConfig[] };
  return raw.projects.map((p) => ({
    ...p,
    rootPath: path.resolve(path.dirname(configPath), '..', p.rootPath)
  }));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function prepareServeSocket(socketPath: string): Promise<number> {
  if (!path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 107) {
    throw new Error('FOCUSWIKI_HTTP_SOCKET must be a short, absolute Unix socket path.');
  }
  const uid = process.geteuid?.();
  const gid = process.getegid?.();
  const dirPath = path.dirname(socketPath);
  const dir = fs.lstatSync(dirPath);
  const dirMode = dir.mode & 0o7777;
  const allowedMode = dirMode === 0o700 || (dirMode === 0o750 && dir.gid === gid);
  if (!dir.isDirectory() || fs.realpathSync(dirPath) !== dirPath || dir.uid !== uid || !allowedMode) {
    throw new Error('FOCUSWIKI_HTTP_SOCKET requires a private 0700 or 0750 directory owned by the web process.');
  }
  const socketMode = dirMode === 0o750 ? 0o660 : 0o600;
  const existing = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!existing) return socketMode;
  if (!existing.isSocket() || existing.uid !== uid) throw new Error('Invalid existing Serve socket path.');

  // Compose runs a single web instance. Recover its stale socket after an unclean stop.
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(1000, () => socket.destroy(new Error('Timed out checking the existing Serve socket.')));
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('Another process is listening on FOCUSWIKI_HTTP_SOCKET.'));
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') resolve();
      else reject(err);
    });
  });
  const current = fs.lstatSync(socketPath);
  if (current.dev !== existing.dev || current.ino !== existing.ino) throw new Error('Serve socket changed during startup.');
  fs.unlinkSync(socketPath);
  return socketMode;
}

async function main(): Promise<void> {
  const localDev = process.argv.includes('--local-dev');
  if (localDev && process.env.NODE_ENV === 'production') {
    throw new Error('Local development mode is unavailable in production.');
  }
  const port = Number(process.env.PORT ?? 8088);
  if (localDev && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Invalid loopback development port.');
  }
  const socketPath = localDev ? undefined : requiredEnv('FOCUSWIKI_HTTP_SOCKET');
  const socketMode = socketPath ? await prepareServeSocket(socketPath) : undefined;
  const trustedConnections = new WeakSet<Socket>();

  const clientDistDir = process.env.CLIENT_DIST_DIR
    ? path.resolve(process.env.CLIENT_DIST_DIR)
    : path.join(ROOT_DIR, 'dist', 'client');

  const enrollmentFile = localDev ? undefined : requiredEnv('FOCUSWIKI_ENROLLMENT_FILE');
  const reposDir = process.env.FOCUSWIKI_REPOS_DIR;
  let registry: ProjectRegistry;
  if (enrollmentFile) {
    if (!reposDir) throw new Error('Set FOCUSWIKI_REPOS_DIR for managed enrollment.');
    registry = new ProjectRegistry([], { projects: loadEnrollment(enrollmentFile), reposDir });
  } else {
    // Static browse-only mode is also used by the fictional demo.
    const config = process.env.PROJECTS_CONFIG || path.join(ROOT_DIR, 'config', 'projects.default.json');
    registry = new ProjectRegistry(loadProjectsConfig(config));
  }
  const hub = createHubApp({
    registry,
    gitSocketPath: process.env.FOCUSWIKI_GIT_SOCKET,
    proposalAuth: enrollmentFile ? proposalAuth : undefined,
    clientDistDir,
    serveAccess: localDev ? undefined : {
      origin: requiredEnv('FOCUSWIKI_PUBLIC_ORIGIN'),
      publishers: process.env.FOCUSWIKI_PUBLISHERS?.trim()
        ? process.env.FOCUSWIKI_PUBLISHERS.split(',').map((login) => login.trim())
        : [],
      trustedConnections
    },
  });

  const server = http.createServer(hub.app);
  if (socketPath) server.prependListener('connection', (socket: Socket) => trustedConnections.add(socket));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const onListen = () => {
      server.off('error', reject);
      if (socketPath && socketMode !== undefined) {
        try {
          fs.chmodSync(socketPath, socketMode);
        } catch (err) {
          server.close(() => reject(err));
          return;
        }
      }
      console.log(`[focuswiki] Listening on ${socketPath ?? `http://127.0.0.1:${port} (local development)`}`);
      resolve();
    };
    if (socketPath) server.listen(socketPath, onListen);
    else server.listen(port, '127.0.0.1', onListen);
  });

  const shutdown = async (signal: string) => {
    console.log(`[focuswiki] Received ${signal}, shutting down...`);
    await hub.close();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[focuswiki] Startup failed:', err);
  process.exit(1);
});
