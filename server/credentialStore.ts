import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GitCredentialSummary } from '../shared/types.js';
import { PathBoundaryError } from './pathGuard.js';

interface StoredCredentialRecord {
  id: string;
  host: string;
  username: string;
  maskedHint: string;
  updatedAt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface StoredCredentialFile {
  version: 1;
  credentials: StoredCredentialRecord[];
}

export interface ResolvedGitCredential {
  username: string;
  token: string;
  host: string;
}

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;

export function normalizeCredentialHost(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new PathBoundaryError('Host is required (e.g. github.com).', 400);
  }
  if (/[\s\0\r\n]/.test(trimmed)) {
    throw new PathBoundaryError('Host contains invalid characters.', 400);
  }

  let candidate = trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      candidate = parsed.host;
    } catch {
      throw new PathBoundaryError('Could not parse hostname from URL.', 400);
    }
  } else {
    candidate = trimmed.split('/')[0] ?? trimmed;
  }

  const normalized = candidate.toLowerCase();
  if (!HOSTNAME_RE.test(normalized)) {
    throw new PathBoundaryError(
      'Enter a valid Git host (for example github.com, gitlab.com, or git.internal:8443).',
      400
    );
  }
  return normalized;
}

export function extractHttpsHost(remoteUrl: string): string | null {
  try {
    const parsed = new URL(remoteUrl.trim());
    if (parsed.protocol !== 'https:') return null;
    return parsed.host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function maskSecretToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 6) {
    return '••••';
  }
  const prefixMatch = trimmed.match(/^(ghp_|github_pat_|glpat-|gitea_|x-access-token)/);
  const prefix = prefixMatch ? prefixMatch[1] : trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${prefix}…${tail}`;
}

export interface CredentialStoreOptions {
  credentialsPath?: string;
  masterKeyEnv?: string;
  env?: NodeJS.ProcessEnv;
}

let warnedAboutFileKey = false;

export class CredentialStore {
  public readonly credentialsPath: string | null;
  public readonly keyFilePath: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly records = new Map<string, StoredCredentialRecord>();
  private ephemeralKey: Buffer | null = null;

  constructor(options: CredentialStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.credentialsPath = options.credentialsPath ? path.resolve(options.credentialsPath) : null;
    const legacyKeyPath = this.credentialsPath
      ? path.join(path.dirname(this.credentialsPath), '.credential-master.key') : null;
    const secretsKeyPath = this.env.FOCUSWIKI_SECRETS_DIR
      ? path.resolve(this.env.FOCUSWIKI_SECRETS_DIR, '.credential-master.key') : null;
    this.keyFilePath = secretsKeyPath && (fs.existsSync(secretsKeyPath) || !legacyKeyPath || !fs.existsSync(legacyKeyPath))
      ? secretsKeyPath : legacyKeyPath;

    this.loadFromDisk();
  }

  public getEncryptionMode(): 'env-key' | 'file-key' | 'memory-only' {
    if (this.readEnvMasterKey()) return 'env-key';
    if (this.credentialsPath) return 'file-key';
    return 'memory-only';
  }

  private readEnvMasterKey(): Buffer | null {
    const raw =
      this.env.FOCUSWIKI_CREDENTIAL_KEY ??
      this.env.CAIRN_CREDENTIAL_KEY ??
      '';
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
  }

  private getOrCreateMasterKey(createIfMissing: boolean): Buffer {
    const envKey = this.readEnvMasterKey();
    if (envKey) return envKey;

    if (!this.keyFilePath) {
      if (!this.ephemeralKey) {
        this.ephemeralKey = crypto.randomBytes(32);
      }
      return this.ephemeralKey;
    }

    if (!warnedAboutFileKey) {
      console.warn('[FocusWiki] FOCUSWIKI_CREDENTIAL_KEY is unset; using a file-backed credential key. Set FOCUSWIKI_CREDENTIAL_KEY or protect FOCUSWIKI_SECRETS_DIR separately from config backups.');
      warnedAboutFileKey = true;
    }
    if (fs.existsSync(this.keyFilePath)) {
      const hex = fs.readFileSync(this.keyFilePath, 'utf8').trim();
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === 32) return buf;
    }

    if (!createIfMissing) {
      throw new PathBoundaryError('Credential master key is missing.', 500);
    }

    const dir = path.dirname(this.keyFilePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
    const key = crypto.randomBytes(32);
    const tmp = path.join(dir, `.credential-master.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.keyFilePath);
    return key;
  }

  private loadFromDisk(): void {
    if (!this.credentialsPath || !fs.existsSync(this.credentialsPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8')) as Partial<StoredCredentialFile>;
      if (raw?.version !== 1 || !Array.isArray(raw.credentials)) return;
      for (const rec of raw.credentials) {
        if (
          rec &&
          typeof rec.id === 'string' &&
          typeof rec.host === 'string' &&
          typeof rec.ciphertext === 'string' &&
          typeof rec.iv === 'string' &&
          typeof rec.authTag === 'string'
        ) {
          this.records.set(rec.id, rec);
        }
      }
    } catch {
      // Corrupt or unreadable file is ignored safely rather than crashing startup
    }
  }

  private persistToDisk(): void {
    if (!this.credentialsPath) return;
    const dir = path.dirname(this.credentialsPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o770 });

    const payload: StoredCredentialFile = {
      version: 1,
      credentials: Array.from(this.records.values()).sort((a, b) => a.host.localeCompare(b.host))
    };

    const tmp = path.join(
      dir,
      `${path.basename(this.credentialsPath)}.tmp-${process.pid}-${crypto.randomUUID()}`
    );
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.credentialsPath);
    } catch (err) {
      if (fs.existsSync(tmp)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
        throw new PathBoundaryError(
          `Cannot persist Git credentials to ${this.credentialsPath} (${code}). Mount config directory writable.`,
          500
        );
      }
      throw err;
    }
  }

  private encryptSecret(secret: string): { iv: string; authTag: string; ciphertext: string } {
    const key = this.getOrCreateMasterKey(true);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: encrypted.toString('base64')
    };
  }

  private decryptSecret(rec: StoredCredentialRecord): string | null {
    try {
      const key = this.getOrCreateMasterKey(false);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(rec.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(rec.authTag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(rec.ciphertext, 'base64')),
        decipher.final()
      ]);
      return plain.toString('utf8');
    } catch {
      return null;
    }
  }

  private listEnvCredentials(): Array<GitCredentialSummary & { token: string }> {
    const items: Array<GitCredentialSummary & { token: string }> = [];
    const githubToken = (this.env.GITHUB_TOKEN ?? this.env.GIT_HTTPS_TOKEN ?? '').trim();
    if (githubToken) {
      items.push({
        id: 'env:github.com',
        host: 'github.com',
        username: 'x-access-token',
        maskedHint: maskSecretToken(githubToken),
        source: 'env',
        token: githubToken
      });
    }
    const gitlabToken = (this.env.GITLAB_TOKEN ?? '').trim();
    if (gitlabToken) {
      items.push({
        id: 'env:gitlab.com',
        host: 'gitlab.com',
        username: 'oauth2',
        maskedHint: maskSecretToken(gitlabToken),
        source: 'env',
        token: gitlabToken
      });
    }
    return items;
  }

  public list(): GitCredentialSummary[] {
    const stored: GitCredentialSummary[] = Array.from(this.records.values())
      .sort((a, b) => a.host.localeCompare(b.host))
      .map((rec) => ({
        id: rec.id,
        host: rec.host,
        username: rec.username,
        maskedHint: rec.maskedHint,
        source: 'stored',
        updatedAt: rec.updatedAt
      }));

    const envItems = this.listEnvCredentials().map(({ token: _tok, ...summary }) => summary);
    return [...stored, ...envItems];
  }

  public upsert(input: {
    host: string;
    username?: string;
    token: string;
  }): GitCredentialSummary {
    const host = normalizeCredentialHost(input.host);
    const token = input.token.trim();
    if (!token) {
      throw new PathBoundaryError('Personal Access Token cannot be empty.', 400);
    }
    if (/[\r\n\0]/.test(token)) {
      throw new PathBoundaryError('Token contains invalid newline or null characters.', 400);
    }

    const rawUser = (input.username ?? '').trim();
    if (/[\r\n\0]/.test(rawUser)) {
      throw new PathBoundaryError('Username contains invalid characters.', 400);
    }
    const username = rawUser || 'x-access-token';
    const id = `host:${host}`;
    const encrypted = this.encryptSecret(token);
    const updatedAt = new Date().toISOString();

    const record: StoredCredentialRecord = {
      id,
      host,
      username,
      maskedHint: maskSecretToken(token),
      updatedAt,
      ...encrypted
    };

    const prev = this.records.get(id);
    this.records.set(id, record);
    try {
      this.persistToDisk();
    } catch (err) {
      if (prev) this.records.set(id, prev);
      else this.records.delete(id);
      throw err;
    }

    return {
      id: record.id,
      host: record.host,
      username: record.username,
      maskedHint: record.maskedHint,
      source: 'stored',
      updatedAt: record.updatedAt
    };
  }

  public remove(id: string): boolean {
    const existing = this.records.get(id);
    if (!existing) return false;
    this.records.delete(id);
    try {
      this.persistToDisk();
    } catch (err) {
      this.records.set(id, existing);
      throw err;
    }
    return true;
  }

  public resolveForRemoteUrl(remoteUrl: string): ResolvedGitCredential | null {
    const host = extractHttpsHost(remoteUrl);
    if (!host) return null;

    const stored = this.records.get(`host:${host}`);
    if (stored) {
      const token = this.decryptSecret(stored);
      if (token) {
        return {
          host,
          username: stored.username,
          token
        };
      }
    }

    const envMatch = this.listEnvCredentials().find((item) => item.host === host);
    if (envMatch) {
      return {
        host,
        username: envMatch.username,
        token: envMatch.token
      };
    }

    return null;
  }

  public getAllActiveSecrets(): string[] {
    const secrets: string[] = [];
    for (const rec of this.records.values()) {
      const token = this.decryptSecret(rec);
      if (token) secrets.push(token);
    }
    for (const envItem of this.listEnvCredentials()) {
      secrets.push(envItem.token);
    }
    return secrets;
  }

  public scrubText(text: string, extraSecrets: string[] = []): string {
    let result = text;
    const all = [...this.getAllActiveSecrets(), ...extraSecrets]
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const secret of all) {
      if (result.includes(secret)) {
        result = result.split(secret).join('***');
      }
    }
    // Also scrub user:pass@ in URLs if any appeared in stderr
    result = result.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1***:***@');
    return result;
  }
}
