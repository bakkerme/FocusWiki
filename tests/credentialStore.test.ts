import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
