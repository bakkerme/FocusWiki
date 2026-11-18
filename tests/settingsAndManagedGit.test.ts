import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHubApp, type HubAppInstance } from '../server/app';
import type { GitChangeReviewPayload } from '../shared/changeReview';
import type { ProjectSummary } from '../shared/types';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INITIAL_DOC = '# Aurora Handbook\n\nFictional observatory operating notes.\n';

const GIT_API = '**/api/projects/aurora-handbook/git';
const DIFF_API = `${GIT_API}/diff`;
const PROPOSE_API = `${GIT_API}/propose`;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const PULL_REQUEST_URL = 'https://github.example.test/aurora/handbook/pull/17';

describe('Settings and managed Git browser flows', () => {
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
    fs.writeFileSync(path.join(repoRoot, 'guide.md'), '# Fixture guide\n');
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

  it('explains operator enrollment without exposing writable repository or credential settings', async () => {
    const projectRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/')) projectRequests.push(`${request.method()} ${request.url()}`);
    });

    await page.getByRole('button', { name: 'Enrollment', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Settings/ });
    await dialog.getByRole('heading', { name: 'Repository enrollment' }).waitFor();
    expect(await dialog.innerText()).toContain('Managed by your workspace operator');
    expect(await dialog.getByRole('button', { name: /clone|remove|git defaults|git credentials/ }).count()).toBe(0);
    expect(await dialog.locator('input:not([type="search"])').count()).toBe(0);
    expect(projectRequests.filter((request) => /\/api\/(settings\/|projects\/(inspect|import))/.test(request))).toEqual([]);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('project-enrollment-btn'));
  });

  async function editDocument(markdown: string) {
    await page.locator('.btn-edit-entry').click();
    await page.getByRole('button', { name: 'Markdown source', exact: true }).click();
    await page.locator('.markdown-source-editor').fill(markdown);
  }

  async function serveReviewIds() {
    let revision = 0;
    await page.route(DIFF_API, async (route) => {
      const response = await route.fetch();
      const review = (await response.json()) as GitChangeReviewPayload;
      await route.fulfill({
        response,
        json: {
          ...review,
          reviewId: `review-${++revision}`,
          commitScopeNote: 'Protected, unsupported or oversized paths are outside this review.'
        }
      });
    });
  }

  async function openGitReview() {
    await page.locator('.git-status-btn').click();
    const dialog = page.getByRole('dialog', { name: 'Review working changes' });
    await dialog.waitFor();
    return dialog;
  }

  it('flushes pending autosave, publishes only checked files, and retries the same review without editing again', async () => {
    await serveReviewIds();
    const submissions: unknown[] = [];
    const putRequests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/doc')) {
        putRequests.push(request.url());
      }
    });
    await page.route(PROPOSE_API, async (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-focuswiki-intent']).toBe('propose');
      submissions.push(request.postDataJSON());
      if (submissions.length === 1) {
        await route.fulfill({ status: 502, json: { error: 'git_operation_failed' } });
      } else {
        await route.fulfill({ json: { sha: SHA, url: PULL_REQUEST_URL } });
      }
    });
    fs.appendFileSync(path.join(repoRoot, 'guide.md'), '\nSeparate working change.\n');
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    const draft = `${INITIAL_DOC}\nCalibration checked by the fictional crew.\n`;
    await editDocument(draft);

    const dialog = await openGitReview();
    const pathChoice = dialog.getByLabel('Include README.md in proposal', { exact: true });
    const otherChoice = dialog.getByLabel('Include guide.md in proposal', { exact: true });
    await pathChoice.waitFor();
    expect(await dialog.locator('.change-review-title-row').innerText()).toContain('main');
    expect(await dialog.getByRole('button', { name: 'Rich review' }).getAttribute('aria-pressed')).toBe('true');
    await dialog.getByRole('button', { name: 'Raw diff' }).click();
    expect(await dialog.locator('.diff-viewer').innerText()).toContain('+Calibration checked by the fictional crew.');
    expect(await pathChoice.isChecked()).toBe(false);
    expect(await otherChoice.isChecked()).toBe(false);
    expect(await dialog.getByRole('button', { name: /checkout|^pull$|commit/i }).count()).toBe(0);
    expect(submissions).toEqual([]);

    const propose = dialog.getByRole('button', { name: 'Propose changes', exact: true });
    await dialog.getByLabel('Proposal message').fill('  Record fictional calibration  ');
    expect(await propose.isDisabled()).toBe(true);
    await pathChoice.check();
    await propose.click();
    await dialog.getByRole('alert').filter({ hasText: 'Your files are saved locally' }).waitFor();
    expect(await pathChoice.isChecked()).toBe(true);
    expect(await dialog.getByLabel('Proposal message').inputValue()).toBe('  Record fictional calibration  ');
    await dialog.getByRole('button', { name: 'Retry proposal', exact: true }).click();

    const link = dialog.getByRole('link', { name: 'Open pull request' });
    await link.waitFor();
    expect(await link.getAttribute('href')).toBe(PULL_REQUEST_URL);
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(await dialog.getByRole('status').innerText()).toContain(`Pull request published for ${SHA}`);
    const expected = { reviewId: 'review-1', message: 'Record fictional calibration', paths: ['README.md'] };
    expect(submissions).toEqual([expected, expected]);
    expect(putRequests).toHaveLength(1);
    expect(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')).toBe(draft);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })).toBe(headBefore);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(await page.locator('.markdown-source-editor').inputValue()).toBe(draft);
  });

  it('requires a fresh GET and a new explicit selection when the review is stale', async () => {
    await serveReviewIds();
    const submissions: unknown[] = [];
    await page.route(PROPOSE_API, async (route) => {
      submissions.push(route.request().postDataJSON());
      await route.fulfill(submissions.length === 1
        ? { status: 409, json: { error: 'proposal_conflict' } }
        : { json: { sha: SHA, url: PULL_REQUEST_URL } });
    });
    fs.appendFileSync(path.join(repoRoot, 'README.md'), '\nDraft paragraph.\n');

    const dialog = await openGitReview();
    const choose = dialog.getByLabel('Include README.md in proposal', { exact: true });
    const message = dialog.getByLabel('Proposal message');
    const propose = dialog.getByRole('button', { name: 'Propose changes', exact: true });
    await choose.check();
    expect(await propose.isDisabled()).toBe(true);
    await message.fill('Update fictional notes');
    await propose.click();
    await dialog.getByRole('alert').filter({ hasText: 'This review is stale' }).waitFor();
    expect(await propose.count()).toBe(0);
    expect(await dialog.getByRole('button', { name: 'Retry proposal' }).count()).toBe(0);

    fs.appendFileSync(path.join(repoRoot, 'README.md'), '\nExternal revision.\n');
    await dialog.getByRole('button', { name: 'New review' }).click();
    await choose.waitFor();
    expect(await choose.isChecked()).toBe(false);
    expect(await message.inputValue()).toBe('Update fictional notes');
    expect(await propose.isDisabled()).toBe(true);
    await dialog.getByRole('button', { name: 'Raw diff' }).click();
    expect(await dialog.locator('.diff-viewer').innerText()).toContain('+External revision.');
    await choose.check();
    await propose.click();
    await dialog.getByRole('link', { name: 'Open pull request' }).waitFor();
    expect(submissions).toEqual(['review-1', 'review-2'].map((reviewId) => ({
      reviewId, message: 'Update fictional notes', paths: ['README.md']
    })));
  });

  it('keeps the document conflict visible instead of reviewing an unsaved conflicting draft', async () => {
    // A disk update made after opening the document leaves the browser's revision stale.
    const diskVersion = `${INITIAL_DOC}\nIndependent fictional disk change.\n`;
    fs.writeFileSync(path.join(repoRoot, 'README.md'), diskVersion);
    let reviewRequests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/git/diff')) reviewRequests++;
    });
    await editDocument(`${INITIAL_DOC}\nConflicting fictional browser change.\n`);
    await page.locator('.git-status-btn').click();
    await page.getByRole('dialog', { name: /External file edit detected/i }).waitFor();
    expect(await page.getByRole('dialog', { name: 'Review working changes' }).count()).toBe(0);
    expect(reviewRequests).toBe(0);
    expect(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')).toBe(diskVersion);
  });

  it('allows legacy diff inspection without assuming managed publishing is available', async () => {
    fs.appendFileSync(path.join(repoRoot, 'README.md'), '\nSaved local change.\n');
    const dialog = await openGitReview();
    await dialog.getByText('Managed Git status unconfirmed', { exact: false }).waitFor();
    await dialog.getByText('Ask your workspace operator to enable publishing.', { exact: false }).waitFor();
    expect(await dialog.getByRole('checkbox').count()).toBe(0);
    expect(await dialog.getByRole('button', { name: 'Propose changes' }).count()).toBe(0);
  });

  it.each(['pending', 'unavailable', 'unmanaged'] as const)('shows managed state %s without claiming a clean working tree', async (state) => {
    await page.route('**/api/projects', async (route) => {
      const response = await route.fetch();
      const { projects } = (await response.json()) as { projects: ProjectSummary[] };
      await route.fulfill({
        response,
        json: {
          projects: projects.map((project) => ({
            ...project, git: { ...project.git, state, isClean: null, changedFiles: [] }
          }))
        }
      });
    });
    const label = `Managed Git ${state === 'unmanaged' ? 'not enabled' : state}`;
    await page.reload();
    const trigger = page.getByRole('button', { name: new RegExp(label) });
    await trigger.waitFor();
    expect(await trigger.getAttribute('class')).not.toMatch(/is-clean|dirty/);
    await page.route(DIFF_API, (route) => route.fulfill({
      status: state === 'unmanaged' ? 404 : 503,
      json: { error: 'git_unavailable' }
    }));
    const dialog = await openGitReview();
    await dialog.getByRole('alert').waitFor();
    expect(await dialog.locator('.change-review-status').innerText()).toBe(label);
    expect(await dialog.getByRole('button', { name: 'Propose changes' }).count()).toBe(0);
  });

  it('shows an unavailable working copy as pending setup instead of an empty editable repository', async () => {
    await page.route('**/api/projects', async (route) => {
      const response = await route.fetch();
      const { projects } = (await response.json()) as { projects: ProjectSummary[] };
      await route.fulfill({
        response,
        json: {
          projects: projects.map((project) => ({
            ...project,
            workingTreeAvailable: false,
            docs: [],
            git: { ...project.git, state: 'pending', isClean: null }
          }))
        }
      });
    });
    await page.reload();
    await page.getByRole('heading', { name: 'Working copy unavailable' }).waitFor();
    expect(await page.getByRole('button', { name: 'Create README.md' }).count()).toBe(0);
    await page.getByRole('button', { name: /Managed Git pending/ }).waitFor();
  });

  it.each([
    ['phone portrait', { width: 390, height: 844 }],
    ['short landscape', { width: 844, height: 390 }]
  ] as const)('keeps the reviewed files and proposal controls usable in %s', async (_name, viewport) => {
    await serveReviewIds();
    fs.appendFileSync(path.join(repoRoot, 'README.md'), '\nDraft paragraph.\n');
    await page.setViewportSize(viewport);
    const dialog = await openGitReview();
    const choose = dialog.getByLabel('Include README.md in proposal');
    await choose.check();
    await dialog.getByLabel('Proposal message').fill('Update fictional notes');
    const propose = dialog.getByRole('button', { name: 'Propose changes' });
    expect(await propose.isEnabled()).toBe(true);
    const buttonBox = (await propose.boundingBox())!;
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(viewport.width);
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(viewport.height);
    await dialog.getByRole('button', { name: 'Raw diff' }).click();
    expect(await dialog.locator('.diff-viewer').innerText()).toContain('+Draft paragraph.');
    expect(await dialog.locator('.change-detail-scroll').evaluate((pane) => pane.clientHeight)).toBeGreaterThan(40);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('git-status-btn'));
  });

  it.each(['javascript:alert(1)', 'https://name:secret@github.example.test/aurora/pull/17'])(
    'does not turn a returned unsafe URL into a link (%s)',
    async (url) => {
      await serveReviewIds();
      await page.route(PROPOSE_API, (route) => route.fulfill({ json: { sha: SHA, url } }));
      fs.appendFileSync(path.join(repoRoot, 'README.md'), '\nDraft paragraph.\n');
      const dialog = await openGitReview();
      await dialog.getByLabel('Include README.md in proposal').check();
      await dialog.getByLabel('Proposal message').fill('Update fictional notes');
      await dialog.getByRole('button', { name: 'Propose changes' }).click();
      await dialog.getByText('The server returned no usable link.', { exact: false }).waitFor();
      expect(await dialog.getByRole('link').count()).toBe(0);
    }
  );
});
