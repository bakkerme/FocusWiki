import { createPrivateKey, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const MAX_CREDENTIAL_FILE_BYTES = 4 * 1024;
const MAX_CA_FILE_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 5_000;

export interface OpenBaoConfig {
  addr: URL;
  basePath: string;
  roleId: string;
  secretId: string;
  authMount: string;
  secretPath: string;
  secretField: string;
  namespace?: string;
  ca?: Buffer;
  proxy?: URL;
  keyFile: string;
  retries: number;
  retryDelayMs: number;
}

export class OpenBaoBootstrapError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'OpenBaoBootstrapError';
  }
}

function readBoundedFile(filePath: string, maxBytes: number, label: string): Buffer {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new OpenBaoBootstrapError(`${label} must be a normalized absolute path.`);
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    throw new OpenBaoBootstrapError(`${label} could not be opened.`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
      throw new OpenBaoBootstrapError(`${label} must be a regular non-empty file within size limits.`);
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) return buffer.subarray(0, length);
      length += count;
    }
    throw new OpenBaoBootstrapError(`${label} exceeded the maximum allowed size.`);
  } finally {
    fs.closeSync(fd);
  }
}

function readCredential(env: NodeJS.ProcessEnv, valueVar: string, fileVar: string): string {
  const rawValue = env[valueVar]?.trim() ?? '';
  const rawFile = env[fileVar]?.trim() ?? '';
  if (rawValue && rawFile) {
    throw new OpenBaoBootstrapError(`Set only one of ${valueVar} or ${fileVar}.`);
  }
  const value = rawFile
    ? readBoundedFile(rawFile, MAX_CREDENTIAL_FILE_BYTES, fileVar).toString('utf8').trim()
    : rawValue;
  if (!value || Buffer.byteLength(value, 'utf8') > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new OpenBaoBootstrapError(`${valueVar} is missing or invalid.`);
  }
  return value;
}

function normalizeRelativeApiPath(raw: string, varName: string, maxLen: number): string {
  const trimmed = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed || trimmed.length > maxLen || /[?#\\\x00-\x1f\x7f]/.test(trimmed)) {
    throw new OpenBaoBootstrapError(`${varName} is invalid.`);
  }
  const segments = trimmed.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new OpenBaoBootstrapError(`${varName} must not contain empty or traversal path segments.`);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number, varName: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) throw new OpenBaoBootstrapError(`${varName} must be an integer.`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new OpenBaoBootstrapError(`${varName} must be between ${min} and ${max}.`);
  }
  return parsed;
}

