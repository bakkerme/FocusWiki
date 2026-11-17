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
    throw new Error(
      `Missing projects config at ${configPath}. Run "npm run seed" first to initialize sample repositories.`
    );
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projects: ProjectConfig[] };
  return raw.projects.map((p) => ({
    ...p,
    rootPath: path.isAbsolute(p.rootPath) ? p.rootPath : path.resolve(path.dirname(configPath), '..', p.rootPath)
  }));
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8088);
  // Default to private loopback + host Tailscale IP if available, never 0.0.0.0 on bare host unless explicitly set in container
  const rawBindHosts = process.env.BIND_HOSTS ?? '127.0.0.1,100.117.116.91';
  const requestedHosts = Array.from(
    new Set(
      rawBindHosts
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    )
  );

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
  const allowedImportRoots = rawAllowedImportRoots
    ? rawAllowedImportRoots
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [ROOT_DIR, managedReposDir, ...(fs.existsSync('/workspace') ? ['/workspace'] : [])];

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

  const servers: http.Server[] = [];
  for (const host of requestedHosts) {
    const srv = http.createServer(hub.app);
    await new Promise<void>((resolve, reject) => {
      srv.once('error', (err: NodeJS.ErrnoException) => {
        // If optional secondary interface (e.g. Tailscale inside isolated container) isn't present, skip cleanly if 127.0.0.1/0.0.0.0 succeeds
        if (err.code === 'EADDRNOTAVAIL' && requestedHosts.length > 1) {
          console.warn(`[focuswiki] Skipping unavailable interface ${host}:${port}`);
          resolve();
          return;
        }
        reject(err);
      });
      srv.listen(port, host, () => {
        servers.push(srv);
        console.log(`[focuswiki] Listening on http://${host}:${port}`);
        resolve();
      });
    });
  }

  if (servers.length === 0) {
    throw new Error(`Failed to bind any requested host (${requestedHosts.join(', ')}) on port ${port}.`);
  }

  const shutdown = async (signal: string) => {
    console.log(`[focuswiki] Received ${signal}, shutting down...`);
    await hub.close();
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          })
      )
    );
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[focuswiki] Startup failed:', err);
  process.exit(1);
});
