import fs from 'node:fs';
import http from 'node:http';
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

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8088);
  const host = process.env.FOCUSWIKI_BIND_HOST || '127.0.0.1';

  const clientDistDir = process.env.CLIENT_DIST_DIR
    ? path.resolve(process.env.CLIENT_DIST_DIR)
    : path.join(ROOT_DIR, 'dist', 'client');

  const configPath = resolveConfigPath();
  const rawCredPath = process.env.CAIRN_CREDENTIALS_FILE ?? process.env.FOCUSWIKI_CREDENTIALS_FILE;
  const credentialsPath = rawCredPath
    ? path.resolve(rawCredPath)
    : path.join(path.dirname(configPath), '.git-credentials.enc.json');
  const rawReposDir = process.env.FOCUSWIKI_REPOS_DIR ?? process.env.CAIRN_REPOS_DIR;
  const managedReposDir = rawReposDir
    ? path.resolve(rawReposDir)
    : path.join(ROOT_DIR, 'repos');
  const rawAllowedImportRoots =
    process.env.FOCUSWIKI_ALLOWED_IMPORT_ROOTS ?? process.env.CAIRN_ALLOWED_IMPORT_ROOTS;
  const allowedImportRoots = rawAllowedImportRoots !== undefined
    ? rawAllowedImportRoots
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [managedReposDir];

  const projects = loadProjectsConfig(configPath);
  const hub = createHubApp({
    projects,
    configPath,
    credentialsPath,
    managedReposDir,
    allowedImportRoots,
    clientDistDir,
    enableWatcher: true
  });

  const server = http.createServer(hub.app);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      console.log(`[focuswiki] Listening on http://${host.includes(':') ? `[${host}]` : host}:${port}`);
      resolve();
    });
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
