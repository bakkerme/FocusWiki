import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestHandler } from 'express';
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

async function loadProposalAuth(): Promise<RequestHandler | undefined> {
  try {
    const mod = await import(new URL('./proposalAuth.js', import.meta.url).href);
    if (typeof mod.proposalAuth === 'function') return mod.proposalAuth;
  } catch {
    // Missing or failed auth initialization leaves both proposal routes closed.
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8088);
  const host = process.env.FOCUSWIKI_BIND_HOST || '127.0.0.1';

  const clientDistDir = process.env.CLIENT_DIST_DIR
    ? path.resolve(process.env.CLIENT_DIST_DIR)
    : path.join(ROOT_DIR, 'dist', 'client');

  const enrollmentFile = process.env.FOCUSWIKI_ENROLLMENT_FILE;
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
    proposalAuth: enrollmentFile ? await loadProposalAuth() : undefined,
    clientDistDir
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
