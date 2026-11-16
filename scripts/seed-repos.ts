import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, __dirname.includes(`${path.sep}dist${path.sep}`) ? '../../..' : '..');
const SEEDS_ROOT = path.join(ROOT, 'seeds');
const TARGET_ROOT = process.env.SAMPLE_REPOS_DIR
  ? path.resolve(process.env.SAMPLE_REPOS_DIR)
  : path.join(ROOT, 'sample-repos');

function copyDirRecursive(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o770 });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      fs.chmodSync(destPath, 0o660);
    }
  }
}

function seedSingleRepo(repoName: string, forceReset: boolean): void {
  const seedSrc = path.join(SEEDS_ROOT, repoName);
  const repoDest = path.join(TARGET_ROOT, repoName);

  if (fs.existsSync(path.join(repoDest, '.git')) && !forceReset) {
    console.log(`[seed] Keeping existing Git repository at ${repoDest}`);
    return;
  }

  if (fs.existsSync(repoDest) && forceReset) {
    fs.rmSync(repoDest, { recursive: true, force: true });
  }

  copyDirRecursive(seedSrc, repoDest);

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDest, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Prototype Seeder'], { cwd: repoDest, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'seeder@local.invalid'], { cwd: repoDest, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: repoDest, stdio: 'pipe' });
  execFileSync(
    'git',
    ['commit', '-m', `Initialize fictional ${repoName} documentation repository`],
    { cwd: repoDest, stdio: 'pipe' }
  );
  console.log(`[seed] Initialized Git repository ${repoDest} on branch main`);
}

const forceReset = process.argv.includes('--reset');
fs.mkdirSync(TARGET_ROOT, { recursive: true, mode: 0o770 });
seedSingleRepo('cindervault-rpg', forceReset);
seedSingleRepo('helios-lab', forceReset);