export function parseOpenBaoConfig(env: NodeJS.ProcessEnv = process.env): OpenBaoConfig {
  const rawAddr = env.FOCUSWIKI_OPENBAO_ADDR?.trim();
  if (!rawAddr) throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_ADDR is required.');
  let addr: URL;
  try {
    addr = new URL(rawAddr);
  } catch {
    throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_ADDR must be a valid HTTPS URL.');
  }
  if (addr.protocol !== 'https:' || addr.username || addr.password || addr.search || addr.hash || !addr.hostname) {
    throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_ADDR must be an HTTPS URL without credentials, query, or fragment.');
  }
  const basePath = addr.pathname.replace(/\/+$/, '');
  if (basePath && (basePath.includes('//') || basePath.split('/').some((seg) => seg === '.' || seg === '..'))) {
    throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_ADDR contains an invalid base path.');
  }

  const roleId = readCredential(env, 'FOCUSWIKI_OPENBAO_ROLE_ID', 'FOCUSWIKI_OPENBAO_ROLE_ID_FILE');
  const secretId = readCredential(env, 'FOCUSWIKI_OPENBAO_SECRET_ID', 'FOCUSWIKI_OPENBAO_SECRET_ID_FILE');

  const rawMount = env.FOCUSWIKI_OPENBAO_AUTH_MOUNT?.trim() || 'approle';
  const authMount = normalizeRelativeApiPath(rawMount, 'FOCUSWIKI_OPENBAO_AUTH_MOUNT', 128);

  const rawSecretPath = env.FOCUSWIKI_OPENBAO_SECRET_PATH?.trim() ?? '';
  if (!rawSecretPath) throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_SECRET_PATH is required.');
  const strippedSecretPath = rawSecretPath.replace(/^\/+/, '');
  if (strippedSecretPath.startsWith('v1/')) {
    throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_SECRET_PATH must be relative to /v1/ (for example, secret/data/focuswiki/github-app).');
  }
  const secretPath = normalizeRelativeApiPath(strippedSecretPath, 'FOCUSWIKI_OPENBAO_SECRET_PATH', 512);

  const secretField = env.FOCUSWIKI_OPENBAO_SECRET_FIELD?.trim() || 'private_key';
  if (secretField.length > 128 || /[\x00-\x1f\x7f]/.test(secretField)) {
    throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_SECRET_FIELD is invalid.');
  }

  const namespace = env.FOCUSWIKI_OPENBAO_NAMESPACE?.trim() || undefined;
  if (namespace && (namespace.length > 256 || /[\x00-\x1f\x7f]/.test(namespace))) {
    throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_NAMESPACE is invalid.');
  }

  const caFile = env.FOCUSWIKI_OPENBAO_CA_FILE?.trim() || undefined;
  const ca = caFile ? readBoundedFile(caFile, MAX_CA_FILE_BYTES, 'FOCUSWIKI_OPENBAO_CA_FILE') : undefined;

  const rawProxy = env.FOCUSWIKI_OPENBAO_PROXY?.trim() || undefined;
  let proxy: URL | undefined;
  if (rawProxy) {
    try {
      proxy = new URL(rawProxy);
    } catch {
      throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_PROXY must be a valid HTTP proxy URL.');
    }
    if (proxy.protocol !== 'http:' || proxy.username || proxy.password || proxy.search || proxy.hash ||
        proxy.pathname !== '/' || !proxy.hostname) {
      throw new OpenBaoBootstrapError('FOCUSWIKI_OPENBAO_PROXY must be an http://host:port URL without credentials or path.');
    }
  }

  const keyFile = env.FOCUSWIKI_GITHUB_APP_KEY_FILE?.trim() ?? '';
  if (!keyFile || !path.isAbsolute(keyFile) || path.normalize(keyFile) !== keyFile || Buffer.byteLength(keyFile, 'utf8') > 512) {
    throw new OpenBaoBootstrapError('FOCUSWIKI_GITHUB_APP_KEY_FILE must be a normalized absolute path.');
  }

  const retries = parsePositiveInt(env.FOCUSWIKI_OPENBAO_RETRIES, 3, 1, 10, 'FOCUSWIKI_OPENBAO_RETRIES');
  const retryDelayMs = parsePositiveInt(env.FOCUSWIKI_OPENBAO_RETRY_DELAY_MS, 1500, 0, 30_000, 'FOCUSWIKI_OPENBAO_RETRY_DELAY_MS');

  return {
    addr, basePath, roleId, secretId, authMount, secretPath, secretField,
    namespace, ca, proxy, keyFile, retries, retryDelayMs
  };
}

function unbracketHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function openConnectTlsSocket(config: OpenBaoConfig, timeoutMs: number): Promise<tls.TLSSocket> {
  const proxy = config.proxy!;
  const targetPort = Number(config.addr.port || 443);
  const bareHost = unbracketHost(config.addr.hostname);
  const authority = `${config.addr.hostname}:${targetPort}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = http.request({
      host: unbracketHost(proxy.hostname),
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority },
      timeout: timeoutMs
    });
    req.on('timeout', () => {
      req.destroy();
      fail(new OpenBaoBootstrapError('Timed out establishing proxy tunnel to OpenBao.', true));
    });
    req.on('error', () => {
      fail(new OpenBaoBootstrapError('Failed to connect to the configured OpenBao proxy.', true));
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const retryable = (res.statusCode ?? 0) >= 500 || res.statusCode === 429;
        fail(new OpenBaoBootstrapError(`OpenBao proxy rejected CONNECT tunnel (HTTP ${res.statusCode ?? 'unknown'}).`, retryable));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: isIP(bareHost) ? undefined : bareHost,
        ca: config.ca,
        rejectUnauthorized: true
      });
      const timer = setTimeout(() => {
        tlsSocket.destroy();
        fail(new OpenBaoBootstrapError('Timed out completing TLS handshake with OpenBao through proxy.', true));
      }, timeoutMs);
      tlsSocket.once('secureConnect', () => {
        clearTimeout(timer);
        if (settled) {
          tlsSocket.destroy();
          return;
        }
        settled = true;
        resolve(tlsSocket);
      });
      tlsSocket.once('error', () => {
        clearTimeout(timer);
        fail(new OpenBaoBootstrapError('TLS verification failed while connecting to OpenBao through proxy.', false));
      });
    });
    req.end();
  });
}

async function openBaoRequest<T>(
  config: OpenBaoConfig,
  method: 'GET' | 'POST',
  apiPath: string,
  options: { token?: string; body?: object; timeoutMs?: number; expectJson?: boolean } = {}
): Promise<{ status: number; data: T | null }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8');
  const headers: http.OutgoingHttpHeaders = {
    Accept: 'application/json',
    Connection: 'close'
  };
  if (config.namespace) headers['X-Vault-Namespace'] = config.namespace;
  if (options.token) headers['X-Vault-Token'] = options.token;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }

  const tlsSocket = config.proxy ? await openConnectTlsSocket(config, timeoutMs) : undefined;
  const bareHost = unbracketHost(config.addr.hostname);
  const port = Number(config.addr.port || 443);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = https.request({
      hostname: bareHost,
      port,
      path: `${config.basePath}/v1/${apiPath}`,
      method,
      headers,
      timeout: timeoutMs,
      agent: false,
      rejectUnauthorized: true,
      ca: config.ca,
      servername: isIP(bareHost) ? undefined : bareHost,
      ...(tlsSocket ? { createConnection: () => tlsSocket } : {})
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy();
          finish(() => reject(new OpenBaoBootstrapError('OpenBao response exceeded size limit.', false)));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () => {
        finish(() => reject(new OpenBaoBootstrapError('OpenBao response stream failed.', true)));
      });
      res.on('end', () => {
        tlsSocket?.end();
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          finish(() => reject(new OpenBaoBootstrapError(`OpenBao returned an unexpected redirect (HTTP ${status}).`, false)));
          return;
        }
        if (options.expectJson === false || total === 0) {
          finish(() => resolve({ status, data: null }));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as T;
          finish(() => resolve({ status, data: parsed }));
        } catch {
          const retryable = status >= 500 || status === 429;
          finish(() => reject(new OpenBaoBootstrapError(`OpenBao returned non-JSON payload (HTTP ${status}).`, retryable)));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish(() => reject(new OpenBaoBootstrapError('OpenBao request timed out.', true)));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      tlsSocket?.destroy();
      const code = err?.code ?? '';
      const retryable = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
      finish(() => reject(new OpenBaoBootstrapError('Could not complete HTTPS request to OpenBao.', retryable)));
    });
    req.end(payload);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function normalizeAndValidateRsaPem(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new OpenBaoBootstrapError('OpenBao secret field is missing or not a string.', false);
  }
  let value = raw.trim();
  if (!value.includes('\n') && value.includes('\\n')) {
    value = value.replace(/\\n/g, '\n').trim();
  }
  const pem = `${value}\n`;
  const bytes = Buffer.byteLength(pem, 'utf8');
  if (bytes < 1 || bytes > MAX_KEY_BYTES) {
    throw new OpenBaoBootstrapError('OpenBao GitHub App key has an invalid size.', false);
  }
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') {
      throw new Error('non-rsa');
    }
  } catch {
    throw new OpenBaoBootstrapError('OpenBao GitHub App key is not a valid RSA private key.', false);
  }
  return pem;
}

function extractSecretValue(payload: unknown, field: string): unknown {
  if (!payload || typeof payload !== 'object') return undefined;
  const outer = (payload as { data?: unknown }).data;
  if (!outer || typeof outer !== 'object') return undefined;
  // KV v2 wraps secret fields under data.data; KV v1 stores them directly under data.
  const nested = (outer as { data?: unknown }).data;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && Object.prototype.hasOwnProperty.call(nested, field)) {
    return (nested as Record<string, unknown>)[field];
  }
  if (Object.prototype.hasOwnProperty.call(outer, field)) {
    return (outer as Record<string, unknown>)[field];
  }
  return undefined;
}

export async function fetchGitHubAppKeyFromOpenBao(config: OpenBaoConfig): Promise<string> {
  const login = await openBaoRequest<{ auth?: { client_token?: unknown } }>(
    config,
    'POST',
    `auth/${config.authMount}/login`,
    { body: { role_id: config.roleId, secret_id: config.secretId } }
  );
  if (login.status < 200 || login.status >= 300) {
    throw new OpenBaoBootstrapError(`OpenBao AppRole login failed (HTTP ${login.status}).`, isRetryableStatus(login.status));
  }
  const token = login.data?.auth?.client_token;
  if (typeof token !== 'string' || !token.trim() || /[\x00-\x1f\x7f]/.test(token)) {
    throw new OpenBaoBootstrapError('OpenBao AppRole login did not return a valid client token.', false);
  }

  try {
    const secret = await openBaoRequest<unknown>(config, 'GET', config.secretPath, { token });
    if (secret.status < 200 || secret.status >= 300) {
      throw new OpenBaoBootstrapError(`OpenBao secret read failed (HTTP ${secret.status}).`, isRetryableStatus(secret.status));
    }
    const rawPem = extractSecretValue(secret.data, config.secretField);
    return normalizeAndValidateRsaPem(rawPem);
  } finally {
    try {
      await openBaoRequest(config, 'POST', 'auth/token/revoke-self', {
        token,
        timeoutMs: REVOKE_TIMEOUT_MS,
        expectJson: false
      });
    } catch {
      // Best-effort revocation; do not mask fetch errors or break startup if policy omits revoke-self.
    }
  }
}

export function writeWorkerSecretFile(filePath: string, pem: string): void {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new OpenBaoBootstrapError('FOCUSWIKI_GITHUB_APP_KEY_FILE must be a normalized absolute path.');
  }
  const uid = process.geteuid?.();
  const dirPath = path.dirname(filePath);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dirPath);
  } catch {
    throw new OpenBaoBootstrapError('Worker secret directory does not exist.');
  }
  if (!dirStat.isDirectory() || fs.realpathSync(dirPath) !== dirPath ||
      (uid !== undefined && dirStat.uid !== uid) || (dirStat.mode & 0o077) !== 0) {
    throw new OpenBaoBootstrapError('Worker secret directory must be a private 0700 directory owned by the worker.');
  }

  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || (uid !== undefined && existing.uid !== uid))) {
    throw new OpenBaoBootstrapError('Existing worker secret target is unsafe.');
  }

  const tempPath = path.join(dirPath, `.focuswiki-key-${randomUUID()}`);
  try {
    const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, pem, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    if (err instanceof OpenBaoBootstrapError) throw err;
    throw new OpenBaoBootstrapError('Failed to write worker secret file.');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function bootstrapOpenBaoKey(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseOpenBaoConfig(env);
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.retries; attempt++) {
    try {
      const pem = await fetchGitHubAppKeyFromOpenBao(config);
      writeWorkerSecretFile(config.keyFile, pem);
      return;
    } catch (err) {
      lastError = err;
      const retryable = err instanceof OpenBaoBootstrapError && err.retryable;
      if (!retryable || attempt >= config.retries) throw err;
      await sleep(config.retryDelayMs * attempt);
    }
  }
  throw lastError;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  bootstrapOpenBaoKey().then(() => {
    console.log('[focuswiki-git] Loaded GitHub App key from OpenBao.');
  }).catch((err: unknown) => {
    console.error('[focuswiki-git] OpenBao bootstrap failed:', err instanceof Error ? err.message : 'Unknown error.');
    process.exitCode = 1;
  });
}
