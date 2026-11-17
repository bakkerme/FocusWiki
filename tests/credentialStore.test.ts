import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialStore,
  extractHttpsHost,
  maskSecretToken,
  normalizeCredentialHost
} from '../server/credentialStore.js';

describe('CredentialStore & HTTPS PAT Security', () => {
  let tmpRoot: string;
  let credsPath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-creds-test-'));
    credsPath = path.join(tmpRoot, 'config', '.git-credentials.enc.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('normalizes hosts cleanly and enforces HTTPS-only remote host extraction', () => {
    expect(normalizeCredentialHost('GitHub.COM')).toBe('github.com');
    expect(normalizeCredentialHost('https://git.example.com:8443/team/docs.git')).toBe(
      'git.example.com:8443'
    );
    expect(() => normalizeCredentialHost('')).toThrow();
    expect(() => normalizeCredentialHost('bad host')).toThrow();

    expect(extractHttpsHost('https://github.com/acme/wiki.git')).toBe('github.com');
    expect(extractHttpsHost('http://github.com/acme/wiki.git')).toBeNull();
    expect(extractHttpsHost('git@github.com:acme/wiki.git')).toBeNull();
    expect(extractHttpsHost('file:///tmp/repo.git')).toBeNull();

    expect(maskSecretToken('ghp_1234567890abcdefXYZ9')).toBe('ghp_…XYZ9');
    expect(maskSecretToken('short')).toBe('••••');
  });

  it('encrypts PATs at rest with AES-256-GCM and 0600 file permissions, never storing plaintext', () => {
    const rawSecret = 'github_pat_SUPER_SECRET_TOKEN_987654';
    const store = new CredentialStore({ credentialsPath: credsPath, env: {} });
    expect(store.getEncryptionMode()).toBe('file-key');

    const saved = store.upsert({
      host: 'https://github.com/acme/docs',
      token: rawSecret
    });

    expect(saved.id).toBe('host:github.com');
    expect(saved.host).toBe('github.com');
    expect(saved.username).toBe('x-access-token');
    expect(saved.maskedHint).toBe('github_pat_…7654');
    expect(saved.source).toBe('stored');

    const diskContent = fs.readFileSync(credsPath, 'utf8');
    expect(diskContent).not.toContain(rawSecret);
    expect(diskContent).not.toContain('SUPER_SECRET_TOKEN');

    if (process.platform !== 'win32') {
      const credsMode = fs.statSync(credsPath).mode & 0o777;
      const keyMode = fs.statSync(store.keyFilePath!).mode & 0o777;
      expect(credsMode).toBe(0o600);
      expect(keyMode).toBe(0o600);
    }

    // Reload from disk with a new store instance
    const reloaded = new CredentialStore({ credentialsPath: credsPath, env: {} });
    const resolvedHttps = reloaded.resolveForRemoteUrl('https://github.com/acme/private-docs.git');
    expect(resolvedHttps).toEqual({
      host: 'github.com',
      username: 'x-access-token',
      token: rawSecret
    });

    // Non-HTTPS URLs must never receive stored HTTPS tokens
    expect(reloaded.resolveForRemoteUrl('http://github.com/acme/private-docs.git')).toBeNull();
    expect(reloaded.resolveForRemoteUrl('ssh://git@github.com/acme/private-docs.git')).toBeNull();

    expect(reloaded.remove('host:github.com')).toBe(true);
    expect(reloaded.resolveForRemoteUrl('https://github.com/acme/private-docs.git')).toBeNull();
  });

  it('supports CAIRN_CREDENTIAL_KEY env master key without creating a disk key file', () => {
    const rawSecret = 'glpat-ENVKEYSECRET4321';
    const envWithKey = { CAIRN_CREDENTIAL_KEY: 'my-test-passphrase-for-ci' };

    const store = new CredentialStore({ credentialsPath: credsPath, env: envWithKey });
    expect(store.getEncryptionMode()).toBe('env-key');
    store.upsert({ host: 'gitlab.com', username: 'oauth2', token: rawSecret });

    expect(fs.existsSync(store.keyFilePath!)).toBe(false);

    const sameKeyReload = new CredentialStore({ credentialsPath: credsPath, env: envWithKey });
    expect(sameKeyReload.resolveForRemoteUrl('https://gitlab.com/team/docs.git')?.token).toBe(
      rawSecret
    );

    const wrongKeyReload = new CredentialStore({
      credentialsPath: credsPath,
      env: { CAIRN_CREDENTIAL_KEY: 'wrong-passphrase' }
    });
    expect(wrongKeyReload.resolveForRemoteUrl('https://gitlab.com/team/docs.git')).toBeNull();
  });

  it('falls back to environment tokens and lets stored host tokens take precedence, while scrubbing secrets from text', () => {
    const envSecret = 'ghp_ENVFALLBACK9999';
    const storedSecret = 'ghp_STOREDOVERRIDE1111';

    const store = new CredentialStore({
      credentialsPath: credsPath,
      env: { GITHUB_TOKEN: envSecret, GITLAB_TOKEN: 'glpat-GITLABENV2222' }
    });

    const initialList = store.list();
    expect(initialList.some((c) => c.id === 'env:github.com' && c.source === 'env')).toBe(true);
    expect(initialList.some((c) => c.id === 'env:gitlab.com' && c.source === 'env')).toBe(true);
    expect(store.resolveForRemoteUrl('https://github.com/org/repo.git')?.token).toBe(envSecret);

    store.upsert({ host: 'github.com', token: storedSecret });
    expect(store.resolveForRemoteUrl('https://github.com/org/repo.git')?.token).toBe(storedSecret);

    const dirtyError = `fatal: Authentication failed for 'https://x-access-token:${storedSecret}@github.com/org/repo.git' using ${envSecret}`;
    const scrubbed = store.scrubText(dirtyError);
    expect(scrubbed).not.toContain(storedSecret);
    expect(scrubbed).not.toContain(envSecret);
    expect(scrubbed).not.toContain('x-access-token:');
    expect(scrubbed).toContain('***');
  });

  it('stores file-backed keys separately with FOCUSWIKI_SECRETS_DIR and preserves legacy keys', () => {
    const secretsDir = path.join(tmpRoot, 'separate-secrets');
    const store = new CredentialStore({ credentialsPath: credsPath, env: { FOCUSWIKI_SECRETS_DIR: secretsDir } });
    store.upsert({ host: 'example.com', token: 'fictional_separate_key_token' });
    expect(store.keyFilePath).toBe(path.join(secretsDir, '.credential-master.key'));
    expect(fs.existsSync(path.join(path.dirname(credsPath), '.credential-master.key'))).toBe(false);
    expect(new CredentialStore({ credentialsPath: credsPath, env: { FOCUSWIKI_SECRETS_DIR: secretsDir } })
      .resolveForRemoteUrl('https://example.com/repo')?.token).toBe('fictional_separate_key_token');
    const legacyPath = path.join(tmpRoot, 'legacy', '.git-credentials.enc.json');
    const legacy = new CredentialStore({ credentialsPath: legacyPath, env: {} });
    legacy.upsert({ host: 'example.com', token: 'fictional_legacy_token' });
    const upgraded = new CredentialStore({ credentialsPath: legacyPath, env: { FOCUSWIKI_SECRETS_DIR: path.join(tmpRoot, 'new-secrets') } });
    expect(upgraded.keyFilePath).toBe(legacy.keyFilePath);
    expect(upgraded.resolveForRemoteUrl('https://example.com/repo')?.token).toBe('fictional_legacy_token');
  });

  it('prefers FOCUSWIKI_CREDENTIAL_KEY and never writes a disk key in env-key mode', () => {
    const env = { FOCUSWIKI_CREDENTIAL_KEY: 'fictional-focus-key', CAIRN_CREDENTIAL_KEY: 'legacy-key' };
    const store = new CredentialStore({ credentialsPath: credsPath, env });
    store.upsert({ host: 'example.com', token: 'fictional_env_token' });
    expect(store.getEncryptionMode()).toBe('env-key');
    expect(fs.existsSync(store.keyFilePath!)).toBe(false);
    expect(new CredentialStore({ credentialsPath: credsPath, env: { FOCUSWIKI_CREDENTIAL_KEY: env.FOCUSWIKI_CREDENTIAL_KEY } })
      .resolveForRemoteUrl('https://example.com/repo')?.token).toBe('fictional_env_token');
  });

  it('retains the last complete credentials file and cleans the temp file when atomic rename fails', () => {
    const store = new CredentialStore({ credentialsPath: credsPath, env: { FOCUSWIKI_CREDENTIAL_KEY: 'fictional-key' } });
    store.upsert({ host: 'example.com', token: 'original_fictional_token' });
    const original = fs.readFileSync(credsPath, 'utf8');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' }); });
    expect(() => store.upsert({ host: 'example.com', token: 'replacement_fictional_token' })).toThrow(/Cannot persist/);
    expect(rename).toHaveBeenCalledWith(expect.stringMatching(/\.tmp-\d+-[0-9a-f-]+$/), credsPath);
    expect(fs.readFileSync(credsPath, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(credsPath)).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    expect(store.resolveForRemoteUrl('https://example.com/repo')?.token).toBe('original_fictional_token');
  });
  it('warns once when file-backed keys are first generated or used', async () => {
    vi.resetModules();
    const { CredentialStore: FreshCredentialStore } = await import('../server/credentialStore.js');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = new FreshCredentialStore({ credentialsPath: credsPath, env: {} });
    first.upsert({ host: 'example.com', token: 'fictional_warning_token' });
    const second = new FreshCredentialStore({ credentialsPath: credsPath, env: {} });
    expect(second.resolveForRemoteUrl('https://example.com/repo')?.token).toBe('fictional_warning_token');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('FOCUSWIKI_CREDENTIAL_KEY'));
  });

});
