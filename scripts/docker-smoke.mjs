import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.argv[2] ?? 'focuswiki:latest';
const project = `focuswiki-smoke-${randomUUID()}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-smoke-'));
const origin = 'https://wiki.example.ts.net';
const publisher = 'publisher@example.test';
const composeFile = fileURLToPath(new URL('../compose.yaml', import.meta.url));
const override = path.join(root, 'smoke.yaml');
const enrollment = path.join(root, 'enrollment.json');
const editable = path.join(root, 'repos/fictional');
const env = {
  ...process.env,
  FOCUSWIKI_DEPLOY_DIR: root,
  FOCUSWIKI_IMAGE: image,
  FOCUSWIKI_PUBLIC_ORIGIN: origin,
  FOCUSWIKI_PUBLISHERS: publisher,
  FOCUSWIKI_GITHUB_APP_ID: '1',
  FOCUSWIKI_GITHUB_INSTALLATION_ID: '1'
};

function docker(...args) {
  return execFileSync('docker', args, { env, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function compose(...args) {
  return docker('compose', '-p', project, '-f', composeFile, '-f', override, ...args);
}

function inspect(service) {
  return JSON.parse(docker('inspect', compose('ps', '-q', service)))[0];
}

function asFixtureOwner(...args) {
  return docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges:true', '--mount', `type=bind,source=${root},target=/fixture`,
    '--entrypoint', '/bin/sh', image, '-ec', ...args);
}

function checkIsolation(service, expectedMounts) {
  const { Config, HostConfig, Mounts } = inspect(service);
  assert.equal(HostConfig.NetworkMode, 'none');
  assert.equal(HostConfig.ReadonlyRootfs, true);
  assert.equal(HostConfig.Privileged, false);
  assert.equal(Config.User, service === 'web' ? '10002:0' : '0:0');
  assert.ok(HostConfig.CapDrop.includes('ALL'));
  assert.ok(HostConfig.SecurityOpt.some((value) => value.startsWith('no-new-privileges')));
  assert.deepEqual(Object.keys(HostConfig.PortBindings ?? {}), []);
  const bindMounts = Mounts.filter(({ Type }) => Type !== 'tmpfs');
  assert.deepEqual(Object.fromEntries(bindMounts.map(({ Destination, RW }) => [Destination, RW])), expectedMounts);
  const workerEnv = Config.Env.filter((value) => /^FOCUSWIKI_(GITHUB_APP|GITHUB_INSTALLATION|GIT_STATE)/.test(value));
  assert.equal(workerEnv.length, service === 'git-worker' ? 4 : 0);
}

const webMounts = {
  '/app/repos': true,
  '/etc/focuswiki/enrollment.json': false,
  '/run/focuswiki': false,
  '/run/focuswiki-serve': true
};

function inWeb(code) {
  return compose('exec', '-T', 'web', 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import http from 'node:http';
    import net from 'node:net';
    const origin = ${JSON.stringify(origin)};
    const publisher = ${JSON.stringify(publisher)};
    const reader = 'editor@example.test';
    const route = '/api/projects/fictional';
    async function api(path, { method = 'GET', login = reader, body, browser = origin, status = 200 } = {}) {
      const headers = { Host: 'localhost', 'X-Forwarded-Host': new URL(origin).host, 'X-Forwarded-Proto': 'https' };
      if (login) headers['Tailscale-User-Login'] = login;
      if (browser) headers.Origin = browser;
      const data = body === undefined ? undefined : JSON.stringify(body);
      if (data) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
      const value = await new Promise((resolve, reject) => {
        const req = http.request({ socketPath: process.env.FOCUSWIKI_HTTP_SOCKET, path, method, headers }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, text, location: res.headers.location, type: res.headers['content-type'] }));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('Socket request timed out')));
        req.end(data);
      });
      assert.equal(value.status, status, path + ': ' + value.text);
      if (status === 302) return value.location;
      return value.type?.includes('application/json') ? JSON.parse(value.text) : value.text;
    }
    ${code}`);
}

