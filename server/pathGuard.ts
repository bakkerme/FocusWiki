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

const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);
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

  // Verify symlink resolution on deepest existing ancestor so symlinks cannot escape realRoot
  let checkTarget = candidate;
  while (!fs.existsSync(checkTarget)) {
    const parent = path.dirname(checkTarget);
    if (parent === checkTarget) break;
    checkTarget = parent;
  }
  const realExisting = fs.realpathSync(checkTarget);
  if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) {
    throw new PathBoundaryError('Symlink target escapes registered project directory.', 403);
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
