import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHubApp, type HubAppInstance } from '../server/app';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INITIAL_DOC = '# Aurora Handbook\n\nFictional observatory operating notes.\n';

describe('Settings and document browsing', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tmpRoot: string;
  let repoRoot: string;
  let hub: HubAppInstance;
  let server: http.Server;

  beforeAll(async () => {
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
      const cache = [
        path.join(PROJECT_ROOT, '.runtime', 'ms-playwright'),
        '/workspace/wiki-prototype/.runtime/ms-playwright'
      ].find((candidate) => fs.existsSync(candidate));
      if (cache) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    }
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  });

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-modals-'));
    repoRoot = path.join(tmpRoot, 'aurora-handbook');
    fs.mkdirSync(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'README.md'), INITIAL_DOC);
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.name', 'Fictional Test Author'],
      ['config', 'user.email', 'author@example.test'],
      ['add', '-A'],
      ['commit', '-m', 'Initial fictional handbook']
    ]) execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });

    hub = createHubApp({
      projects: [{
        id: 'aurora-handbook', name: 'Aurora Handbook', description: 'Fictional test fixture',
        rootPath: repoRoot, defaultDoc: 'README.md'
      }],
      clientDistDir: path.join(PROJECT_ROOT, 'dist', 'client'),
      enableWatcher: false
    });
    server = http.createServer(hub.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    context.setDefaultTimeout(15000);
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/?project=aurora-handbook&doc=README.md`);
    await page.waitForSelector('.ProseMirror h1');
  });

  afterEach(async () => {
    if (context) await context.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (hub) await hub.close();
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  afterAll(async () => { if (browser) await browser.close(); });

  async function openSettings() {
    await page.locator('.sidebar-settings-btn').click();
    await page.getByRole('dialog', { name: /Settings/ }).waitFor();
  }

  it('opens Settings with keyboard panel navigation, traps Tab, closes with Escape, and restores focus', async () => {
    await openSettings();
    const reading = page.locator('[data-settings-section="reading"]');
    await reading.focus();
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => (document.activeElement as HTMLElement)?.dataset.settingsSection === 'appearance');
    await page.keyboard.press('Enter');
    await page.getByRole('radiogroup', { name: 'Theme mode' }).waitFor();
    expect(await page.locator('[data-settings-section="appearance"]').getAttribute('aria-current')).toBe('page');
    for (let i = 0; i < 18; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await page.locator('.reading-settings-modal').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('sidebar-settings-btn'));
  });

  it('applies explicit Light/Dark themes to the root and actual body surface and follows the system preference', async () => {
    const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await openSettings();
    await page.locator('[data-settings-section="appearance"]').click();
    const theme = page.getByRole('radiogroup', { name: 'Theme mode' });
    await theme.getByRole('radio', { name: 'Dark', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.waitForFunction((light) => getComputedStyle(document.body).backgroundColor !== light, lightBackground);
    const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const channels = darkBackground.match(/\d+/g)!.map(Number);
    expect(channels.slice(0, 3).every((channel) => channel < 40)).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForSelector('.ProseMirror h1');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(darkBackground);
    await openSettings();
    await page.locator('[data-settings-section="appearance"]').click();
    await theme.getByRole('radio', { name: 'Light', exact: true }).click();
    await page.waitForFunction((light) => getComputedStyle(document.body).backgroundColor === light, lightBackground);
    // Explicit Light overrides a dark OS preference; System then adopts it.
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(lightBackground);
    await theme.getByRole('radio', { name: 'System', exact: true }).click();
    await page.waitForFunction((dark) => getComputedStyle(document.body).backgroundColor === dark, darkBackground);
  });

  it('previews every reading size and width on the real reading column and resets defaults without repository writes', async () => {
    await page.locator('.review-sidebar .panel-close-btn').click();
    await openSettings();
    for (const [size, pixels] of [['small', 16], ['large', 20], ['standard', 18]] as const) {
      await page.locator(`[data-pref-group="textSize"][data-pref-value="${size}"]`).click();
      await page.waitForFunction((value) => parseFloat(getComputedStyle(document.querySelector('.prose-container')!).fontSize) === value, pixels);
      expect(await page.locator('.reading-sample-copy').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(pixels);
    }
    for (const [width, pixels] of [['narrow', 640], ['wide', 960], ['standard', 760]] as const) {
      await page.locator(`[data-pref-group="pageWidth"][data-pref-value="${width}"]`).click();
      await page.waitForFunction((value) => Math.abs(document.querySelector('.prose-container')!.getBoundingClientRect().width - value) < 1, pixels);
    }
    await page.locator('[data-pref-group="textSize"][data-pref-value="large"]').click();
    await page.locator('[data-pref-group="pageWidth"][data-pref-value="narrow"]').click();
    await page.locator('.reading-reset-btn').click();
    await page.waitForSelector('.workbench[data-text-size="standard"][data-page-width="standard"]');
    expect(await page.locator('.reading-reset-btn').isDisabled()).toBe(true);
    expect(await page.locator('.prose-container').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(18);
    expect(await page.locator('.prose-container').evaluate((el) => el.getBoundingClientRect().width)).toBe(760);
    expect(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')).toBe(INITIAL_DOC);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })).toBe('');
  });

});
