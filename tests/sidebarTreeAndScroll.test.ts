import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocTreeEntry } from '../shared/types';
import { createHubApp, type HubAppInstance } from '../server/app';
import {
  buildDocTree,
  computeDefaultExpandedFolders,
  deriveDefaultNewDocDir,
  folderContainsDoc,
  getAncestorFolderKeys
} from '../src/utils/docTree';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(PROJECT_ROOT, 'dist', 'client');

function makeEntry(relPath: string, title: string, openComments = 0): DocTreeEntry {
  return {
    path: relPath,
    title,
    updatedAt: '2026-11-17T00:00:00.000Z',
    openComments
  };
}

function initGitRepo(repoDir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test Author'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@focuswiki.local'], { cwd: repoDir });
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial multi-dir fixture'], { cwd: repoDir });
}

describe('Directory-aware document tree & long-sidebar scroll/footer layout', () => {
  it('groups flat paths into directories, promotes folder README/default docs, compacts empty chains, and sorts numerically', () => {
    const docs: DocTreeEntry[] = [
      makeEntry('docs/decisions/0010-continuous-checks.md', 'ADR 0010: Continuous checks'),
      makeEntry('docs/decisions/0002-agency.md', 'ADR 0002: Agency', 2),
      makeEntry('docs/decisions/README.md', 'Decision records'),
      makeEntry('docs/architecture.md', 'Architecture map'),
      makeEntry('README.md', 'Project overview'),
      makeEntry('packages/runtime/core/guide.md', 'Core runtime guide', 1),
      makeEntry('evals/playtest/README.md', 'Playtest suite'),
      makeEntry('evals/results/README.md', 'Retained results')
    ];

    const tree = buildDocTree(docs, 'README.md');
    expect(tree.rootFiles.map((f) => f.doc.path)).toEqual(['README.md']);
    expect(tree.folders.map((f) => f.label)).toEqual(['docs', 'evals', 'packages/runtime/core']);

    const docsFolder = tree.folders.find((f) => f.key === 'docs')!;
    expect(docsFolder.totalDocs).toBe(4);
    expect(docsFolder.openComments).toBe(2);
    expect(docsFolder.folders.map((f) => f.label)).toEqual(['decisions']);

    const decisionsFolder = docsFolder.folders[0];
    expect(decisionsFolder.overviewFiles.map((f) => f.doc.path)).toEqual([
      'docs/decisions/README.md'
    ]);
    expect(decisionsFolder.regularFiles.map((f) => f.doc.path)).toEqual([
      'docs/decisions/0002-agency.md',
      'docs/decisions/0010-continuous-checks.md'
    ]);

    // Compacted chain preserves ancestor matching
    const compacted = tree.folders.find((f) => f.label === 'packages/runtime/core')!;
    expect(compacted.key).toBe('packages/runtime/core');
    expect(folderContainsDoc(compacted.key, 'packages/runtime/core/guide.md')).toBe(true);
    expect(
      getAncestorFolderKeys('docs/decisions/0002-agency.md', tree.allFolderKeys)
    ).toEqual(['docs', 'docs/decisions']);
    expect(deriveDefaultNewDocDir('docs/decisions/0002-agency.md')).toBe('docs/decisions/');
    expect(deriveDefaultNewDocDir('README.md')).toBe('docs/');
  });

  it('collapses large nested subdirectories by default on large repos while always expanding active doc ancestors', () => {
    const docs: DocTreeEntry[] = [makeEntry('README.md', 'Overview')];
    for (let i = 1; i <= 12; i++) {
      docs.push(makeEntry(`docs/topic-${i}.md`, `Topic ${i}`));
    }
    for (let i = 1; i <= 15; i++) {
      docs.push(makeEntry(`docs/decisions/${String(i).padStart(4, '0')}-adr.md`, `ADR ${i}`));
    }
    for (let i = 1; i <= 20; i++) {
      docs.push(makeEntry(`docs/log/2026-11-${String(i).padStart(2, '0')}.md`, `Log ${i}`));
    }
    docs.push(makeEntry('evals/decision/README.md', 'Decision evals'));
    docs.push(makeEntry('evals/results/README.md', 'Results archive'));

    const tree = buildDocTree(docs, 'README.md');

    const rootActive = computeDefaultExpandedFolders(tree, 'README.md', docs.length);
    expect(rootActive['docs']).toBe(true);
    expect(rootActive['docs/decisions']).toBe(false);
    expect(rootActive['docs/log']).toBe(false);
    expect(rootActive['evals']).toBe(false);
    // Single-file leaf folders inside evals pre-expand so opening evals reveals them in one click
    expect(rootActive['evals/decision']).toBe(true);

    const deepActive = computeDefaultExpandedFolders(
      tree,
      'docs/decisions/0008-adr.md',
      docs.length
    );
    expect(deepActive['docs']).toBe(true);
    expect(deepActive['docs/decisions']).toBe(true);
    expect(deepActive['docs/log']).toBe(false);
  });

  describe('Browser geometry & interaction on a 55-page multi-directory repository', () => {
    let tmpRoot = '';
    let repoRoot = '';
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

      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-long-sidebar-test-'));
      repoRoot = path.join(tmpRoot, 'atlas-handbook');
      fs.mkdirSync(path.join(repoRoot, 'docs', 'decisions'), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, 'docs', 'log'), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, 'evals', 'scenarios'), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, 'evals', 'metrics'), { recursive: true });

      fs.writeFileSync(
        path.join(repoRoot, 'README.md'),
        '# Atlas System Handbook\n\nRoot handbook overview.\n',
        'utf8'
      );

      for (let i = 1; i <= 16; i++) {
        const slug = String(i).padStart(2, '0');
        fs.writeFileSync(
          path.join(repoRoot, 'docs', `design-note-${slug}.md`),
          `# Design Note ${slug}: Subsystem Architecture\n\nDetailed prose for subsystem ${slug}.\n`,
          'utf8'
        );
      }

      fs.writeFileSync(
        path.join(repoRoot, 'docs', 'decisions', 'README.md'),
        '# Architecture Decision Index\n\nIndex of recorded decisions.\n',
        'utf8'
      );
      for (let i = 1; i <= 15; i++) {
        const num = String(i).padStart(4, '0');
        fs.writeFileSync(
          path.join(repoRoot, 'docs', 'decisions', `${num}-decision-record.md`),
          `# ADR ${num}: Deterministic Subsystem Boundary\n\nDecision ${num} details.\n`,
          'utf8'
        );
      }

      fs.writeFileSync(
        path.join(repoRoot, 'docs', 'log', 'README.md'),
        '# Session Engineering Logs\n\nAppend-only session records.\n',
        'utf8'
      );
      for (let i = 1; i <= 20; i++) {
        const day = String(i).padStart(2, '0');
        fs.writeFileSync(
          path.join(repoRoot, 'docs', 'log', `2026-11-${day}-session.md`),
          `# 2026-11-${day} Verification Log\n\nSession ${day} summary.\n`,
          'utf8'
        );
      }

      fs.writeFileSync(
        path.join(repoRoot, 'evals', 'scenarios', 'README.md'),
        '# Scenario Suite\n\nSynthetic scenario cases.\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(repoRoot, 'evals', 'metrics', 'README.md'),
        '# Metric Calibration\n\nScoring thresholds.\n',
        'utf8'
      );

      initGitRepo(repoRoot);

      hub = createHubApp({
        projects: [
          {
            id: 'atlas-handbook',
            name: 'Atlas Handbook',
            description: 'Large multi-directory fixture repository',
            rootPath: repoRoot,
            defaultDoc: 'README.md'
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
      try {
        browser = await chromium.launch({ headless: true, chromiumSandbox: true });
      } catch {
        browser = await chromium.launch({ headless: true });
      }
    });

    afterAll(async () => {
      if (browser) await browser.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (hub) await hub.close();
      if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('renders directory groups, keeps Settings visible and non-overlapping across scroll on desktop, portrait, and short landscape', async () => {
      const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
      context.setDefaultTimeout(15000);
      const page = await context.newPage();

      try {
        await page.goto(`${baseUrl}/?project=atlas-handbook&doc=README.md`);
        await page.waitForSelector('.nav-sidebar .doc-tree-scroll');

        // Verify directory groups exist and nested noisy folders start collapsed
        const docsToggle = page.locator('.doc-folder-group[data-folder-path="docs"] > .doc-folder-toggle');
        const decisionsToggle = page.locator(
          '.doc-folder-group[data-folder-path="docs/decisions"] > .doc-folder-toggle'
        );
        const logToggle = page.locator('.doc-folder-group[data-folder-path="docs/log"] > .doc-folder-toggle');
        const evalsToggle = page.locator('.doc-folder-group[data-folder-path="evals"] > .doc-folder-toggle');

        expect(await docsToggle.getAttribute('aria-expanded')).toBe('true');
        expect(await decisionsToggle.getAttribute('aria-expanded')).toBe('false');
        expect(await logToggle.getAttribute('aria-expanded')).toBe('false');
        expect(await evalsToggle.getAttribute('aria-expanded')).toBe('false');

        // Expand all folders so the sidebar contains 55+ items
        await decisionsToggle.click();
        await logToggle.click();
        await evalsToggle.click();
        expect(await decisionsToggle.getAttribute('aria-expanded')).toBe('true');
        await page.waitForFunction(() => document.querySelectorAll('.nav-sidebar .doc-item').length >= 54);

        // Verify folder README appears first inside docs/decisions before ADR 0001
        const firstDecisionTitle = await page
          .locator('.doc-folder-group[data-folder-path="docs/decisions"] .doc-item .doc-item-title')
          .first()
          .textContent();
        expect(firstDecisionTitle).toBe('Architecture Decision Index');

        // Geometry check before and after scrolling .doc-tree-scroll:
        // Settings button must remain visible in viewport, opaque/styled, and strictly below .doc-tree-scroll (never overlapping doc items)
        for (const scrollTarget of [0, 350, 99999]) {
          await page.evaluate((top) => {
            const scroller = document.querySelector<HTMLElement>('.doc-tree-scroll')!;
            scroller.scrollTop = top;
          }, scrollTarget);

          const geom = await page.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>('.doc-tree-scroll')!;
            const footer = document.querySelector<HTMLElement>('.sidebar-footer')!;
            const settingsBtn = document.querySelector<HTMLElement>('.sidebar-settings-btn')!;
            const btnStyle = getComputedStyle(settingsBtn);
            const scrollerRect = scroller.getBoundingClientRect();
            const footerRect = footer.getBoundingClientRect();
            const btnRect = settingsBtn.getBoundingClientRect();

            // Check elementFromPoint on center of Settings button hits the Settings button (not an overflowing doc item)
            const hitEl = document.elementFromPoint(
              btnRect.left + btnRect.width / 2,
              btnRect.top + btnRect.height / 2
            );

            return {
              scrollerScrollHeight: scroller.scrollHeight,
              scrollerClientHeight: scroller.clientHeight,
              scrollerBottom: scrollerRect.bottom,
              footerTop: footerRect.top,
              btnTop: btnRect.top,
              btnBottom: btnRect.bottom,
              viewportHeight: window.innerHeight,
              btnBg: btnStyle.backgroundColor,
              btnBorderWidth: parseFloat(btnStyle.borderTopWidth),
              btnOpacity: parseFloat(btnStyle.opacity),
              hitsSettingsBtn: Boolean(hitEl && settingsBtn.contains(hitEl))
            };
          });

          expect(geom.scrollerScrollHeight).toBeGreaterThan(geom.scrollerClientHeight + 400);
          expect(geom.footerTop).toBeGreaterThanOrEqual(geom.scrollerBottom - 1);
          expect(geom.btnBottom).toBeLessThanOrEqual(geom.viewportHeight);
          expect(geom.btnTop).toBeGreaterThan(0);
          expect(geom.btnBg).not.toBe('rgba(0, 0, 0, 0)');
          expect(geom.btnBorderWidth).toBeGreaterThanOrEqual(1);
          expect(geom.btnOpacity).toBe(1);
          expect(geom.hitsSettingsBtn).toBe(true);
        }

        // Collapse all folders button collapses the tree cleanly, then Expand all restores
        await page.locator('button[aria-label="Collapse all folders"]').click();
        expect(await docsToggle.getAttribute('aria-expanded')).toBe('false');
        await page.waitForFunction(() => document.querySelectorAll('.nav-sidebar .doc-item').length === 1); // Only root README.md

        // Navigating to a nested doc via URL automatically opens its ancestor folders
        await page.goto(
          `${baseUrl}/?project=atlas-handbook&doc=${encodeURIComponent('docs/decisions/0012-decision-record.md')}`
        );
        await page.waitForSelector('.doc-item.active:has-text("ADR 0012")');
        expect(await docsToggle.getAttribute('aria-expanded')).toBe('true');
        expect(await decisionsToggle.getAttribute('aria-expanded')).toBe('true');

        // Check narrow portrait (390x844) and short landscape (844x390) overlay drawers
        for (const vp of [
          { width: 390, height: 844 },
          { width: 844, height: 390 }
        ]) {
          await page.setViewportSize(vp);
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          await page.locator('.nav-toggle-btn').click();
          await page.waitForSelector('.nav-sidebar.is-overlay-open');

          await page.locator('.sidebar-settings-btn').scrollIntoViewIfNeeded();
          const settingsBox = await page.locator('.sidebar-settings-btn').boundingBox();
          expect(settingsBox).not.toBeNull();
          expect(settingsBox!.height).toBeGreaterThanOrEqual(36);

          await page.locator('.sidebar-settings-btn').click();
          await page.waitForSelector('.reading-settings-modal');
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.querySelector('.reading-settings-modal'));
        }
      } finally {
        await context.close();
      }
    });
  });
});
