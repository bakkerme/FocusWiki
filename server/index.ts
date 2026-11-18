import fs from 'node:fs';
import http from 'node:http';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../shared/types.js';
import { createHubApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, __dirname.includes(`${path.sep}dist${path.sep}`) ? '../../..' : '..');

function resolveConfigPath(): string {
  return process.env.PROJECTS_CONFIG
    ? path.resolve(process.env.PROJECTS_CONFIG)
    : path.join(ROOT_DIR, 'config', 'projects.json');
}

function loadProjectsConfig(configPath: string): ProjectConfig[] {
  if (!fs.existsSync(configPath)) {
    const defaultTemplatePath = path.join(path.dirname(configPath), 'projects.default.json');
    if (fs.existsSync(defaultTemplatePath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o770 });
      fs.copyFileSync(defaultTemplatePath, configPath);
      fs.chmodSync(configPath, 0o660);
    } else {
      throw new Error(
        `Missing projects config at ${configPath}. Run "npm run seed" first to initialize sample repositories.`
      );
    }
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projects: ProjectConfig[] };
  return raw.projects.map((p) => ({
    ...p,
    rootPath: path.isAbsolute(p.rootPath) ? p.rootPath : path.resolve(path.dirname(configPath), '..', p.rootPath)
  }));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function loadEnrollment(filename: string, reposDir: string): ProjectConfig[] {
  const enrollment = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(enrollment?.projects)) {
    throw new Error('FOCUSWIKI_ENROLLMENT_FILE must contain a projects array.');
  }

  const ids = new Set<string>();
  return enrollment.projects.map((project: Record<string, unknown> | null) => {
    if (!project || typeof project.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(project.id) ||
        ids.has(project.id) || typeof project.name !== 'string' || !project.name.trim() ||
        typeof project.remote !== 'string' || !project.remote.trim() ||
        typeof project.branch !== 'string' || !project.branch.trim() ||
        (project.defaultDoc !== undefined && (typeof project.defaultDoc !== 'string' || !project.defaultDoc.trim()))) {
      throw new Error('Invalid or duplicate project in FOCUSWIKI_ENROLLMENT_FILE.');
    }
    ids.add(project.id);
    const rootPath = path.join(reposDir, project.id);
    const root = fs.lstatSync(rootPath, { throwIfNoEntry: false });
    if (root && !root.isDirectory()) throw new Error(`Invalid editable directory for ${project.id}.`);
    return { id: project.id, name: project.name, description: '', rootPath, defaultDoc: project.defaultDoc ?? 'README.md' };
  });
}

async function prepareServeSocket(socketPath: string): Promise<void> {
  if (!path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 107) {
    throw new Error('FOCUSWIKI_HTTP_SOCKET must be a short, absolute Unix socket path.');
  }
  const uid = process.geteuid?.();
  const dir = fs.lstatSync(path.dirname(socketPath));
  if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o777) !== 0o700) {
    throw new Error('FOCUSWIKI_HTTP_SOCKET requires a private 0700 directory owned by the web process.');
  }
  const existing = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!existing) return;
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
  if (socketPath) await prepareServeSocket(socketPath);
  const trustedConnections = new WeakSet<Socket>();

  const clientDistDir = process.env.CLIENT_DIST_DIR
    ? path.resolve(process.env.CLIENT_DIST_DIR)
    : path.join(ROOT_DIR, 'dist', 'client');

  const configPath = localDev ? resolveConfigPath() : undefined;
  const rawCredPath = process.env.CAIRN_CREDENTIALS_FILE ?? process.env.FOCUSWIKI_CREDENTIALS_FILE;
  const credentialsPath = rawCredPath && localDev
    ? path.resolve(rawCredPath)
    : undefined;
  const rawReposDir = process.env.FOCUSWIKI_REPOS_DIR ?? process.env.CAIRN_REPOS_DIR;
  const managedReposDir = localDev
    ? path.resolve(rawReposDir ?? path.join(ROOT_DIR, 'repos'))
    : fs.realpathSync(requiredEnv('FOCUSWIKI_REPOS_DIR'));
  const rawAllowedImportRoots =
    process.env.FOCUSWIKI_ALLOWED_IMPORT_ROOTS ?? process.env.CAIRN_ALLOWED_IMPORT_ROOTS;
  const allowedImportRoots = localDev && rawAllowedImportRoots !== undefined
    ? rawAllowedImportRoots
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [managedReposDir];

  const projects = configPath
    ? loadProjectsConfig(configPath)
    : loadEnrollment(requiredEnv('FOCUSWIKI_ENROLLMENT_FILE'), managedReposDir);
  const hub = createHubApp({
    projects,
    configPath,
    credentialsPath,
    managedReposDir,
    allowedImportRoots,
    clientDistDir,
    serveAccess: localDev ? undefined : {
      origin: requiredEnv('FOCUSWIKI_PUBLIC_ORIGIN'),
      publishers: process.env.FOCUSWIKI_PUBLISHERS?.trim()
        ? process.env.FOCUSWIKI_PUBLISHERS.split(',').map((login) => login.trim())
        : [],
      trustedConnections
    },
    enableWatcher: true
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
