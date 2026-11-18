import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHubApp, type HubAppInstance } from '../server/app';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(PROJECT_ROOT, 'dist', 'client');
const SEEDS_CINDERVAULT = path.join(PROJECT_ROOT, 'seeds', 'cindervault-rpg');
const SEEDS_HELIOS = path.join(PROJECT_ROOT, 'seeds', 'helios-lab');

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function initGitRepo(repoDir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test Author'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@focuswiki.local'], { cwd: repoDir });
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial fixture'], { cwd: repoDir });
}

describe('Council UI Design & Responsive IA Pass — Interactive Browser Verification', () => {
  let tmpRoot = '';
  let repoRoot = '';
  let heliosRoot = '';
  let hub: HubAppInstance | null = null;
  let server: http.Server | null = null;
  let baseUrl = '';
  let browser: import('playwright').Browser | null = null;

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

  // Every test gets fresh repositories, sidecars, Git history, and server state.
  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-ui-pass-test-'));
    repoRoot = path.join(tmpRoot, 'cindervault-rpg');
    heliosRoot = path.join(tmpRoot, 'helios-lab');
    copyDirRecursive(SEEDS_CINDERVAULT, repoRoot);
    copyDirRecursive(SEEDS_HELIOS, heliosRoot);

    initGitRepo(repoRoot);
    initGitRepo(heliosRoot);

    hub = createHubApp({
      projects: [
        {
          id: 'cindervault-rpg',
          name: 'Cindervault RPG',
          description: 'Fixture repository for UI pass tests',
          rootPath: repoRoot,
          defaultDoc: 'docs/vault-breach-action.md'
        },
        {
          id: 'helios-lab',
          name: 'Helios Lab',
          description: 'Synthetic bench runbook fixture',
          rootPath: heliosRoot,
          defaultDoc: 'docs/bench-inventory.md'
        }
      ],
      clientDistDir: CLIENT_DIST,
      enableWatcher: false
    });

    server = http.createServer(hub.app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (browser) await browser.close();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (hub) await hub.close();
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('opens in clean Read mode IA by default, hides authoring chrome & save noise, and supports prose selection commenting + reply/resolve/reopen', async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md`);
      await page.waitForSelector('.workbench[data-workspace-mode="read"]');
      await page.waitForSelector('.ProseMirror h1');

      // Deliberate IA checks: page eyebrow carries provenance above H1; Read header omits noisy Saved badge; nav omits stacked raw paths
      expect(await page.locator('.doc-page-eyebrow').textContent()).toContain('Cindervault RPG');
      expect(await page.locator('.doc-page-eyebrow').textContent()).toContain('docs/vault-breach-action.md');
      expect(await page.locator('.repo-topbar .save-badge').count()).toBe(0);
      expect(await page.getAttribute('.workbench', 'data-save-state')).toBe('saved');
      expect(await page.locator('.nav-sidebar .doc-item').count()).toBeGreaterThanOrEqual(4);
      expect(await page.locator('.nav-sidebar .doc-item .doc-item-path').count()).toBe(0);

      // Formatting toolbar and embed arrangement buttons are hidden in Read mode
      expect(await page.locator('.editor-toolbar').count()).toBe(0);
      expect(await page.locator('.embed-frame-wrapper.is-read-mode').count()).toBeGreaterThan(0);
      expect(await page.locator('.embed-frame-wrapper button:has-text("Move up")').count()).toBe(0);
      expect(await page.locator('.embed-frame-wrapper button:has-text("Remove")').count()).toBe(0);

      // Existing open thread starts as a compact summary card (no open reply input until selected)
      expect(await page.locator('.review-sidebar .thread-card.is-compact').count()).toBe(1);
      expect(await page.locator('.review-sidebar .thread-reply-row').count()).toBe(0);

      // Select prose directly in Read mode and trigger floating Comment action
      await page.evaluate(() => {
        const paragraphs = Array.from(document.querySelectorAll('.ProseMirror p'));
        const targetP = paragraphs.find((p) =>
          (p.textContent || '').includes('Lantern Oil')
        );
        if (!targetP || !targetP.firstChild) throw new Error('Target paragraph not found');
        const textNode = Array.from(targetP.childNodes).find(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim().length > 12
        );
        if (!textNode) throw new Error('Text node not found');
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(22, (textNode.textContent || '').length));
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });

      const commentChip = page.locator('.selection-comment-popover');
      await commentChip.waitFor({ state: 'visible', timeout: 15000 });
      await commentChip.click();

      // Composer opens in Review rail while still in Read mode
      expect(await page.getAttribute('.workbench', 'data-workspace-mode')).toBe('read');
      const composerTa = page.locator('.composer-box textarea');
      await composerTa.waitFor({ state: 'visible' });
      await composerTa.fill('Reader feedback added directly from Read mode.');
      await page.locator('.composer-box button[type="submit"]').click();

      // Newly created thread becomes active & expanded, persisted to .comments.json
      await page.waitForSelector('.thread-card.active.is-expanded:has-text("Reader feedback added directly from Read mode.")');
      expect(await page.getAttribute('.workbench', 'data-workspace-mode')).toBe('read');

      // Reply to active thread
      const replyInput = page.locator('.thread-card.active .thread-reply-row input');
      await replyInput.fill('Follow-up reply in focused card.');
      await page.locator('.thread-card.active .thread-reply-row button:has-text("Reply")').click();
      await page.waitForSelector('.thread-card.active .msg-item:has-text("Follow-up reply in focused card.")');

      // Resolve thread, toggle Show resolved, verify distinct resolved prose highlight + reopen
      await page.locator('.thread-card.active button:has-text("Resolve")').click();
      const showResolvedCb = page.locator('.review-sidebar input[type="checkbox"]');
      await showResolvedCb.check();
      await page.waitForSelector('.focus-comment-highlight.is-resolved');
      expect(await page.locator('.focus-comment-highlight.is-open').count()).toBeGreaterThan(0);

      // Reopen resolved thread from compact summary button
      await page.locator('.thread-card.is-resolved button:has-text("Reopen")').first().click();
      await page.waitForFunction(
        () => document.querySelectorAll('.focus-comment-highlight.is-open').length >= 2
      );
    } finally {
      await context.close();
    }
  });

  it('sizes sandboxed embeds dynamically to content height and provides a fallback for non-resizing custom embeds', async () => {
    const customEmbedPath = path.join(repoRoot, 'embeds', 'static-card', 'index.html');
    fs.mkdirSync(path.dirname(customEmbedPath), { recursive: true });
    fs.writeFileSync(
      customEmbedPath,
      '<!doctype html><html><body style="margin:0;padding:16px;font-family:sans-serif"><h4>Static Custom Widget</h4><p>No postMessage resize call.</p></body></html>',
      'utf8'
    );

    const staticDocPath = path.join(repoRoot, 'docs', 'static-embed-check.md');
    fs.writeFileSync(
      staticDocPath,
      '# Static Embed Fallback Check\n\n```embed\nsrc: embeds/static-card/index.html\ntitle: Static Card\nheight: 240\nprops: {}\n```\n',
      'utf8'
    );

    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md`);
      await page.waitForSelector('.embed-frame-wrapper[data-sizing-mode="auto"]');

      const firstIframe = page.locator('iframe.embed-sandbox-iframe').first();
      const boxDesktop = await firstIframe.boundingBox();
      expect(boxDesktop).not.toBeNull();
      expect(boxDesktop!.height).toBeGreaterThanOrEqual(210);
      expect(boxDesktop!.height).toBeLessThan(355);

      const childFrame = await (await firstIframe.elementHandle())!.contentFrame();
      expect(childFrame).not.toBeNull();
      await childFrame!.locator('button.trigger-btn').first().click();
      await childFrame!.waitForSelector('#stateTitle:has-text("Stakes Locked")');

      await page.setViewportSize({ width: 520, height: 900 });
      await page.waitForFunction(
        (prevH) => {
          const el = document.querySelector('iframe.embed-sandbox-iframe');
          return Boolean(el && el.getBoundingClientRect().height > prevH + 60);
        },
        boxDesktop!.height
      );

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=docs%2Fstatic-embed-check.md`);
      await page.waitForSelector('.embed-frame-wrapper[data-sizing-mode="fallback"]');
      const staticBox = await page.locator('iframe.embed-sandbox-iframe').first().boundingBox();
      expect(staticBox!.height).toBe(240);

      await page.locator('button[aria-label="Expand frame height"]').click();
      const expandedBox = await page.locator('iframe.embed-sandbox-iframe').first().boundingBox();
      expect(expandedBox!.height).toBeGreaterThanOrEqual(560);
    } finally {
      await context.close();
    }
  });

  it('supports explicit Visual Editor, full-workspace Markdown Source, autosave round-trip, and external conflict recovery', async () => {
    const docRel = 'docs/roundtrip-edit-test.md';
    const docAbs = path.join(repoRoot, docRel);
    fs.writeFileSync(
      docAbs,
      '# Roundtrip Edit Check\n\nInitial paragraph for editing.\n\n| Col A | Col B |\n| :--- | :--- |\n| Alpha | Beta |\n',
      'utf8'
    );

    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=${encodeURIComponent(docRel)}`);
      await page.waitForSelector('.workbench[data-workspace-mode="read"]');

      await page.locator('.btn-edit-entry').click();
      await page.waitForSelector('.workbench[data-workspace-mode="visual"]');
      await page.waitForSelector('.editor-toolbar');
      await page.waitForSelector('.save-badge.saved');

      await page.locator('.mode-switch button:has-text("Markdown source")').click();
      await page.waitForSelector('.workbench[data-workspace-mode="source"]');
      expect(await page.locator('.review-sidebar').count()).toBe(0);

      const sourceBox = await page.locator('textarea.markdown-source-editor').boundingBox();
      expect(sourceBox!.width).toBeGreaterThan(1000);
      expect(sourceBox!.height).toBeGreaterThan(700);

      const ta = page.locator('textarea.markdown-source-editor');
      const existing = await ta.inputValue();
      const roundtripSave = page.waitForResponse((response) =>
        response.url().includes('/api/projects/cindervault-rpg/doc') && response.request().method() === 'PUT' && response.ok());
      await ta.fill(existing.replace('Initial paragraph for editing.', 'Updated in full-workspace source mode.'));
      await roundtripSave;
      await page.waitForFunction(
        () => document.querySelector('.save-badge.saved') !== null,
        undefined,
        { timeout: 15000 }
      );
      expect(fs.readFileSync(docAbs, 'utf8')).toContain('Updated in full-workspace source mode.');

      await page.locator('.btn-done-editing').click();
      await page.waitForSelector('.workbench[data-workspace-mode="read"]');
      expect(await page.locator('.ProseMirror').textContent()).toContain(
        'Updated in full-workspace source mode.'
      );

      await page.locator('.btn-edit-entry').click();
      await page.locator('.mode-switch button:has-text("Markdown source")').click();
      await page.waitForSelector('textarea.markdown-source-editor');

      fs.writeFileSync(
        docAbs,
        '# Roundtrip Edit Check\n\nConcurrent bot change on disk.\n',
        'utf8'
      );

      await page.locator('textarea.markdown-source-editor').fill(
        '# Roundtrip Edit Check\n\nConcurrent browser draft.\n'
      );
      await page.waitForSelector('.save-badge.conflict', { timeout: 15000 });
      expect(await page.locator('.modal-panel:has-text("External File Edit Detected")').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('keeps Edit + Review adjacent without wrapping across portrait, short landscape, above-880px, and desktop, and supports desktop panel collapsing', async () => {
    const viewports = [
      { width: 390, height: 844, expectOverlay: true, minProseWidth: 320 },
      { width: 768, height: 960, expectOverlay: true, minProseWidth: 620 },
      { width: 844, height: 390, expectOverlay: true, minProseWidth: 640 },
      { width: 956, height: 440, expectOverlay: true, minProseWidth: 640 },
      { width: 920, height: 700, expectOverlay: true, minProseWidth: 640 },
      { width: 1180, height: 820, expectOverlay: false, minProseWidth: 640 },
      { width: 1440, height: 900, expectOverlay: false, minProseWidth: 640 }
    ];

    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md`);
      await page.waitForSelector('.ProseMirror h1');

      // Verify desktop panel collapsibility on 1440x900: close both Docs and Review, then reopen
      expect(await page.locator('.nav-sidebar').isVisible()).toBe(true);
      expect(await page.locator('.review-sidebar').isVisible()).toBe(true);
      await page.locator('.nav-sidebar .panel-close-btn').click();
      await page.waitForFunction(() => !document.querySelector('.nav-sidebar'));
      await page.locator('.review-sidebar .panel-close-btn').click();
      await page.waitForFunction(() => !document.querySelector('.review-sidebar'));

      // Reopen both on wide desktop
      await page.locator('.nav-toggle-btn').click();
      await page.waitForSelector('.nav-sidebar');
      await page.locator('.review-toggle-btn').click();
      await page.waitForSelector('.review-sidebar');

      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        const tier = await page.getAttribute('.workbench', 'data-layout-tier');
        if (vp.expectOverlay) {
          expect(tier).toBe('overlay');
        } else {
          expect(['medium-desktop', 'wide-desktop']).toContain(tier);
        }

        const editBox = await page.locator('.btn-edit-entry').boundingBox();
        const reviewBox = await page.locator('.review-toggle-btn').boundingBox();
        const proseBox = await page.locator('.prose-container').boundingBox();
        expect(editBox).not.toBeNull();
        expect(reviewBox).not.toBeNull();
        expect(proseBox).not.toBeNull();

        // Non-wrapping side-by-side action pair
        expect(Math.abs(editBox!.y - reviewBox!.y)).toBeLessThanOrEqual(2);
        expect(reviewBox!.x).toBeGreaterThanOrEqual(editBox!.x + editBox!.width - 1);

        if (vp.expectOverlay) {
          expect(editBox!.height).toBeGreaterThanOrEqual(34);
          expect(reviewBox!.height).toBeGreaterThanOrEqual(34);
        }

        // Generous reading column width (never dual-sidebar squeezed)
        expect(proseBox!.width).toBeGreaterThanOrEqual(vp.minProseWidth);
        expect(proseBox!.x).toBeGreaterThanOrEqual(12);

        // Zero document horizontal overflow
        const overflowX = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        );
        expect(overflowX).toBeLessThanOrEqual(1);
      }
    } finally {
      await context.close();
    }
  });

  it('uses native root scrolling, locks background & traps focus in modal drawers, and preserves drafts + scroll across dismiss and portrait->landscape rotation', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md`);
      await page.waitForSelector('.ProseMirror h1');

      // 1. Native root document scrolling advances window.scrollY
      await page.evaluate(() => window.scrollTo(0, 260));
      await page.waitForFunction(() => Math.round(window.scrollY) >= 240);
      const savedScrollY = await page.evaluate(() => Math.round(window.scrollY));

      // 2. Select visible prose and open modal Review drawer via floating Comment pill
      await page.evaluate(() => {
        const blocks = Array.from(document.querySelectorAll('.ProseMirror p, .ProseMirror td, .ProseMirror li'));
        const visibleBlock =
          blocks.find((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 72 && r.bottom <= window.innerHeight - 40 && (el.textContent || '').trim().length > 14;
          }) || blocks[0];
        const walker = document.createTreeWalker(visibleBlock, NodeFilter.SHOW_TEXT);
        let textNode: Node | null = null;
        let cur = walker.nextNode();
        while (cur) {
          if ((cur.textContent || '').trim().length > 10) {
            textNode = cur;
            break;
          }
          cur = walker.nextNode();
        }
        if (!textNode) throw new Error('Text node missing');
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(16, (textNode.textContent || '').length));
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });

      await page.locator('.selection-comment-popover').click();
      await page.waitForSelector('.review-sidebar.is-overlay-open[role="dialog"][aria-modal="true"]');

      // Background stage is inert and body scroll is locked
      expect(await page.evaluate(() => document.querySelector('main.document-stage')?.hasAttribute('inert'))).toBe(true);
      expect(await page.evaluate(() => window.getComputedStyle(document.body).position)).toBe('fixed');

      // Type a draft comment without submitting
      const draftNote = 'Preserve this mobile draft across dismiss and rotation.';
      const composerTa = page.locator('.review-sidebar .composer-textarea');
      await composerTa.waitFor({ state: 'visible' });
      await composerTa.fill(draftNote);

      // Focus trap keeps Tab cycling inside .review-sidebar
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        const insideDrawer = await page.evaluate(() =>
          Boolean(document.activeElement?.closest('.review-sidebar'))
        );
        expect(insideDrawer).toBe(true);
      }

      // Escape dismisses drawer, unlocks body, restores exact scrollY, and returns focus to Review toggle
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.review-sidebar.is-overlay-open'));
      expect(await page.evaluate(() => document.querySelector('main.document-stage')?.hasAttribute('inert'))).toBe(false);
      expect(await page.evaluate(() => window.getComputedStyle(document.body).position)).not.toBe('fixed');
      const restoredScrollY = await page.evaluate(() => Math.round(window.scrollY));
      expect(Math.abs(restoredScrollY - savedScrollY)).toBeLessThanOrEqual(2);
      expect(
        await page.evaluate(() => document.activeElement?.classList.contains('review-toggle-btn'))
      ).toBe(true);

      // Rotate 390x844 -> 844x390 -> 956x440 and verify draft + unclipped left edge survive
      await page.setViewportSize({ width: 844, height: 390 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
      expect((await page.locator('.prose-container').boundingBox())!.x).toBeGreaterThanOrEqual(12);

      await page.setViewportSize({ width: 956, height: 440 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.locator('.review-toggle-btn').click();
      await page.waitForSelector('.review-sidebar.is-overlay-open');
      expect(await page.locator('.review-sidebar .composer-textarea').inputValue()).toBe(draftNote);

      // Backdrop click dismisses Review drawer; opening Docs and picking a document auto-closes Docs
      await page.locator('.drawer-backdrop').click({ position: { x: 24, y: 200 } });
      await page.waitForFunction(() => !document.querySelector('.review-sidebar.is-overlay-open'));

      await page.locator('.nav-toggle-btn').click();
      await page.waitForSelector('.nav-sidebar.is-overlay-open[role="dialog"]');
      await page.locator('.nav-sidebar .doc-item:not(.active)').first().click();
      await page.waitForFunction(() => !document.querySelector('.nav-sidebar.is-overlay-open'));
    } finally {
      await context.close();
    }
  });

  it('scopes horizontal scrolling strictly to wide tables (.tableWrapper) and <pre> blocks without clipping prose left edges on helios-lab bench-inventory.md', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=helios-lab&doc=docs%2Fbench-inventory.md`);
      await page.waitForSelector('.ProseMirror .tableWrapper table');

      for (const vp of [
        { width: 390, height: 844 },
        { width: 844, height: 390 }
      ]) {
        await page.setViewportSize(vp);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        const metrics = await page.evaluate(() => {
          const wrapper = document.querySelector('.ProseMirror .tableWrapper') as HTMLElement | null;
          if (!wrapper) throw new Error('Missing .tableWrapper');
          wrapper.scrollLeft = 80;
          const h1 = document.querySelector('.ProseMirror h1') as HTMLElement | null;
          const bq = document.querySelector('.ProseMirror blockquote') as HTMLElement | null;
          const p = document.querySelector('.ProseMirror > p') as HTMLElement | null;
          return {
            docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
            windowScrollX: window.scrollX,
            tableScrollWidth: wrapper.scrollWidth,
            tableClientWidth: wrapper.clientWidth,
            tableScrollLeft: wrapper.scrollLeft,
            h1Left: h1 ? h1.getBoundingClientRect().left : -1,
            bqLeft: bq ? bq.getBoundingClientRect().left : -1,
            pLeft: p ? p.getBoundingClientRect().left : -1
          };
        });

        expect(metrics.docOverflowX).toBeLessThanOrEqual(1);
        expect(metrics.windowScrollX).toBe(0);
        if (vp.width === 390) {
          expect(metrics.tableScrollWidth).toBeGreaterThan(metrics.tableClientWidth + 40);
          expect(metrics.tableScrollLeft).toBeGreaterThan(40);
        }
        expect(metrics.h1Left).toBeGreaterThanOrEqual(12);
        expect(metrics.bqLeft).toBeGreaterThanOrEqual(12);
        expect(metrics.pLeft).toBeGreaterThanOrEqual(12);
      }
    } finally {
      await context.close();
    }
  });

  it('centers the constrained reading column horizontally inside main.document-stage when Review is closed (with Docs open or closed)', async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md`);
      await page.waitForSelector('.ProseMirror h1');

      // 1. Close Review while keeping left Docs navigation open
      await page.locator('.review-sidebar .panel-close-btn').click();
      await page.waitForFunction(() => !document.querySelector('.review-sidebar'));

      const navOpenGeom = await page.evaluate(() => {
        const nav = document.querySelector('.nav-sidebar')!.getBoundingClientRect();
        const stage = document.querySelector('main.document-stage')!.getBoundingClientRect();
        const prose = document.querySelector('.prose-container')!.getBoundingClientRect();
        return {
          navRight: nav.right,
          stageLeft: stage.left,
          stageRight: stage.right,
          proseLeft: prose.left,
          proseRight: prose.right,
          proseWidth: prose.width
        };
      });

      // Stage starts immediately to the right of Docs nav (not underneath nav)
      expect(Math.abs(navOpenGeom.stageLeft - navOpenGeom.navRight)).toBeLessThanOrEqual(1);
      expect(navOpenGeom.stageLeft).toBeGreaterThanOrEqual(240);
      // Symmetric horizontal gutters inside available document stage
      const leftGutterNavOpen = navOpenGeom.proseLeft - navOpenGeom.stageLeft;
      const rightGutterNavOpen = navOpenGeom.stageRight - navOpenGeom.proseRight;
      expect(Math.abs(leftGutterNavOpen - rightGutterNavOpen)).toBeLessThanOrEqual(2);
      expect(leftGutterNavOpen).toBeGreaterThan(100);
      // Constrained reading line length preserved (Standard 760px)
      expect(navOpenGeom.proseWidth).toBeLessThanOrEqual(765);
      expect(navOpenGeom.proseWidth).toBeGreaterThanOrEqual(600);

      // 2. Also close Docs navigation -> centers symmetrically across full-width stage
      await page.locator('.nav-sidebar .panel-close-btn').click();
      await page.waitForFunction(() => !document.querySelector('.nav-sidebar'));

      const bothClosedGeom = await page.evaluate(() => {
        const stage = document.querySelector('main.document-stage')!.getBoundingClientRect();
        const prose = document.querySelector('.prose-container')!.getBoundingClientRect();
        return {
          stageLeft: stage.left,
          stageRight: stage.right,
          proseLeft: prose.left,
          proseRight: prose.right,
          proseWidth: prose.width
        };
      });

      expect(bothClosedGeom.stageLeft).toBe(0);
      const leftGutterBothClosed = bothClosedGeom.proseLeft - bothClosedGeom.stageLeft;
      const rightGutterBothClosed = bothClosedGeom.stageRight - bothClosedGeom.proseRight;
      expect(Math.abs(leftGutterBothClosed - rightGutterBothClosed)).toBeLessThanOrEqual(2);
      expect(bothClosedGeom.proseWidth).toBeLessThanOrEqual(765);
    } finally {
      await context.close();
    }
  });

  it('handles edit-session Done + Revert atomically across Visual/Source switches, pre-existing uncommitted baseline, autosave races, save errors, and external conflicts', async () => {
    const docRel = 'docs/session-revert-fixture.md';
    const docAbs = path.join(repoRoot, docRel);
    const unrelatedRel = 'docs/unrelated-working-file.md';
    const unrelatedAbs = path.join(repoRoot, unrelatedRel);

    const headContent = '# Session Revert Fixture\n\nCommitted base paragraph for anchor.\n';
    fs.writeFileSync(docAbs, headContent, 'utf8');
    execFileSync('git', ['add', docRel], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'Add session revert fixture'], { cwd: repoRoot });

    // Pre-existing uncommitted edit on disk BEFORE entering Edit (must NOT be discarded by Revert)
    const preExistingUncommitted =
      '# Session Revert Fixture\n\nCommitted base paragraph for anchor. Pre-existing uncommitted sentence.\n';
    fs.writeFileSync(docAbs, preExistingUncommitted, 'utf8');
    fs.writeFileSync(unrelatedAbs, '# Unrelated Dirty File\n\nKeep me untouched.\n', 'utf8');

    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=${encodeURIComponent(docRel)}`);
      await page.waitForSelector('.workbench[data-workspace-mode="read"]');

      // Enter Edit -> Revert starts disabled (no session changes yet), Done is enabled
      await page.locator('.btn-edit-entry').click();
      await page.waitForSelector('.workbench[data-workspace-mode="visual"]');
      expect(await page.locator('.btn-revert-session').isDisabled()).toBe(true);
      expect(await page.locator('.btn-done-editing').isDisabled()).toBe(false);

      // Edit in Visual mode and wait for autosave to write to disk
      await page.locator('.ProseMirror p').first().click();
      await page.keyboard.press('End');
      const visualSave = page.waitForResponse((response) =>
        response.url().includes('/api/projects/cindervault-rpg/doc') && response.request().method() === 'PUT' && response.ok());
      await page.keyboard.insertText(' Visual session edit.');
      await visualSave;
      await page.waitForFunction(() => {
        const btn = document.querySelector('.btn-revert-session') as HTMLButtonElement | null;
        return Boolean(btn && !btn.disabled && document.querySelector('.save-badge.saved'));
      });
      expect(fs.readFileSync(docAbs, 'utf8')).toContain('Visual session edit.');

      // Post a comment during the session (must be retained after Revert)
      await fetch(`${baseUrl}/api/projects/cindervault-rpg/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: docRel,
          quote: 'Committed base paragraph for anchor.',
          author: 'Session Reviewer',
          role: 'human',
          body: 'Comment created during edit session.'
        })
      });

      // Switch to Markdown source -> baseline from initial Edit entry must remain intact
      await page.locator('.mode-switch button:has-text("Markdown source")').click();
      await page.waitForSelector('textarea.markdown-source-editor');
      expect(await page.locator('.btn-revert-session').isDisabled()).toBe(false);

      const ta = page.locator('textarea.markdown-source-editor');
      const v2 = await ta.inputValue();
      const sourceSave = page.waitForResponse((response) =>
        response.url().includes('/api/projects/cindervault-rpg/doc') && response.request().method() === 'PUT' && response.ok());
      await ta.fill(`${v2}\n## Source Session Section\n\nAutosaved source paragraph.\n`);
      await sourceSave;
      await page.waitForSelector('.save-badge.saved');
      expect(fs.readFileSync(docAbs, 'utf8')).toContain('Source Session Section');

      // Control browser time so cancelled debounce callbacks can be checked deterministically.
      await page.clock.install();
      // Trigger a pending autosave race and immediately click Revert.
      await ta.fill(`${v2}\n## Raced Draft That Must Never Persist\n`);
      await page.locator('.btn-revert-session').click();
      await page.waitForSelector('.workbench[data-workspace-mode="read"]');

      // Advance beyond the debounce instead of relying on wall-clock scheduling under contention.
      await page.clock.runFor(1000);
      expect(fs.readFileSync(docAbs, 'utf8')).toBe(preExistingUncommitted);
      expect(fs.readFileSync(unrelatedAbs, 'utf8')).toContain('Keep me untouched.');

      // Reload page and confirm baseline + session comment are preserved
      await page.reload();
      await page.waitForSelector('.ProseMirror h1');
      const proseAfterReload = (await page.locator('.ProseMirror').textContent()) || '';
      expect(proseAfterReload).toContain('Pre-existing uncommitted sentence.');
      expect(proseAfterReload).not.toContain('Visual session edit.');
      expect(proseAfterReload).not.toContain('Raced Draft');
      expect(await page.locator('.review-sidebar .thread-card').count()).toBe(1);

      // Test Done save-error guard: fail PUT /doc once -> Done must NOT exit Edit while save failed
      await page.locator('.btn-edit-entry').click();
      await page.locator('.mode-switch button:has-text("Markdown source")').click();
      await page.waitForSelector('textarea.markdown-source-editor');

      let blockSaves = true;
      await page.route('**/api/projects/cindervault-rpg/doc', async (route) => {
        if (blockSaves && route.request().method() === 'PUT') {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'server_error', message: 'Simulated disk error' })
          });
          return;
        }
        await route.continue();
      });

      await page.locator('textarea.markdown-source-editor').fill(
        `${preExistingUncommitted}\nNew paragraph guarded by Done.\n`
      );
      await page.locator('.btn-done-editing').click();
      await page.waitForSelector('.save-badge.conflict:has-text("Save error")');
      // Must stay in source editing mode rather than quietly exiting
      expect(await page.getAttribute('.workbench', 'data-workspace-mode')).toBe('source');

      blockSaves = false;
      await page.unroute('**/api/projects/cindervault-rpg/doc');
      await page.locator('.btn-done-editing').click();
      await page.waitForSelector('.workbench[data-workspace-mode="read"]');
      expect(fs.readFileSync(docAbs, 'utf8')).toContain('New paragraph guarded by Done.');

      // Test external bot edit before Revert -> surfaces 409 Conflict instead of overwriting bot edit
      await page.locator('.btn-edit-entry').click();
      await page.locator('.mode-switch button:has-text("Markdown source")').click();
      await page.waitForSelector('textarea.markdown-source-editor');
      const draftSave = page.waitForResponse((response) =>
        response.url().includes('/api/projects/cindervault-rpg/doc') && response.request().method() === 'PUT' && response.ok());
      await page.locator('textarea.markdown-source-editor').fill(
        `${preExistingUncommitted}\nTemporary draft before external conflict.\n`
      );
      await draftSave;
      await page.waitForSelector('.save-badge.saved');

      const botDiskEdit = `${preExistingUncommitted}\nExternal bot concurrent update on disk.\n`;
      fs.writeFileSync(docAbs, botDiskEdit, 'utf8');

      await page.locator('.btn-revert-session').click();
      await page.waitForSelector('.modal-panel:has-text("External File Edit Detected")');
      expect(await page.getAttribute('.workbench', 'data-workspace-mode')).toBe('source');
      expect(fs.readFileSync(docAbs, 'utf8')).toBe(botDiskEdit);
    } finally {
      await context.close();
    }
  });

  it('renders safe Rich Change Review (prose word diff, formatting-only table separation, comments, code, add/delete) without executing project content', async () => {
    // Use the local checkout to exercise the real rich comparison payload.
    const invPath = path.join(heliosRoot, 'docs', 'bench-inventory.md');
    const origInv = fs.readFileSync(invPath, 'utf8');

    // Pad table pipes (formatting-only) + add real prose sentence + inert raw <script> block
    const modifiedInv = origInv
      .replace(
        'fictional prototype data.',
        'fictional prototype data. Verified on bench B.'
      )
      .replace(
        '| Asset ID | Hostname | Documentation IP | Upstream Dependency | Nominal Draw | Operational Role |',
        '| Asset ID     | Hostname     | Documentation IP | Upstream Dependency | Nominal Draw | Operational Role     |'
      ) + '\n<script>window.__richReviewExecutedScript = true;</script>\n';
    fs.writeFileSync(invPath, modifiedInv, 'utf8');

    // Add a new doc, delete cold-start-runbook.md, modify an embed HTML file, and add a comment reply
    fs.writeFileSync(
      path.join(heliosRoot, 'docs', 'added-calibration.md'),
      '# Added Calibration Spec\n\nNew calibration notes.\n',
      'utf8'
    );
    fs.unlinkSync(path.join(heliosRoot, 'docs', 'cold-start-runbook.md'));
    const seqHtmlPath = path.join(heliosRoot, 'embeds', 'power-sequencer', 'index.html');
    fs.writeFileSync(seqHtmlPath, `${fs.readFileSync(seqHtmlPath, 'utf8')}\n<!-- updated -->\n`, 'utf8');

    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=helios-lab&doc=docs%2Fbench-inventory.md`);
      await page.waitForSelector('.git-status-btn');

      // Add a comment via API so .comments.json is also modified in the working tree
      await fetch(`${baseUrl}/api/projects/helios-lab/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'docs/bench-inventory.md',
          quote: 'ordered PDU rail energization',
          author: 'Lab Lead',
          role: 'human',
          body: 'Confirm 5-second relay delay.'
        })
      });

      await page.locator('.git-status-btn').click();
      await page.waitForSelector('.change-review-modal');
      await page.waitForSelector('.change-file-item');

      // Zero OpenBot / Co-authored-by attribution leak anywhere in UI
      const modalText = (await page.locator('.change-review-modal').textContent()) || '';
      expect(modalText).not.toContain('OpenBot');
      expect(modalText).not.toContain('Co-authored-by');

      // Safe inert rendering: raw <script> never executed and zero iframes mounted in review modal
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__richReviewExecutedScript)).toBeUndefined();
      expect(await page.locator('.change-review-modal iframe').count()).toBe(0);

      // All 5 changed working-tree files are listed (modified .md, .comments.json, added .md, deleted .md, modified .html)
      expect(await page.locator('.change-file-item').count()).toBe(5);

      // Selected bench-inventory.md shows inline word addition AND Formatting only card for padded table
      expect(await page.locator('.rich-token-add').first().textContent()).toContain('Verified on bench B.');
      expect(await page.locator('.rich-change-card.is-formatting-only').count()).toBe(1);

      // Secondary Raw diff toggle works cleanly
      await page.locator('.change-view-switch button:has-text("Raw diff")').click();
      await page.waitForSelector('.change-detail-scroll pre.diff-viewer');
      await page.locator('.change-view-switch button:has-text("Rich review")').click();

      // Inspect .comments.json human-readable review
      await page.locator('.change-file-item:has-text("Review comments")').click();
      await page.waitForSelector('.rich-comments-review');
      expect(await page.locator('.rich-comments-review').textContent()).toContain(
        'Confirm 5-second relay delay.'
      );

      // Inspect .html component code diff fallback
      await page.locator('.change-file-item:has-text("Component · power-sequencer")').click();
      await page.waitForSelector('.rich-code-review');
      expect(await page.locator('.rich-code-fallback-banner').textContent()).toContain(
        'Source code diff (html)'
      );

      // Verify narrow phone layout (390x844) inside Change Review modal without overflow
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const phoneOverflowX = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(phoneOverflowX).toBeLessThanOrEqual(1);

      // A legacy diff without a review ID is available for inspection only.
      expect(await page.getByLabel('Proposal message').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('uses system sans-serif typography on neutral white surfaces and supports Reading settings presets, persistence, invalid-storage recovery, keyboard/focus composition, and draft survival without repo writes', async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md`);
      await page.waitForSelector('.ProseMirror h1');

      const gitStatusBefore = execFileSync('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf8'
      });

      // 1. Visual tokens: neutral white nav/review rails + system sans typography (no Literata / Plus Jakarta Sans)
      const visualCheck = await page.evaluate(() => {
        const nav = document.querySelector('.nav-sidebar')!;
        const rev = document.querySelector('.review-sidebar')!;
        const prose = document.querySelector('.prose-container')!;
        const h1 = document.querySelector('.ProseMirror h1')!;
        const topbarBtn = document.querySelector('.btn-edit-entry')!;
        const codeEl = document.querySelector('.ProseMirror code')!;
        return {
          navBg: getComputedStyle(nav).backgroundColor,
          revBg: getComputedStyle(rev).backgroundColor,
          proseFont: getComputedStyle(prose).fontFamily,
          h1Font: getComputedStyle(h1).fontFamily,
          proseSize: parseFloat(getComputedStyle(prose).fontSize),
          proseMaxWidth: getComputedStyle(document.querySelector('.workbench')!)
            .getPropertyValue('--focus-prose-max-width')
            .trim(),
          proseRectWidth: prose.getBoundingClientRect().width,
          topbarBtnSize: parseFloat(getComputedStyle(topbarBtn).fontSize),
          codeFont: getComputedStyle(codeEl).fontFamily
        };
      });

      expect(visualCheck.navBg).toBe('rgb(255, 255, 255)');
      expect(visualCheck.revBg).toBe('rgb(255, 255, 255)');
      expect(visualCheck.proseFont).not.toContain('Literata');
      expect(visualCheck.proseFont).not.toContain('Plus Jakarta Sans');
      expect(visualCheck.h1Font).not.toContain('Literata');
      expect(visualCheck.codeFont.toLowerCase()).toContain('mono');
      expect(visualCheck.proseSize).toBeCloseTo(18, 1);
      expect(visualCheck.proseMaxWidth).toBe('760px');
      expect(visualCheck.proseRectWidth).toBeLessThanOrEqual(761);

      const baselineBtnSize = visualCheck.topbarBtnSize;

      // 2. Open Reading settings on desktop -> test all textSize & pageWidth presets + Reset defaults
      await page.locator('.sidebar-settings-btn').click();
      await page.waitForSelector('.reading-settings-modal[role="dialog"][aria-modal="true"]');
      expect(await page.evaluate(() => document.querySelector('main.document-stage')?.hasAttribute('inert'))).toBe(true);

      const expectedSizes: Record<'small' | 'standard' | 'large', number> = {
        small: 16,
        standard: 18,
        large: 20
      };
      const expectedWidths: Record<'narrow' | 'standard' | 'wide', number> = {
        narrow: 640,
        standard: 760,
        wide: 960
      };

      for (const sizeKey of ['small', 'large', 'standard'] as const) {
        await page
          .locator(`.reading-preset-btn[data-pref-group="textSize"][data-pref-value="${sizeKey}"]`)
          .click();
        const measured = await page.evaluate(() => ({
          proseSize: parseFloat(getComputedStyle(document.querySelector('.prose-container')!).fontSize),
          sampleSize: parseFloat(getComputedStyle(document.querySelector('.reading-sample-copy')!).fontSize),
          btnSize: parseFloat(getComputedStyle(document.querySelector('.btn-edit-entry')!).fontSize)
        }));
        expect(measured.proseSize).toBeCloseTo(expectedSizes[sizeKey], 1);
        expect(measured.sampleSize).toBeCloseTo(expectedSizes[sizeKey], 1);
        expect(measured.btnSize).toBeCloseTo(baselineBtnSize, 1);
      }

      for (const widthKey of ['narrow', 'wide', 'standard'] as const) {
        await page
          .locator(`.reading-preset-btn[data-pref-group="pageWidth"][data-pref-value="${widthKey}"]`)
          .click();
        const maxW = await page.evaluate(() =>
          getComputedStyle(document.querySelector('.workbench')!)
            .getPropertyValue('--focus-prose-max-width')
            .trim()
        );
        expect(maxW).toBe(`${expectedWidths[widthKey]}px`);
      }

      // Radio groups use one Tab stop and arrow/Home/End keys to select presets.
      const textGroup = page.getByRole('radiogroup', { name: 'Text size', exact: true });
      await textGroup.getByRole('radio', { name: 'Standard 18px', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      expect(await page.getAttribute('.workbench', 'data-text-size')).toBe('large');
      await page.keyboard.press('Home');
      expect(await page.getAttribute('.workbench', 'data-text-size')).toBe('small');
      await page.keyboard.press('End');
      expect(await page.getAttribute('.workbench', 'data-text-size')).toBe('large');
      expect(await textGroup.locator('[tabindex="0"]').count()).toBe(1);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.prefGroup)).toBe('pageWidth');

      // Reset defaults works and disables when back at defaults
      await page.locator('.reading-preset-btn[data-pref-value="large"][data-pref-group="textSize"]').click();
      await page.locator('.reading-preset-btn[data-pref-value="narrow"][data-pref-group="pageWidth"]').click();
      await page.locator('.reading-reset-btn').click();
      expect(await page.locator('.reading-reset-btn').isDisabled()).toBe(true);
      expect(await page.getAttribute('.workbench', 'data-text-size')).toBe('standard');
      expect(await page.getAttribute('.workbench', 'data-page-width')).toBe('standard');

      // Apply Large + Narrow, focus trap + Escape closes and restores focus to .sidebar-settings-btn
      await page.locator('.reading-preset-btn[data-pref-group="textSize"][data-pref-value="large"]').click();
      await page.locator('.reading-preset-btn[data-pref-group="pageWidth"][data-pref-value="narrow"]').click();
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        const insideModal = await page.evaluate(() =>
          Boolean(document.activeElement?.closest('.reading-settings-modal'))
        );
        expect(insideModal).toBe(true);
      }
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.reading-settings-modal'));
      await page.waitForFunction(() => document.activeElement?.classList.contains('sidebar-settings-btn'));

      // 3. Preserves centering with Review closed (and open) even under Narrow/Wide presets
      await page.locator('.review-sidebar .panel-close-btn').click();
      await page.waitForFunction(() => !document.querySelector('.review-sidebar'));
      const centeredNarrow = await page.evaluate(() => {
        const stage = document.querySelector('main.document-stage')!.getBoundingClientRect();
        const prose = document.querySelector('.prose-container')!.getBoundingClientRect();
        return {
          width: prose.width,
          leftGutter: prose.left - stage.left,
          rightGutter: stage.right - prose.right
        };
      });
      expect(centeredNarrow.width).toBeCloseTo(640, 1);
      expect(Math.abs(centeredNarrow.leftGutter - centeredNarrow.rightGutter)).toBeLessThanOrEqual(2);

      // 4. Persist across reload & project switch without affecting Markdown source font size or repo files
      await page.reload();
      await page.waitForSelector('.workbench[data-text-size="large"][data-page-width="narrow"]');

      await page.locator('#projectSelect').selectOption('helios-lab');
      await page.waitForSelector('.doc-page-eyebrow:has-text("Helios Lab")');
      expect(await page.getAttribute('.workbench', 'data-text-size')).toBe('large');
      expect(await page.getAttribute('.workbench', 'data-page-width')).toBe('narrow');

      // Switch to Source mode -> source editor textarea keeps crisp 13px monospace regardless of Large preset
      await page.locator('.btn-edit-entry').click();
      await page.locator('.mode-switch button:has-text("Markdown source")').click();
      await page.waitForSelector('textarea.markdown-source-editor');
      const sourceFontSize = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.querySelector('textarea.markdown-source-editor')!).fontSize)
      );
      expect(sourceFontSize).toBeCloseTo(13, 1);

      // Draft edit + comment draft survive opening/modifying/closing Reading settings
      const ta = page.locator('textarea.markdown-source-editor');
      const origSource = await ta.inputValue();
      const draftWithUnsaved = `${origSource}\nTemporary unsaved edit across settings.\n`;
      await ta.fill(draftWithUnsaved);

      await page.locator('.sidebar-settings-btn').click();
      await page.waitForSelector('.reading-settings-modal');
      await page.locator('.reading-preset-btn[data-pref-group="pageWidth"][data-pref-value="wide"]').click();
      await page.locator('.reading-done-btn').click();
      await page.waitForFunction(() => !document.querySelector('.reading-settings-modal'));
      expect(await ta.inputValue()).toBe(draftWithUnsaved);

      // Revert source draft cleanly so repo remains untouched
      await page.locator('.btn-revert-session').click();
      await page.waitForSelector('.workbench[data-workspace-mode="read"]');

      // No Markdown/comment/Git mutations resulted from changing display preferences
      const gitStatusAfter = execFileSync('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        encoding: 'utf8'
      });
      expect(gitStatusAfter).toBe(gitStatusBefore);

      // 5. Phone (390x844) & Short Landscape (956x440): open from Docs drawer, clamp Wide (960px) cleanly with zero horizontal overflow, no stacked focus fights
      for (const vp of [
        { width: 390, height: 844 },
        { width: 956, height: 440 }
      ]) {
        await page.setViewportSize(vp);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        await page.locator('.nav-toggle-btn').click();
        await page.waitForSelector('.nav-sidebar.is-overlay-open');
        await page.locator('.sidebar-settings-btn').click();
        await page.waitForSelector('.reading-settings-modal');
        // Docs drawer closed automatically so no stacked focus fight occurs
        expect(await page.locator('.nav-sidebar.is-overlay-open').count()).toBe(0);

        await page.locator('.reading-preset-btn[data-pref-group="pageWidth"][data-pref-value="wide"]').click();
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.reading-settings-modal'));
        await page.waitForFunction(() => document.activeElement?.classList.contains('nav-toggle-btn'));

        const mobileMetrics = await page.evaluate(() => ({
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
          proseRight: document.querySelector('.prose-container')!.getBoundingClientRect().right,
          proseLeft: document.querySelector('.prose-container')!.getBoundingClientRect().left
        }));
        expect(mobileMetrics.overflowX).toBeLessThanOrEqual(1);
        expect(mobileMetrics.proseLeft).toBeGreaterThanOrEqual(12);
        expect(mobileMetrics.proseRight).toBeLessThanOrEqual(vp.width);
      }

      // 6. Invalid/corrupt localStorage recovery in live browser
      await page.evaluate(() => {
        window.localStorage.setItem('focus:reading-preferences:v1', '{"version":1,"textSize":"giant","pageWidth":"invalid"}');
      });
      await page.reload();
      await page.waitForSelector('.workbench[data-text-size="standard"][data-page-width="standard"]');
    } finally {
      await context.close();
    }
  });
});
