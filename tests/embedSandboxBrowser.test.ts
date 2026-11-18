import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { createHubApp } from '../server/app.js';

it('runs sibling embed assets in an opaque iframe and on direct navigation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-embed-browser-'));
  const repo = path.join(root, 'repo');
  const client = path.join(root, 'client');
  const entry = '/embed-sandbox/fixture/embeds/orbit/index.html?instance=orbit';
  fs.mkdirSync(path.join(repo, 'embeds/orbit'), { recursive: true });
  fs.mkdirSync(client);
  const hub = createHubApp({
    projects: [{ id: 'fixture', name: 'Fictional Observatory', description: '', rootPath: repo, defaultDoc: 'README.md' }],
    clientDistDir: client,
    enableWatcher: false
  });
  const server = http.createServer(hub.app);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    fs.writeFileSync(path.join(client, 'index.html'), `<iframe sandbox="allow-scripts" src="${entry}"></iframe>`);
    fs.writeFileSync(path.join(repo, 'embeds/orbit/index.html'), `<!doctype html>
      <link rel="stylesheet" href="./styles.css">
      <button>Count moons</button><output></output><img src="./moon.svg" alt="Moon">
      <script src="./classic.js"></script>
      <script type="module" src="./main.mjs"></script>`);
    fs.writeFileSync(path.join(repo, 'embeds/orbit/classic.js'), 'document.body.dataset.classic = "loaded";');
    fs.writeFileSync(path.join(repo, 'embeds/orbit/main.mjs'), `
      import { moons } from '../moons.mjs';
      document.querySelector('button').onclick = () => { document.querySelector('output').value = moons; };
      let storage = 'available';
      try { localStorage.getItem('fictional-fixture'); } catch (error) { storage = error.name; }
      let parentAccess = 'available';
      try { void parent.document; } catch (error) { parentAccess = error.name; }
      const fonts = await document.fonts.load('12px "Fixture Mono"');
      document.body.dataset.status = [self.origin, storage, parentAccess, fonts[0]?.status].join(',');
    `);
    fs.writeFileSync(path.join(repo, 'embeds/moons.mjs'), 'export const moons = 3;');
    fs.writeFileSync(path.join(repo, 'embeds/orbit/styles.css'), `
      @font-face { font-family: "Fixture Mono"; src: url("./fixture.woff2"); }
      button { color: rgb(0, 40, 80); font-family: "Fixture Mono"; }
    `);
    fs.copyFileSync(
      path.resolve('node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2'),
      path.join(repo, 'embeds/orbit/fixture.woff2')
    );
    fs.writeFileSync(path.join(repo, 'embeds/orbit/moon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="3"/></svg>');

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage();
    await page.goto(base);
    const frame = page.frameLocator('iframe');
    await frame.locator('body[data-status="null,SecurityError,SecurityError,loaded"]').waitFor();
    expect(await frame.locator('body').getAttribute('data-classic')).toBe('loaded');
    const button = frame.getByRole('button', { name: 'Count moons' });
    expect(await button.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(0, 40, 80)');
    expect(await frame.getByRole('img', { name: 'Moon' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(8);
    await button.click();
    expect(await frame.locator('output').textContent()).toBe('3');

    await page.goto(base + entry);
    await page.locator('body[data-status="null,SecurityError,available,loaded"]').waitFor();
    expect(new URL(page.url()).searchParams.get('instance')).toBe('orbit');
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
