import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readProjectFile(relPath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Automatic dark mode tokens, embeds, and contrast invariants', () => {
  it('declares light/dark color-scheme in index.html and workspace.css', () => {
    const html = readProjectFile('index.html');
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');

    const css = readProjectFile('src/styles/workspace.css');
    expect(css).toContain('color-scheme: light dark;');
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);

    const darkMatch = css.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root(?::not\(\[data-theme="light"\]\))?\s*\{([\s\S]*?)\}\s*\}/
    );
    expect(darkMatch).toBeTruthy();
    const darkVarsBlock = darkMatch![1];

    for (const requiredToken of [
      '--surface-desk',
      '--surface-sheet',
      '--surface-subtle',
      '--surface-bar',
      '--ink-primary',
      '--ink-secondary',
      '--ink-faint',
      '--line-border',
      '--accent-primary',
      '--accent-fill',
      '--highlight-ochre',
      '--conflict-garnet',
      '--diff-added-pill-bg',
      '--diff-removed-pill-bg'
    ]) {
      expect(darkVarsBlock).toContain(requiredToken);
    }
  });

  it('eliminates non-token hardcoded light surfaces and colors outside token definitions', () => {
    const css = readProjectFile('src/styles/workspace.css');
    const lines = css.split('\n');
    const explicitDarkStart = lines.findIndex((line) =>
      line.trim().startsWith(':root[data-theme="dark"]')
    );
    const tokenEndIdx =
      explicitDarkStart >= 0
        ? lines.findIndex((line, idx) => idx > explicitDarkStart && line.trim() === '}')
        : lines.findIndex((line, idx) => idx > 100 && line.trim() === '}');
    expect(tokenEndIdx).toBeGreaterThan(100);

    const ruleLines = lines.slice(tokenEndIdx + 1);
    const hardcodedColors = ruleLines
      .map((line, i) => ({ lineNumber: tokenEndIdx + 2 + i, line: line.trim() }))
      .filter(({ line }) => /#[0-9a-fA-F]{3,8}|rgba?\(/.test(line));

    // Only intentional #ffffff on solid filled accent/danger/ochre pills/buttons/thumbs may remain.
    for (const match of hardcodedColors) {
      expect(['color: #ffffff;', 'background: #ffffff;']).toContain(match.line);
    }
  });

  it('maintains WCAG AA contrast ratios for primary, secondary, faint, and solid-button tokens in dark mode', () => {
    const css = readProjectFile('src/styles/workspace.css');
    const darkMatch = css.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root(?::not\(\[data-theme="light"\]\))?\s*\{([\s\S]*?)\}\s*\}/
    );
    expect(darkMatch).toBeTruthy();
    const vars = new Map<string, string>();
    for (const [, name, value] of darkMatch![1].matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) {
      vars.set(name, value);
    }

    const sheet = vars.get('--surface-sheet')!;
    expect(contrastRatio(vars.get('--ink-primary')!, sheet)).toBeGreaterThanOrEqual(12);
    expect(contrastRatio(vars.get('--ink-secondary')!, sheet)).toBeGreaterThanOrEqual(6.5);
    expect(contrastRatio(vars.get('--ink-faint')!, sheet)).toBeGreaterThanOrEqual(5.5);
    expect(contrastRatio(vars.get('--accent-primary')!, sheet)).toBeGreaterThanOrEqual(6);
    expect(contrastRatio('#ffffff', vars.get('--accent-fill')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', vars.get('--conflict-solid')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', vars.get('--highlight-ochre-marker-active')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('enables automatic dark mode in starter embed template and all seeded sandboxed embeds', () => {
    const insertModal = readProjectFile('src/components/InsertEmbedModal.tsx');
    expect(insertModal).toContain('<meta name="color-scheme" content="light dark" />');
    expect(insertModal).toContain('@media (prefers-color-scheme: dark)');

    const seedEmbedPaths = [
      'seeds/cindervault-rpg/embeds/state-explorer/index.html',
      'seeds/cindervault-rpg/embeds/turn-walkthrough/index.html',
      'seeds/cindervault-rpg/embeds/difficulty-playground/index.html',
      'seeds/helios-lab/embeds/power-sequencer/index.html'
    ];
    for (const relPath of seedEmbedPaths) {
      const html = readProjectFile(relPath);
      expect(html, relPath).toContain('<meta name="color-scheme" content="light dark" />');
      expect(html, relPath).toContain('color-scheme: light dark;');
      expect(html, relPath).toContain('@media (prefers-color-scheme: dark)');
    }
  });
});
