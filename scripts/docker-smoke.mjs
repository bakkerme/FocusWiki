import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

// Exercise the actual runtime image without touching the working repositories or
// publishing ports. Only this run's disposable container and volume are removed.
const image = process.argv[2] ?? 'focuswiki:latest';
const name = `focuswiki-smoke-${randomUUID()}`;
const volume = `${name}-repos`;

function docker(...args) {
  return execFileSync('docker', args, {
    encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

async function ready() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(docker('inspect', name, '--format', '{{json .State}}'));
    assert.equal(state.Running, true, `Container exited: ${docker('logs', name)}`);
    if (state.Health?.Status === 'healthy') return;
    if (state.Health?.Status === 'unhealthy') break;
    await setTimeout(500);
  }
  throw new Error(`Container failed healthcheck: ${docker('logs', name)}`);
}

async function start() {
  docker('run', '-d', '--name', name, '--network', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=volume,source=${volume},target=/app/sample-repos`, image);
  await ready();
}

function inContainer(code) {
  return docker('exec', name, 'node', '--input-type=module', '-e', code);
}

// This code runs using only the production image's built-in Node runtime.
const helpers = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import { createHash } from 'node:crypto';
  import { execFileSync } from 'node:child_process';
  const root = '/app/sample-repos/cindervault-rpg';
  const docPath = 'docs/vault-breach-action.md';
  const route = '/api/projects/cindervault-rpg';
  async function api(path, method = 'GET', body, status = 200) {
    const res = await fetch('http://127.0.0.1:8088' + path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    const value = await res.json();
    assert.equal(res.status, status, JSON.stringify(value));
    return value;
  }
  async function check() {
    assert.equal((await api('/healthz')).projectCount, 2);
    const { projects } = await api('/api/projects');
    assert.equal(projects.length, 2);
    for (const project of projects) {
      assert.equal(project.git.branch, 'main');
      assert.ok(project.git.headSha);
      assert.ok(project.docs.length >= 3);
      assert.ok(project.embeds.length >= 1);
    }
    const htmlRes = await fetch('http://127.0.0.1:8088/');
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    const asset = html.match(/src="([^\"]+\\.js)"/);
    assert.ok(asset, 'Production HTML must reference a compiled client');
    assert.equal((await fetch('http://127.0.0.1:8088' + asset[1])).status, 200);
    return api(route + '/doc?path=' + docPath);
  }
`;

try {
  const security = JSON.parse(docker('info', '--format', '{{json .SecurityOptions}}'));
  assert.ok(security.includes('name=rootless'), 'Use the existing rootless daemon');
  docker('volume', 'create', volume);
  await start();
  console.log('PASS: fresh image seeds both Git repositories and becomes healthy');

  const expected = inContainer(helpers + `
    const doc = await check();
    assert.equal(doc.comments.length, 2);
    const markdown = doc.markdown + '\\nDocker persistence check: fictional test data.\\n';
    await api(route + '/doc', 'PUT', {
      path: docPath, markdown, baseRevision: doc.revision
    });
    await api(route + '/comments', 'POST', {
      path: docPath, quote: 'Docker persistence check: fictional test data.',
      body: 'Disposable Docker smoke test comment.', author: 'Smoke Test', role: 'bot'
    }, 201);
    await api(route + '/embeds', 'POST', {
      src: 'embeds/docker-smoke/index.html',
      source: '<!doctype html><p>Disposable fictional component</p>'
    }, 201);
    const persisted = await check();
    assert.equal(persisted.markdown, markdown);
    assert.equal(persisted.comments.length, 3);
    assert.equal(persisted.comments.at(-1).anchorStatus, 'attached');
    assert.equal(fs.readFileSync(root + '/' + docPath, 'utf8'), markdown);
    console.log(JSON.stringify({
      revision: persisted.revision,
      hashes: ['docs/vault-breach-action.md', 'docs/vault-breach-action.comments.json',
        'embeds/docker-smoke/index.html'].map(p =>
          createHash('sha256').update(fs.readFileSync(root + '/' + p)).digest('hex')),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    }));
  `);
  console.log('PASS: production client assets, Git status, docs, comments and component writes');

  function verifyPersistence() {
    const actual = inContainer(helpers + `
      const doc = await check();
      assert.equal(doc.comments.length, 3);
      console.log(JSON.stringify({
        revision: doc.revision,
        hashes: ['docs/vault-breach-action.md', 'docs/vault-breach-action.comments.json',
          'embeds/docker-smoke/index.html'].map(p =>
            createHash('sha256').update(fs.readFileSync(root + '/' + p)).digest('hex')),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      }));
    `);
    assert.deepEqual(JSON.parse(actual), JSON.parse(expected));
  }

  docker('restart', name);
  await ready();
  verifyPersistence();
  console.log('PASS: restart preserves document, comment, component and Git HEAD');

  docker('rm', '-f', name);
  await start();
  verifyPersistence();
  console.log('PASS: container recreation reuses persistent files without reseeding');
} catch (error) {
  try { console.error(docker('logs', name)); } catch { /* Container may not exist yet. */ }
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
} finally {
  try { docker('rm', '-f', name); } catch { /* Already removed or never created. */ }
  try { docker('volume', 'rm', volume); } catch (error) {
    console.error(`Could not remove test volume ${volume}: ${error.message}`);
    process.exitCode = 1;
  }
}
