import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubApp, type HubAppInstance } from '../server/app.js';
import { sanitizeRemoteUrl, validateGitRemoteUrl } from '../server/gitService.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C'
    }
  });
}

function createRemoteFixture(rootDir: string): {
  bareDir: string;
  bareUrl: string;
  seedWorkDir: string;
} {
  const bareDir = path.join(rootDir, 'remote-wiki.git');
  const seedWorkDir = path.join(rootDir, 'remote-seed-work');
  fs.mkdirSync(bareDir, { recursive: true });
  fs.mkdirSync(seedWorkDir, { recursive: true });

  git(bareDir, ['init', '--bare', '-b', 'main']);
  git(seedWorkDir, ['init', '-b', 'main']);
  git(seedWorkDir, ['config', 'user.name', 'Remote Maintainer']);
  git(seedWorkDir, ['config', 'user.email', 'maintainer@local.invalid']);

  fs.mkdirSync(path.join(seedWorkDir, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(seedWorkDir, 'README.md'),
    '# Remote Wiki Home\n\nInitial main branch content.\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(seedWorkDir, 'docs', 'guide.md'),
    '# Operations Guide\n\nBaseline operations procedure.\n',
    'utf8'
  );

  git(seedWorkDir, ['add', '-A']);
  git(seedWorkDir, ['commit', '-m', 'Initial remote docs']);
  git(seedWorkDir, ['remote', 'add', 'origin', bareDir]);
  git(seedWorkDir, ['push', '-u', 'origin', 'main']);

  // Create a feature branch + PR #42 ref on the bare remote
  git(seedWorkDir, ['checkout', '-b', 'docs/feature']);
  fs.writeFileSync(
    path.join(seedWorkDir, 'docs', 'feature-notes.md'),
    '# Feature Notes\n\nContent from the docs/feature branch and PR 42.\n',
    'utf8'
  );
  git(seedWorkDir, ['add', '-A']);
  git(seedWorkDir, ['commit', '-m', 'Add feature documentation for PR 42']);
  git(seedWorkDir, ['push', 'origin', 'docs/feature']);
  git(seedWorkDir, ['push', 'origin', 'docs/feature:refs/pull/42/head']);

  git(seedWorkDir, ['checkout', 'main']);

  return {
    bareDir,
    bareUrl: `file://${bareDir}`,
    seedWorkDir
  };
}

describe('Repository Import, Persistence, Branch/PR Switching & Remote Pull', () => {
  let tmpRoot: string;
  let configPath: string;
  let reposDir: string;
  let allowedLocalRoot: string;
  let outsideRoot: string;
  let remote: { bareDir: string; bareUrl: string; seedWorkDir: string };
  let hub: HubAppInstance;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-import-test-'));
    const configDir = path.join(tmpRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'projects.json');
    fs.writeFileSync(configPath, JSON.stringify({ projects: [] }, null, 2), 'utf8');

    reposDir = path.join(tmpRoot, 'repos');
    allowedLocalRoot = path.join(tmpRoot, 'local-checkouts');
    outsideRoot = path.join(tmpRoot, 'outside-boundary');
    fs.mkdirSync(reposDir, { recursive: true });
    fs.mkdirSync(allowedLocalRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });

    remote = createRemoteFixture(tmpRoot);

    hub = createHubApp({
      projects: [],
      configPath,
      managedReposDir: reposDir,
      allowedImportRoots: [reposDir, allowedLocalRoot],
      enableWatcher: false
    });
  });

  afterEach(async () => {
    await hub.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('validates Git remote URLs safely and strips embedded credentials', () => {
    expect(() => validateGitRemoteUrl('--upload-pack=/tmp/evil')).toThrow();
    expect(() => validateGitRemoteUrl('ext::sh -c evil')).toThrow();
    expect(() => validateGitRemoteUrl('/just/a/local/path')).toThrow();
    expect(validateGitRemoteUrl('https://github.com/acme/docs.git')).toBe(
      'https://github.com/acme/docs.git'
    );
    expect(validateGitRemoteUrl('git@github.com:acme/docs.git')).toBe(
      'git@github.com:acme/docs.git'
    );
    expect(sanitizeRemoteUrl('https://user:secret-token@github.com/acme/docs.git')).toBe(
      'https://github.com/acme/docs.git'
    );
  });

  it('starts cleanly with zero repositories, initializes a new repo, persists to projects.json, and unregisters without deleting disk files', async () => {
    const emptyList = await request(hub.app).get('/api/projects').expect(200);
    expect(emptyList.body.projects).toEqual([]);

    const initRes = await request(hub.app)
      .post('/api/projects/import')
      .send({
        mode: 'init',
        name: 'Architecture Notes',
        defaultDoc: 'docs/overview.md'
      })
      .expect(201);

    const created = initRes.body.project;
    expect(created.id).toBe('architecture-notes');
    expect(created.git.branch).toBe('main');
    expect(created.git.isClean).toBe(true);
    expect(created.docs[0].path).toBe('docs/overview.md');

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      projects: Array<{ id: string; rootPath: string }>;
    };
    expect(persisted.projects).toHaveLength(1);
    expect(persisted.projects[0].id).toBe('architecture-notes');
    expect(persisted.projects[0].rootPath).toBe('repos/architecture-notes');

    // Reload a fresh hub instance from persisted projects.json
    const hub2 = createHubApp({
      projects: persisted.projects.map((p) => ({
        id: p.id,
        name: 'Architecture Notes',
        description: '',
        rootPath: path.resolve(tmpRoot, p.rootPath),
        defaultDoc: 'docs/overview.md'
      })),
      configPath,
      managedReposDir: reposDir,
      allowedImportRoots: [reposDir, allowedLocalRoot],
      enableWatcher: false
    });
    const list2 = await request(hub2.app).get('/api/projects').expect(200);
    expect(list2.body.projects).toHaveLength(1);
    await hub2.close();

    // Unregister via DELETE -> disappears from registry/config, disk files remain intact
    await request(hub.app).delete('/api/projects/architecture-notes').expect(200);
    const afterDelete = await request(hub.app).get('/api/projects').expect(200);
    expect(afterDelete.body.projects).toEqual([]);
    expect(fs.existsSync(created.rootPath)).toBe(true);
    expect(fs.existsSync(path.join(created.rootPath, 'docs', 'overview.md'))).toBe(true);
  });

  it('inspects and connects a local folder inside allowedImportRoots, and blocks paths or symlinks escaping allowed roots', async () => {
    const validLocal = path.join(allowedLocalRoot, 'team-handbook');
    fs.mkdirSync(path.join(validLocal, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(validLocal, 'docs', 'onboarding.md'), '# Onboarding\n\nWelcome.\n', 'utf8');

    const blockedDir = path.join(outsideRoot, 'secret-repo');
    fs.mkdirSync(blockedDir, { recursive: true });
    fs.writeFileSync(path.join(blockedDir, 'README.md'), '# Secret\n', 'utf8');

    const symlinkEscape = path.join(allowedLocalRoot, 'escape-link');
    fs.symlinkSync(blockedDir, symlinkEscape);

    // Outside allowedImportRoots -> 403
    await request(hub.app)
      .post('/api/projects/inspect-local')
      .send({ path: blockedDir })
      .expect(403);

    // Symlink escape -> 403
    await request(hub.app)
      .post('/api/projects/import')
      .send({ mode: 'local', path: symlinkEscape })
      .expect(403);

    // Valid plain folder -> inspect & connect
    const inspectRes = await request(hub.app)
      .post('/api/projects/inspect-local')
      .send({ path: validLocal })
      .expect(200);
    expect(inspectRes.body).toMatchObject({
      valid: true,
      docCount: 1,
      isGitRepo: false,
      suggestedDefaultDoc: 'docs/onboarding.md',
      alreadyRegisteredId: null
    });

    const importRes = await request(hub.app)
      .post('/api/projects/import')
      .send({ mode: 'local', path: validLocal, name: 'Team Handbook' })
      .expect(201);
    expect(importRes.body.project.id).toBe('team-handbook');

    // Duplicate registration of same realpath -> 409
    await request(hub.app)
      .post('/api/projects/import')
      .send({ mode: 'local', path: validLocal })
      .expect(409);

    // Registering .git folder directly -> 403
    const gitRepo = path.join(allowedLocalRoot, 'with-git');
    fs.mkdirSync(gitRepo, { recursive: true });
    git(gitRepo, ['init', '-b', 'main']);
    await request(hub.app)
      .post('/api/projects/inspect-local')
      .send({ path: path.join(gitRepo, '.git') })
      .expect(403);
  });

  it('inspects remote branches & PRs, clones a specific branch or PR, switches refs, and pulls fast-forward updates safely', async () => {
    const inspectRes = await request(hub.app)
      .post('/api/projects/inspect-remote')
      .send({ url: remote.bareUrl })
      .expect(200);

    expect(inspectRes.body.defaultBranch).toBe('main');
    expect(inspectRes.body.branches).toEqual(expect.arrayContaining(['main', 'docs/feature']));
    expect(inspectRes.body.pullRequests).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 42 })])
    );

    // 1. Clone default branch (main)
    const cloneRes = await request(hub.app)
      .post('/api/projects/import')
      .send({ mode: 'clone', url: remote.bareUrl, name: 'Remote Wiki' })
      .expect(201);

    const projectId = cloneRes.body.project.id;
    expect(cloneRes.body.project.git.branch).toBe('main');

    // Verify branches/remotes endpoint lists origin/docs/feature
    const refs1 = await request(hub.app)
      .get(`/api/projects/${projectId}/git/refs`)
      .expect(200);
    expect(refs1.body.hasRemote).toBe(true);
    expect(refs1.body.branches.some((b: { name: string }) => b.name === 'origin/docs/feature')).toBe(
      true
    );

    // 2. Fetch also discovers PR #42 from refs/pull/*/head
    const fetched1 = await request(hub.app)
      .post(`/api/projects/${projectId}/git/fetch`)
      .expect(200);
    expect(fetched1.body.pullRequests).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 42 })])
    );

    // 3. Push a new commit to main + a new PR #77 on the bare remote
    fs.writeFileSync(
      path.join(remote.seedWorkDir, 'README.md'),
      '# Remote Wiki Home\n\nUpdated upstream commit on main.\n',
      'utf8'
    );
    git(remote.seedWorkDir, ['add', 'README.md']);
    git(remote.seedWorkDir, ['commit', '-m', 'Upstream main update']);
    git(remote.seedWorkDir, ['push', 'origin', 'main']);

    git(remote.seedWorkDir, ['checkout', '-b', 'pr-77-branch']);
    fs.writeFileSync(
      path.join(remote.seedWorkDir, 'docs', 'pr77.md'),
      '# PR 77 Draft\n\nPulled from PR #77.\n',
      'utf8'
    );
    git(remote.seedWorkDir, ['add', '-A']);
    git(remote.seedWorkDir, ['commit', '-m', 'Add PR 77 page']);
    git(remote.seedWorkDir, ['push', 'origin', 'pr-77-branch:refs/pull/77/head']);
    git(remote.seedWorkDir, ['checkout', 'main']);

    const fetched2 = await request(hub.app)
      .post(`/api/projects/${projectId}/git/fetch`)
      .expect(200);
    expect(fetched2.body.behind).toBe(1);
    expect(fetched2.body.pullRequests.some((p: { number: number }) => p.number === 77)).toBe(true);

    // 4. Dirty working tree blocks pull and branch/PR checkout with 409
    const docBeforeEdit = await request(hub.app)
      .get(`/api/projects/${projectId}/doc?path=docs/guide.md`)
      .expect(200);
    const dirtySave = await request(hub.app)
      .put(`/api/projects/${projectId}/doc`)
      .send({
        path: 'docs/guide.md',
        markdown: '# Operations Guide\n\nUnsaved local WIP edit.\n',
        baseRevision: docBeforeEdit.body.revision
      })
      .expect(200);

    const dirtyPull = await request(hub.app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(409);
    expect(dirtyPull.body.error).toBe('working_tree_dirty');

    const dirtyCheckout = await request(hub.app)
      .post(`/api/projects/${projectId}/git/checkout`)
      .send({ kind: 'remote', ref: 'origin/docs/feature' })
      .expect(409);
    expect(dirtyCheckout.body.error).toBe('working_tree_dirty');

    // Revert local edit back to HEAD so working tree is clean
    await request(hub.app)
      .put(`/api/projects/${projectId}/doc`)
      .send({
        path: 'docs/guide.md',
        markdown: docBeforeEdit.body.markdown,
        baseRevision: dirtySave.body.revision
      })
      .expect(200);

    // 5. Fast-forward pull succeeds and updates README.md on disk
    const pullRes = await request(hub.app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(200);
    expect(pullRes.body.updated).toBe(true);
    expect(pullRes.body.status.behind).toBe(0);

    const updatedReadme = await request(hub.app)
      .get(`/api/projects/${projectId}/doc?path=README.md`)
      .expect(200);
    expect(updatedReadme.body.markdown).toContain('Updated upstream commit on main');

    // 6. Checkout remote branch, then PR #77, then switch back to local main
    const coBranch = await request(hub.app)
      .post(`/api/projects/${projectId}/git/checkout`)
      .send({ kind: 'remote', ref: 'origin/docs/feature' })
      .expect(200);
    expect(coBranch.body.branch).toBe('docs/feature');
    await request(hub.app)
      .get(`/api/projects/${projectId}/doc?path=docs/feature-notes.md`)
      .expect(200);

    const coPr77 = await request(hub.app)
      .post(`/api/projects/${projectId}/git/checkout`)
      .send({ kind: 'pr', ref: 'pr/77', prNumber: 77 })
      .expect(200);
    expect(coPr77.body.branch).toBe('pr/77');
    const prDoc = await request(hub.app)
      .get(`/api/projects/${projectId}/doc?path=docs/pr77.md`)
      .expect(200);
    expect(prDoc.body.markdown).toContain('Pulled from PR #77');

    const coMain = await request(hub.app)
      .post(`/api/projects/${projectId}/git/checkout`)
      .send({ kind: 'local', ref: 'main' })
      .expect(200);
    expect(coMain.body.branch).toBe('main');

    // 7. Clone directly onto PR #42 as a separate repo -> auto-dedupes slug id
    const clonePrRes = await request(hub.app)
      .post('/api/projects/import')
      .send({ mode: 'clone', url: remote.bareUrl, prNumber: 42 })
      .expect(201);
    expect(clonePrRes.body.project.id).toBe('remote-wiki-2');
    expect(clonePrRes.body.project.git.branch).toBe('pr/42');
    await request(hub.app)
      .get(`/api/projects/${clonePrRes.body.project.id}/doc?path=docs/feature-notes.md`)
      .expect(200);
  });

  it('refuses fast-forward pull with 409 when local branch has diverged from remote', async () => {
    const cloneRes = await request(hub.app)
      .post('/api/projects/import')
      .send({ mode: 'clone', url: remote.bareUrl, id: 'diverged-repo' })
      .expect(201);
    const cloneRoot = cloneRes.body.project.rootPath;

    // Create a local commit not on remote
    fs.writeFileSync(path.join(cloneRoot, 'local-only.md'), '# Local\n', 'utf8');
    git(cloneRoot, ['add', 'local-only.md']);
    git(cloneRoot, [
      '-c',
      'user.name=Local Author',
      '-c',
      'user.email=local@invalid',
      'commit',
      '-m',
      'Local commit'
    ]);

    // Push a different commit to remote main
    fs.writeFileSync(path.join(remote.seedWorkDir, 'remote-only.md'), '# Remote\n', 'utf8');
    git(remote.seedWorkDir, ['add', 'remote-only.md']);
    git(remote.seedWorkDir, ['commit', '-m', 'Diverging remote commit']);
    git(remote.seedWorkDir, ['push', 'origin', 'main']);

    const pullRes = await request(hub.app)
      .post('/api/projects/diverged-repo/git/pull')
      .expect(409);
    expect(pullRes.body.message).toMatch(/diverged|fast-forward/i);
  });

  it('supports live watcher addProject and removeProject without errors', async () => {
    const watchedHub = createHubApp({
      projects: [],
      configPath,
      managedReposDir: reposDir,
      allowedImportRoots: [reposDir, allowedLocalRoot],
      enableWatcher: true
    });

    try {
      const initRes = await request(watchedHub.app)
        .post('/api/projects/import')
        .send({ mode: 'init', name: 'Watched Repo' })
        .expect(201);
      expect(initRes.body.project.id).toBe('watched-repo');

      await request(watchedHub.app).delete('/api/projects/watched-repo').expect(200);
    } finally {
      await watchedHub.close();
    }
  });

  it('manages encrypted PAT credentials, tests remote connectivity, reports server environment, and applies commit authorEmail', async () => {
    const secretToken = 'github_pat_INTEGRATION_SECRET_8899';

    // Environment diagnostics
    const envRes = await request(hub.app).get('/api/settings/environment').expect(200);
    expect(envRes.body.managedReposDir).toBe(reposDir);
    expect(envRes.body.encryptionMode).toMatch(/^(file-key|env-key)$/);
    expect(typeof envRes.body.sshClientAvailable).toBe('boolean');

    // Store encrypted PAT via API
    const putRes = await request(hub.app)
      .put('/api/settings/credentials')
      .send({ host: 'github.com', username: 'alice', token: secretToken })
      .expect(200);

    expect(putRes.body.credential.host).toBe('github.com');
    expect(putRes.body.credential.username).toBe('alice');
    expect(putRes.body.credential.maskedHint).toBe('github_pat_…8899');
    expect(JSON.stringify(putRes.body)).not.toContain(secretToken);

    const listRes = await request(hub.app).get('/api/settings/credentials').expect(200);
    expect(JSON.stringify(listRes.body)).not.toContain(secretToken);
    expect(
      listRes.body.credentials.some(
        (c: { id: string; host: string }) => c.id === 'host:github.com' && c.host === 'github.com'
      )
    ).toBe(true);

    // Env credentials cannot be deleted via HTTP API
    const envDel = await request(hub.app)
      .delete('/api/settings/credentials/env%3Agithub.com')
      .expect(400);
    expect(envDel.body.error).toBe('env_credential_readonly');

    // Stored credential can be removed
    await request(hub.app).delete('/api/settings/credentials/host%3Agithub.com').expect(200);

    // Test remote probe endpoint against local bare fixture
    const testRes = await request(hub.app)
      .post('/api/settings/credentials/test')
      .send({ url: remote.bareUrl })
      .expect(200);
    expect(testRes.body).toMatchObject({
      ok: true,
      defaultBranch: 'main'
    });
    expect(testRes.body.branchCount).toBeGreaterThanOrEqual(2);
    expect(testRes.body.prCount).toBeGreaterThanOrEqual(1);

    // Verify commit endpoint honors authorName + authorEmail
    const initRes = await request(hub.app)
      .post('/api/projects/import')
      .send({ mode: 'init', name: 'Author Email Repo' })
      .expect(201);
    const repoRoot = initRes.body.project.rootPath as string;
    const readmeRes = await request(hub.app)
      .get('/api/projects/author-email-repo/doc?path=README.md')
      .expect(200);
    await request(hub.app)
      .put('/api/projects/author-email-repo/doc')
      .send({
        path: 'README.md',
        markdown: '# Author Email Repo\n\nUpdated line.\n',
        baseRevision: readmeRes.body.revision
      })
      .expect(200);

    const commitRes = await request(hub.app)
      .post('/api/projects/author-email-repo/git/commit')
      .send({
        message: 'Verify author identity',
        authorName: 'Ada Lovelace',
        authorEmail: 'ada@analytical.example'
      })
      .expect(200);
    expect(commitRes.body.sha).toBeTruthy();

    const logEmail = git(repoRoot, ['log', '-1', '--format=%an <%ae>']).trim();
    expect(logEmail).toBe('Ada Lovelace <ada@analytical.example>');
  });

  it('updates repository metadata via PATCH /api/projects/:projectId and respects includePrRefs on git fetch', async () => {
    const cloneRes = await request(hub.app)
      .post('/api/projects/import')
      .send({ mode: 'clone', url: remote.bareUrl, name: 'Editable Repo' })
      .expect(201);
    const projectId = cloneRes.body.project.id as string;

    // Fetch with includePrRefs: false skips querying refs/pull/*/head
    const fetchNoPr = await request(hub.app)
      .post(`/api/projects/${projectId}/git/fetch`)
      .send({ includePrRefs: false })
      .expect(200);
    expect(fetchNoPr.body.pullRequests).toEqual([]);

    // Fetch with includePrRefs: true discovers PR #42
    const fetchWithPr = await request(hub.app)
      .post(`/api/projects/${projectId}/git/fetch`)
      .send({ includePrRefs: true })
      .expect(200);
    expect(fetchWithPr.body.pullRequests).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 42 })])
    );

    // Valid PATCH updates name & defaultDoc and persists to projects.json
    const patchRes = await request(hub.app)
      .patch(`/api/projects/${projectId}`)
      .send({ name: 'Platform Handbook', defaultDoc: 'docs/guide.md' })
      .expect(200);
    expect(patchRes.body.project.name).toBe('Platform Handbook');
    expect(patchRes.body.project.defaultDoc).toBe('docs/guide.md');

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      projects: Array<{ id: string; name: string; defaultDoc: string }>;
    };
    expect(persisted.projects.find((p) => p.id === projectId)).toMatchObject({
      name: 'Platform Handbook',
      defaultDoc: 'docs/guide.md'
    });

    // Reject empty name, non-markdown defaultDoc, and path traversal
    await request(hub.app)
      .patch(`/api/projects/${projectId}`)
      .send({ name: '   ' })
      .expect(400);

    await request(hub.app)
      .patch(`/api/projects/${projectId}`)
      .send({ defaultDoc: 'package.json' })
      .expect(400);

    await request(hub.app)
      .patch(`/api/projects/${projectId}`)
      .send({ defaultDoc: '../secret.md' })
      .expect(403);
  });
});