let fixtureOwnerChanged = false;
let releaseReady = false;
try {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    const security = JSON.parse(docker('info', '--format', '{{json .SecurityOptions}}'));
    assert.ok(security.includes('name=rootless'), 'Use the existing rootless daemon');
  }
  fs.mkdirSync(path.join(root, 'repos'), { mode: 0o750 });
  fs.mkdirSync(editable, { mode: 0o770 });
  for (const dir of ['git-socket', 'serve-socket', 'git-state']) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  fs.writeFileSync(path.join(editable, 'README.md'), '# Fictional smoke test\n', { mode: 0o660 });
  fs.writeFileSync(enrollment, JSON.stringify({ projects: [{
    id: 'fictional', name: 'Fictional', remote: 'https://github.com/example/fictional.git', branch: 'main'
  }] }));
  fs.writeFileSync(override, 'services:\n  git-worker:\n    network_mode: none\n');
  // The isolated worker gets a disposable key and an empty enrollment.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(path.join(root, 'github-app.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fixtureOwnerChanged = true;
  asFixtureOwner(`
    cd /fixture
    chown -R 0:0 repos git-socket git-state enrollment.json github-app.pem
    chmod 0750 repos git-socket
    chmod 0770 repos/fictional
    chmod 0660 repos/fictional/README.md
    chmod 0640 enrollment.json
    chown 10002:0 serve-socket
  `);

  compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '60', '--no-deps', 'web');
  checkIsolation('web', webMounts);
  inWeb(`
    assert.equal(fs.existsSync('/app/sample-repos'), false);
    assert.equal(fs.existsSync('/app/repos/fictional/.git'), false);
    assert.equal(fs.existsSync('/run/secrets/focuswiki-github-app.pem'), false);
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = net.connect(8088, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    }), { code: 'ECONNREFUSED' });
    for (const url of ['/', '/api/projects', '/api/events', '/healthz', '/embed-sandbox/fictional/unknown']) {
      assert.deepEqual(await api(url, { login: '', status: 401 }), { error: 'identity_required' });
    }
    assert.deepEqual(await api('/healthz'), { ok: true });
    assert.equal((await api('/api/projects')).projects.length, 1);
    const asset = (await api('/')).match(/src="([^"]+\\.js)"/);
    assert.ok(asset, 'Production HTML must reference a compiled client');
    await api(asset[1]);
    assert.deepEqual(await api(route + '/git/propose', { method: 'POST', status: 403 }), { error: 'publisher_required' });
    assert.deepEqual(await api(route + '/git/propose', { method: 'POST', login: publisher, browser: '', status: 403 }), { error: 'csrf_blocked' });
    const doc = await api(route + '/doc?path=README.md');
    const markdown = doc.markdown + '\\nDocker persistence check.\\n';
    await api(route + '/doc', { method: 'PUT', body: { path: 'README.md', markdown, baseRevision: doc.revision } });
    await api(route + '/comments', { method: 'POST', status: 201, body: {
      path: 'README.md', quote: 'Docker persistence check.', body: 'Fictional comment.', author: 'Smoke Test', role: 'bot'
    } });
    await api(route + '/embeds', { method: 'POST', status: 201, body: {
      src: 'embeds/smoke/index.html', source: '<!doctype html><p>Fictional component</p>'
    } });
  `);
  console.log('PASS: web socket access, gated routes, minimal health, built client and writes without Git seeding');

  compose('up', '-d', '--force-recreate', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '60', '--no-deps', 'web');
  inWeb(`
    const doc = await api(route + '/doc?path=README.md');
    assert.match(doc.markdown, /Docker persistence check/);
    assert.equal(doc.comments[0].messages[0].body, 'Fictional comment.');
    const scoped = await api('/embed-sandbox/fictional/embeds/smoke/index.html', { status: 302 });
    assert.ok(scoped.startsWith('/embed-sandbox/fictional/_assets/'));
    assert.match(await api(scoped), /Fictional component/);
    assert.equal(fs.existsSync('/app/repos/fictional/.git'), false);
  `);
  console.log('PASS: recreated web container preserves the document, comment and embed');

  const workerCheck = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', '/usr/bin/test',
    image, '-f', '/app/dist/server/server/gitRunner.js'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.ok(workerCheck.status === 0 || workerCheck.status === 1, workerCheck.stderr || String(workerCheck.error));
  if (workerCheck.status === 0) {
    compose('down');
    asFixtureOwner(`printf '%s\n' '{"projects":[]}' > /fixture/enrollment.json`);
    compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '60');
    checkIsolation('web', webMounts);
    checkIsolation('git-worker', {
      '/app/repos': true,
      '/etc/focuswiki/enrollment.json': false,
      '/run/focuswiki': true,
      '/var/lib/focuswiki-git': true,
      '/run/secrets/focuswiki-github-app.pem': false
    });
    inWeb(`
      assert.deepEqual((await api('/api/projects')).projects, []);
      assert.throws(() => fs.readdirSync('/app/repos/.staging'), { code: 'EACCES' });
      const socket = net.createConnection(process.env.FOCUSWIKI_GIT_SOCKET);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.destroy();
    `);
    console.log('PASS: both services start offline with an empty enrollment and the web can reach the worker socket');
    releaseReady = compose('exec', '-T', 'git-worker', 'node', '--input-type=module', '-e', `
      import fs from 'node:fs';
      const file = '/app/dist/server/server/proposalService.js';
      const service = fs.existsSync(file) ? await import(file) : null;
      console.log(Boolean(service?.enforcesManagedBase === true &&
        typeof service?.reviewProposal === 'function' && typeof service?.publishProposal === 'function' &&
        typeof service?.getRepoToken === 'function'));
    `) === 'true';
    if (!releaseReady) console.log('Publication is pending the managed proposal service.');
  } else {
    const missing = spawnSync('docker', ['run', '--rm', '--network', 'none', image, 'git-worker'], {
      env, encoding: 'utf8', timeout: 30_000
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Git worker module is missing/);
    console.log('PASS: worker startup fails closed until the companion Git worker module is present');
  }
} catch (error) {
  try { console.error(compose('logs', '--no-color')); } catch { /* Compose may not have started. */ }
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
} finally {
  if (fs.existsSync(override)) {
    try { compose('down', '--remove-orphans'); } catch (error) {
      console.error(error.stderr?.toString() || error.message);
      process.exitCode = 1;
    }
  }
  if (fixtureOwnerChanged) {
    try { asFixtureOwner('rm -rf /fixture/repos /fixture/serve-socket /fixture/git-socket /fixture/git-state'); } catch (error) {
      console.error(error.stderr?.toString() || error.message);
      process.exitCode = 1;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
if (!process.exitCode && process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `release-ready=${releaseReady}\n`);
}
