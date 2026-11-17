import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

function newestMtime(filePath: string): number {
  const stat = fs.statSync(filePath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return fs.readdirSync(filePath).reduce(
    (newest, name) => Math.max(newest, newestMtime(path.join(filePath, name))),
    stat.mtimeMs
  );
}

// Vitest runs global setup once, before any workers can serve the client bundle.
export default function setupBuildClient(): void {
  if (process.env.FOCUSWIKI_SKIP_TEST_BUILD === '1') return;

  const clientIndex = path.join(PROJECT_ROOT, 'dist/client/index.html');
  const newestSource = Math.max(
    ...['src', 'shared', 'index.html', 'vite.config.ts'].map((name) =>
      newestMtime(path.join(PROJECT_ROOT, name))
    )
  );
  if (!fs.existsSync(clientIndex) || fs.statSync(clientIndex).mtimeMs < newestSource) {
    execFileSync('npm', ['run', 'build:client'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  }
}
