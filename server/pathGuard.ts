import fs from 'node:fs';
import path from 'node:path';

export class PathBoundaryError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = 'PathBoundaryError';
    this.statusCode = statusCode;
  }
}

const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules', '.focuswiki', '.cairn']);
const FORBIDDEN_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /^id_(rsa|ed25519|ecdsa)(\.pub)?$/i
];

export function resolveSafeProjectPath(projectRoot: string, userRelativePath: string): {
  absolutePath: string;
  normalizedRelPath: string;
} {
  if (typeof userRelativePath !== 'string' || !userRelativePath.trim()) {
    throw new PathBoundaryError('Path is required.', 400);
  }
  if (userRelativePath.includes('\0') || userRelativePath.includes('\\')) {
    throw new PathBoundaryError('Invalid characters in path.', 400);
  }
  if (userRelativePath.split('/').some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new PathBoundaryError('Access to internal project directories is forbidden.');
  }
  if (path.isAbsolute(userRelativePath)) {
    throw new PathBoundaryError('Absolute paths are not permitted.', 403);
  }

  const realRoot = fs.realpathSync(projectRoot);
  const candidate = path.resolve(realRoot, userRelativePath);

  if (candidate !== realRoot && !candidate.startsWith(realRoot + path.sep)) {
    throw new PathBoundaryError('Path escapes registered project directory.', 403);
  }

  const normalizedRelPath = path.relative(realRoot, candidate).split(path.sep).join('/');
  if (!normalizedRelPath || normalizedRelPath.startsWith('..')) {
    throw new PathBoundaryError('Path escapes registered project directory.', 403);
  }

  const segments = normalizedRelPath.split('/');
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      throw new PathBoundaryError(`Access to protected directory "${seg}" is forbidden.`, 403);
    }
  }

  const baseName = segments[segments.length - 1];
  for (const pattern of FORBIDDEN_FILE_PATTERNS) {
    if (pattern.test(baseName)) {
      throw new PathBoundaryError(`Access to sensitive file "${baseName}" is forbidden.`, 403);
    }
  }

  // Walk every existing component, including dangling symlinks. Checking only
  // the final target would allow aliases into protected app metadata.
  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) break;
    let real: string;
    try { real = fs.realpathSync(current); }
    catch { throw new PathBoundaryError('Cannot safely resolve project symlink.'); }
    const relative = path.relative(realRoot, real);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
      throw new PathBoundaryError('Symlink target escapes registered project directory.');
    }
    const realSegments = relative.split(path.sep);
    if (realSegments.some((part) => FORBIDDEN_SEGMENTS.has(part)) ||
        FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(path.basename(real)))) {
      throw new PathBoundaryError('Symlink target exposes protected project files.');
    }
  }

  return {
    absolutePath: candidate,
    normalizedRelPath
  };
}

const ALLOWED_EMBED_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.json',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.woff',
  '.woff2',
  '.txt'
]);

export function resolveSafeEmbedAssetPath(projectRoot: string, userRelativePath: string): {
  absolutePath: string;
  normalizedRelPath: string;
} {
  const resolved = resolveSafeProjectPath(projectRoot, userRelativePath);
  const ext = path.extname(resolved.normalizedRelPath).toLowerCase();
  if (!ALLOWED_EMBED_EXTENSIONS.has(ext)) {
    throw new PathBoundaryError(`Unsupported embed asset extension "${ext || 'none'}".`, 403);
  }
  return resolved;
}

export function resolveInternalMetadataDir(projectRoot: string, internalRelDir: string): string {
  const realRoot = fs.realpathSync(projectRoot);
  const candidate = path.resolve(realRoot, internalRelDir);
  if (candidate === realRoot || !candidate.startsWith(realRoot + path.sep)) {
    throw new PathBoundaryError('Internal metadata directory escapes project root.', 403);
  }
  const segments = path.relative(realRoot, candidate).split(path.sep);
  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PathBoundaryError('Internal metadata path must be a real directory inside the project.', 403);
    }
    const real = fs.realpathSync(current);
    const rel = path.relative(realRoot, real);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
      throw new PathBoundaryError('Internal metadata target escapes project root.', 403);
    }
  }
  return candidate;
}

