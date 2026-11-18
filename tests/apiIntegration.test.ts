import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubApp, type HubAppInstance } from '../server/app.js';

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test Seeder'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@local.invalid'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'Seed test repo'], {
    cwd: dir,
    stdio: 'pipe'
  });
}

describe('Hub API & Repository Integration (Acceptance Scenarios 1–9)', () => {
  let tmpRoot: string;
  let rpgDir: string;
  let labDir: string;
  let hub: HubAppInstance;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-hub-test-'));
    rpgDir = path.join(tmpRoot, 'cindervault-rpg');
    labDir = path.join(tmpRoot, 'helios-lab');

    copyDir(path.resolve('seeds/cindervault-rpg'), rpgDir);
    copyDir(path.resolve('seeds/helios-lab'), labDir);
    initGitRepo(rpgDir);
    initGitRepo(labDir);

    hub = createHubApp({
      projects: [
        {
          id: 'cindervault-rpg',
          name: 'Cindervault RPG',
          description: 'Fictional RPG repo',
          rootPath: rpgDir,
          defaultDoc: 'docs/vault-breach-action.md'
        },
        {
          id: 'helios-lab',
          name: 'Helios Lab',
          description: 'Fictional Lab repo',
          rootPath: labDir,
          defaultDoc: 'docs/bench-inventory.md'
        }
      ],
      enableWatcher: false
    });
  });

  afterEach(async () => {
    await hub.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('lists projects with Git unavailable flags, seeded docs, embeds, and cross-project search', async () => {
    const health = await request(hub.app).get('/healthz').expect(200);
    expect(health.body).toMatchObject({ status: 'ok', projectCount: 2 });

    const listRes = await request(hub.app).get('/api/projects').expect(200);
    expect(listRes.body.projects).toHaveLength(2);

    const rpg = listRes.body.projects.find((p: { id: string }) => p.id === 'cindervault-rpg');
    expect(rpg.git).toMatchObject({ state: 'unmanaged', isClean: null });
    expect(rpg.embeds.map((e: { src: string }) => e.src)).toEqual([
      'embeds/difficulty-playground/index.html',
      'embeds/state-explorer/index.html',
      'embeds/turn-walkthrough/index.html'
    ]);

    const searchRes = await request(hub.app).get('/api/search?q=198.51.100.41').expect(200);
    expect(searchRes.body.results.length).toBeGreaterThanOrEqual(1);
    expect(searchRes.body.results[0].projectId).toBe('helios-lab');
  });

  it('loads seeded RPG doc with attached comments, autosaves edits to disk, and reflects external bot edits before commit (Scenarios 1 & 2)', async () => {
    const docRes = await request(hub.app)
      .get('/api/projects/cindervault-rpg/doc?path=docs/vault-breach-action.md')
      .expect(200);

    expect(docRes.body.comments).toHaveLength(2);
    expect(docRes.body.comments.every((c: { anchorStatus: string }) => c.anchorStatus === 'attached')).toBe(true);

    const editedMd = docRes.body.markdown.replace(
      'Each phase of the `Breach Seal` action has a single authoritative owner',
      'Each phase of the `Breach Seal` action enforces one strict owner'
    );

    const saveRes = await request(hub.app)
      .put('/api/projects/cindervault-rpg/doc')
      .send({
        path: 'docs/vault-breach-action.md',
        markdown: editedMd,
        baseRevision: docRes.body.revision
      })
      .expect(200);

    expect(saveRes.body.revision).not.toBe(docRes.body.revision);

    // Verify Markdown file on disk was updated directly in working tree
    const onDisk = fs.readFileSync(path.join(rpgDir, 'docs/vault-breach-action.md'), 'utf8');
    expect(onDisk).toContain('enforces one strict owner');

    // Simulate external bot editing both the Markdown file and an embed file directly on disk
    fs.writeFileSync(
      path.join(rpgDir, 'docs/vault-breach-action.md'),
      `${onDisk}\n## Bot Appended Calibration Note\n\nAdded externally without committing.\n`,
      'utf8'
    );

    const afterExternal = await request(hub.app)
      .get('/api/projects/cindervault-rpg/doc?path=docs/vault-breach-action.md')
      .expect(200);
    expect(afterExternal.body.markdown).toContain('Bot Appended Calibration Note');

    // Uncommitted working tree changes show up before any git commit
    const projRes = await request(hub.app).get('/api/projects').expect(200);
    const rpg = projRes.body.projects.find((p: { id: string }) => p.id === 'cindervault-rpg');
    expect(rpg.git).toMatchObject({ state: 'unmanaged', isClean: null });
    expect(rpg.git.changedFiles).toEqual([]);
  });

  it('supports adding a fourth project-authored component using only project files and documented syntax (Scenario 3)', async () => {
    const widgetHtml = `<!doctype html><html><body><button id="calc">Compute Loot</button><script>window.parent.postMessage({type:'focus:embed:ready',height:180},'*');</script></body></html>`;

    await request(hub.app)
      .post('/api/projects/cindervault-rpg/embeds')
      .send({
        src: 'embeds/loot-curve/index.html',
        source: widgetHtml
      })
      .expect(201);

    const docRes = await request(hub.app)
      .get('/api/projects/cindervault-rpg/doc?path=docs/consequence-ledger.md')
      .expect(200);

    const updatedMd = `${docRes.body.markdown}\n\`\`\`embed\nsrc: embeds/loot-curve/index.html\ntitle: Relic Loot Curve\nheight: 220\nprops: {"tier":3}\n\`\`\`\n`;

    const saved = await request(hub.app)
      .put('/api/projects/cindervault-rpg/doc')
      .send({
        path: 'docs/consequence-ledger.md',
        markdown: updatedMd,
        baseRevision: docRes.body.revision
      })
      .expect(200);

    const embedBlock = saved.body.docJson.content.find((n: { type: string }) => n.type === 'embedBlock');
    expect(embedBlock).toBeTruthy();
    expect(embedBlock.attrs.src).toBe('embeds/loot-curve/index.html');

    // Verify sandboxed serving and strict CSP headers
    const sandboxRes = await request(hub.app)
      .get('/embed-sandbox/cindervault-rpg/embeds/loot-curve/index.html')
      .expect(200);
    expect(sandboxRes.text).toContain('Compute Loot');
    expect(sandboxRes.headers['content-security-policy']).toContain("default-src 'none'");
    expect(sandboxRes.headers['content-security-policy']).toContain("connect-src 'none'");
  });

  it('handles full comment lifecycle (create, reply, resolve, reopen) and resilient move/delete/duplicate anchor states (Scenarios 4 & 5)', async () => {
    const created = await request(hub.app)
      .post('/api/projects/cindervault-rpg/comments')
      .send({
        path: 'docs/consequence-ledger.md',
        quote: 'Grounding spike consumes 10 minutes of delve turn time',
        author: 'Balance Bot',
        role: 'bot',
        body: 'Should specialist riggers reduce this to 5 minutes?'
      })
      .expect(201);

    const threadId = created.body.thread.id;
    expect(created.body.thread.anchorStatus).toBe('attached');

    await request(hub.app)
      .post(`/api/projects/cindervault-rpg/comments/${threadId}/replies`)
      .send({
        path: 'docs/consequence-ledger.md',
        author: 'Lead Designer',
        role: 'human',
        body: 'Yes, via the Copperwright perk.'
      })
      .expect(200);

    const resolvedRes = await request(hub.app)
      .post(`/api/projects/cindervault-rpg/comments/${threadId}/status`)
      .send({
        path: 'docs/consequence-ledger.md',
        status: 'resolved',
        actor: 'Balance Bot',
        role: 'bot',
        note: 'Addressed in perk notes.'
      })
      .expect(200);
    expect(resolvedRes.body.thread.status).toBe('resolved');

    const reopenedRes = await request(hub.app)
      .post(`/api/projects/cindervault-rpg/comments/${threadId}/status`)
      .send({
        path: 'docs/consequence-ledger.md',
        status: 'open',
        actor: 'Lead Designer',
        role: 'human'
      })
      .expect(200);
    expect(reopenedRes.body.thread.status).toBe('open');
    expect(reopenedRes.body.thread.history.map((h: { action: string }) => h.action)).toEqual([
      'created',
      'replied',
      'resolved',
      'reopened'
    ]);

    // Verify sidecar file persisted on disk
    const sidecarRaw = JSON.parse(
      fs.readFileSync(path.join(rpgDir, 'docs/consequence-ledger.comments.json'), 'utf8')
    );
    expect(sidecarRaw.threads).toHaveLength(1);

    // Move passage -> remains attached
    const movedMd = `# Reorganized Ledger\n\nRelocated rule: Grounding spike consumes 10 minutes of delve turn time during hazard sweeps.\n`;
    fs.writeFileSync(path.join(rpgDir, 'docs/consequence-ledger.md'), movedMd, 'utf8');
    const afterMove = await request(hub.app)
      .get('/api/projects/cindervault-rpg/comments?path=docs/consequence-ledger.md')
      .expect(200);
    expect(afterMove.body.threads[0].anchorStatus).toBe('attached');

    // Duplicate passage -> flagged ambiguous
    const dupMd = `# Reorganized Ledger\n\nCopy A: Grounding spike consumes 10 minutes of delve turn time.\n\nCopy B: Grounding spike consumes 10 minutes of delve turn time.\n`;
    fs.writeFileSync(path.join(rpgDir, 'docs/consequence-ledger.md'), dupMd, 'utf8');
    const afterDup = await request(hub.app)
      .get('/api/projects/cindervault-rpg/comments?path=docs/consequence-ledger.md')
      .expect(200);
    expect(afterDup.body.threads[0].anchorStatus).toBe('ambiguous');

    // Delete passage -> flagged orphaned
    fs.writeFileSync(path.join(rpgDir, 'docs/consequence-ledger.md'), '# Empty Ledger\n', 'utf8');
    const afterDel = await request(hub.app)
      .get('/api/projects/cindervault-rpg/comments?path=docs/consequence-ledger.md')
      .expect(200);
    expect(afterDel.body.threads[0].anchorStatus).toBe('orphaned');
  });

  it('detects stale editor saves after external file edits and preserves both versions on 409 conflict (Scenario 6)', async () => {
    const initial = await request(hub.app)
      .get('/api/projects/helios-lab/doc?path=docs/cold-start-runbook.md')
      .expect(200);

    // External bot modifies file while editor holds stale revision
    const externalVersion = `${initial.body.markdown}\n- [ ] External bot added optical shutter check\n`;
    fs.writeFileSync(path.join(labDir, 'docs/cold-start-runbook.md'), externalVersion, 'utf8');

    const staleEditorVersion = `${initial.body.markdown}\n- [ ] Human author added chiller flow check\n`;
    const conflictRes = await request(hub.app)
      .put('/api/projects/helios-lab/doc')
      .send({
        path: 'docs/cold-start-runbook.md',
        markdown: staleEditorVersion,
        baseRevision: initial.body.revision
      })
      .expect(409);

    expect(conflictRes.body.error).toBe('revision_conflict');
    expect(conflictRes.body.diskMarkdown).toContain('External bot added optical shutter check');
    expect(conflictRes.body.yourMarkdown).toContain('Human author added chiller flow check');

    // Verify disk file was NOT overwritten AND conflict draft copy was written to disk
    const currentDisk = fs.readFileSync(path.join(labDir, 'docs/cold-start-runbook.md'), 'utf8');
    expect(currentDisk).toBe(externalVersion);

    const savedCopyAbs = path.join(labDir, conflictRes.body.savedConflictCopyPath);
    expect(fs.existsSync(savedCopyAbs)).toBe(true);
    expect(fs.readFileSync(savedCopyAbs, 'utf8')).toBe(staleEditorVersion);
  });

  it('keeps fictional local documents available with remote Git actions disabled', async () => {
    await request(hub.app).get('/api/projects/helios-lab/doc?path=docs/cold-start-runbook.md').expect(200);
    await request(hub.app).get('/api/projects/helios-lab/git/diff').expect(404);
    await request(hub.app).post('/api/projects/helios-lab/git/commit').send({ message: 'Fictional draft' }).expect(410);
    await request(hub.app).post('/api/projects/helios-lab/git/propose').send({
      reviewId: 'fictional-review', message: 'Fictional draft', paths: ['docs/cold-start-runbook.md']
    }).expect(404);
  });

  it('rejects path traversal, .git exposure, secret filenames, and unregistered projects (Scenario 9)', async () => {
    await request(hub.app)
      .get('/api/projects/unknown-repo/doc?path=README.md')
      .expect(404);

    await request(hub.app)
      .get('/api/projects/cindervault-rpg/doc?path=../../etc/passwd')
      .expect(403);

    await request(hub.app)
      .get('/api/projects/cindervault-rpg/doc?path=.git/config')
      .expect(403);

    await request(hub.app)
      .get('/embed-sandbox/cindervault-rpg/../../SPEC.md')
      .expect(403);

    await request(hub.app)
      .get('/embed-sandbox/cindervault-rpg/.git/HEAD')
      .expect(403);

    await request(hub.app)
      .put('/api/projects/cindervault-rpg/doc')
      .send({
        path: '.env.md',
        markdown: '# blocked',
        baseRevision: ''
      });

    await request(hub.app)
      .get('/api/projects/cindervault-rpg/doc?path=.env')
      .expect(403);
  });
});
