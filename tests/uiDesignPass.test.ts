import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  execFileSync('git', ['config', 'user.email', 'test@cairn.local'], { cwd: repoDir });
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
    const localCache = path.join(PROJECT_ROOT, '.runtime', 'ms-playwright');
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(localCache)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = localCache;
    }

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ui-pass-test-'));
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

    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  }, 25000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (hub) await hub.close();
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('opens in clean Read mode IA by default, hides authoring chrome & save noise, and supports prose selection commenting + reply/resolve/reopen', async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
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
      await commentChip.waitFor({ state: 'visible', timeout: 4000 });
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
      await page.waitForSelector('.cairn-comment-highlight.is-resolved');
      expect(await page.locator('.cairn-comment-highlight.is-open').count()).toBeGreaterThan(0);

      // Reopen resolved thread from compact summary button
      await page.locator('.thread-card.is-resolved button:has-text("Reopen")').first().click();
      await page.waitForFunction(
        () => document.querySelectorAll('.cairn-comment-highlight.is-open').length >= 2
      );
    } finally {
      await context.close();
    }
  }, 25000);

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
  }, 25000);

  it('supports explicit Visual Editor, full-workspace Markdown Source, autosave round-trip, and external conflict recovery', async () => {
    const docRel = 'docs/roundtrip-edit-test.md';
    const docAbs = path.join(repoRoot, docRel);
    fs.writeFileSync(
      docAbs,
      '# Roundtrip Edit Check\n\nInitial paragraph for editing.\n\n| Col A | Col B |\n| :--- | :--- |\n| Alpha | Beta |\n',
      'utf8'
    );

    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
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
      await ta.fill(existing.replace('Initial paragraph for editing.', 'Updated in full-workspace source mode.'));
      await page.waitForFunction(
        () => document.querySelector('.save-badge.saved') !== null,
        undefined,
        { timeout: 5000 }
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
      await page.waitForSelector('.save-badge.conflict', { timeout: 5000 });
      expect(await page.locator('.modal-panel:has-text("External File Edit Detected")').count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 25000);

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
  }, 25000);

  it('uses native root scrolling, locks background & traps focus in modal drawers, and preserves drafts + scroll across dismiss and portrait->landscape rotation', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    context.setDefaultTimeout(4000);
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
  }, 25000);

  it('scopes horizontal scrolling strictly to wide tables (.tableWrapper) and <pre> blocks without clipping prose left edges on helios-lab bench-inventory.md', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
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
  }, 25000);
});
