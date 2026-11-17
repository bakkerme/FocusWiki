import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHubApp } from '../server/app.js';
import { markdownToProseMirror, parseEmbedBlockText } from '../shared/markdownCodec.js';

const ROOT = path.resolve(__dirname, '..');

interface WikiValidationResult {
  errors: string[];
  warnings: string[];
  stats: { docs: number; embeds: number; sidecars: number };
}

async function runValidateWikiRepo(targetDir: string): Promise<WikiValidationResult> {
  const scriptUrl = pathToFileURL(
    path.join(ROOT, 'skills/focuswiki-docs/scripts/validate-wiki.mjs')
  ).href;
  const mod = (await import(scriptUrl)) as {
    validateWikiRepo: (root: string) => WikiValidationResult;
  };
  return mod.validateWikiRepo(targetDir);
}

function parseSkillFrontmatter(skillMdPath: string): {
  name: string;
  description: string;
  internal: boolean;
} {
  const raw = fs.readFileSync(skillMdPath, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, `Missing YAML frontmatter in ${skillMdPath}`).toBeTruthy();
  const fm = match![1];

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  expect(nameMatch, `Missing name in ${skillMdPath}`).toBeTruthy();
  expect(descMatch, `Missing description in ${skillMdPath}`).toBeTruthy();

  const name = nameMatch![1].trim().replace(/^['"]|['"]$/g, '');
  const description = descMatch![1].trim().replace(/^['"]|['"]$/g, '');
  const internal = /metadata:\s*\n\s+internal:\s*true\b/.test(fm);

  return { name, description, internal };
}

describe('FocusWiki Agent Skills suite & repository hygiene', () => {
  it('exposes valid agentskills.io consumer skills in skills/ and marks internal dev skills internal: true', () => {
    const publicSkills = ['focuswiki-docs', 'focuswiki-embeds', 'focuswiki-comments'];

    for (const dirName of publicSkills) {
      const skillMd = path.join(ROOT, 'skills', dirName, 'SKILL.md');
      expect(fs.existsSync(skillMd), `Expected ${skillMd} to exist`).toBe(true);

      const meta = parseSkillFrontmatter(skillMd);
      expect(meta.name).toBe(dirName);
      expect(meta.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(meta.name.length).toBeLessThanOrEqual(64);
      expect(meta.description.length).toBeGreaterThan(20);
      expect(meta.description.length).toBeLessThanOrEqual(1024);
      expect(meta.internal).toBe(false);
    }

    for (const internalDir of ['cairn-product-design', 'frontend-design']) {
      const skillMd = path.join(ROOT, '.agents', 'skills', internalDir, 'SKILL.md');
      const meta = parseSkillFrontmatter(skillMd);
      expect(meta.name).toBe(internalDir);
      expect(meta.internal).toBe(true);
    }
  });

  it('keeps embed syntax examples in focuswiki-docs/SKILL.md and starter HTML aligned with FocusWiki runtime', () => {
    const docsSkill = fs.readFileSync(path.join(ROOT, 'skills/focuswiki-docs/SKILL.md'), 'utf8');
    const embedFenceMatches = Array.from(docsSkill.matchAll(/```embed\n([\s\S]*?)```/g));
    expect(embedFenceMatches.length).toBeGreaterThanOrEqual(1);

    for (const [, body] of embedFenceMatches) {
      const parsed = parseEmbedBlockText(body);
      expect(parsed).not.toBeNull();
      const pm = markdownToProseMirror(`# Sample\n\n\`\`\`embed\n${body}\`\`\`\n`);
      const hasEmbedBlock = pm.content?.some((n) => n.type === 'embedBlock');
      const hasRawFallback = pm.content?.some(
        (n) => n.type === 'rawMarkdownBlock' && n.attrs?.kind === 'embed-raw'
      );
      expect(hasEmbedBlock).toBe(true);
      expect(hasRawFallback).toBe(false);
    }

    const starterHtml = fs.readFileSync(
      path.join(ROOT, 'skills/focuswiki-embeds/assets/embed-starter.html'),
      'utf8'
    );
    expect(starterHtml).toContain('<meta name="color-scheme" content="light dark" />');
    expect(starterHtml).toContain('color-scheme: light dark;');
    expect(starterHtml).toContain('@media (prefers-color-scheme: dark)');
    expect(starterHtml).toContain('html { height: auto; }');
    expect(starterHtml).toContain('focus:embed:ready');
    expect(starterHtml).toContain('focus:embed:resize');
    expect(starterHtml).toContain('focus:embed:init');
    expect(starterHtml).toContain('focus:embed:telemetry');
    expect(starterHtml).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it('passes zero-dependency validate-wiki.mjs on both seeded repositories and catches syntax/sandbox/comment errors', async () => {
    const rpgResult = await runValidateWikiRepo(path.join(ROOT, 'seeds/cindervault-rpg'));
    expect(rpgResult.errors).toEqual([]);
    expect(rpgResult.warnings).toEqual([]);

    const labResult = await runValidateWikiRepo(path.join(ROOT, 'seeds/helios-lab'));
    expect(labResult.errors).toEqual([]);
    expect(labResult.warnings).toEqual([]);

    // Also verify CLI execution exits 0
    const cliOut = execFileSync(
      process.execPath,
      [path.join(ROOT, 'skills/focuswiki-docs/scripts/validate-wiki.mjs'), path.join(ROOT, 'seeds/cindervault-rpg')],
      { encoding: 'utf8' }
    );
    expect(cliOut).toContain('FocusWiki validation passed');

    // Create a broken temporary repo to verify failure detection
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-skill-validator-'));
    try {
      fs.mkdirSync(path.join(brokenDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(brokenDir, 'embeds/bad-widget'), { recursive: true });

      fs.writeFileSync(
        path.join(brokenDir, 'docs/broken.md'),
        [
          '# Broken Page',
          '',
          '- [x] Task item',
          '- Plain bullet item mixed in',
          '',
          '```embed',
          'src: embeds/bad-widget/index.html',
          'props:',
          '  nested: yaml',
          '```',
          '',
          '```embed',
          'src: embeds/missing-widget/index.html',
          'title: Missing',
          '```'
        ].join('\n'),
        'utf8'
      );

      fs.writeFileSync(
        path.join(brokenDir, 'embeds/bad-widget/index.html'),
        `<!doctype html><html><head><script src="https://cdn.example.com/lib.js"></script></head><body><script>localStorage.setItem('k','v');</script></body></html>`,
        'utf8'
      );

      fs.writeFileSync(
        path.join(brokenDir, 'docs/broken.comments.json'),
        JSON.stringify({
          version: 1,
          document: 'docs/broken.md',
          threads: [
            {
              id: 'thr_1',
              status: 'open',
              anchor: { quote: 'nonexistent phrase in prose', prefix: '', suffix: '' },
              messages: [{ id: 'm1', author: 'Bot', role: 'bot', createdAt: '2026-11-16T00:00:00Z', body: 'Note' }],
              history: [{ action: 'created', actor: 'Bot', role: 'bot', at: '2026-11-16T00:00:00Z' }]
            }
          ]
        }),
        'utf8'
      );

      const badRes = await runValidateWikiRepo(brokenDir);
      expect(badRes.errors.some((e: string) => e.includes('Malformed ```embed block'))).toBe(true);
      expect(badRes.errors.some((e: string) => e.includes('does not exist on disk'))).toBe(true);
      expect(badRes.errors.some((e: string) => e.includes('External http(s)://'))).toBe(true);
      expect(badRes.errors.some((e: string) => e.includes('localStorage'))).toBe(true);
      expect(badRes.warnings.some((w: string) => w.includes('Mixed task items'))).toBe(true);
      expect(badRes.warnings.some((w: string) => w.includes('Anchor quote'))).toBe(true);
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true });
    }
  });

  it('ignores installed .agents/skills, .claude/skills, and AGENTS.md/CLAUDE.md in FocusWiki doc navigation and search', async () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-installed-skills-'));
    let hub: ReturnType<typeof createHubApp> | null = null;
    try {
      fs.mkdirSync(path.join(tmpRepo, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpRepo, '.agents/skills/focuswiki-docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpRepo, '.claude/skills'), { recursive: true });

      fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Project Home\n\nWelcome.\n', 'utf8');
      fs.writeFileSync(path.join(tmpRepo, 'docs/guide.md'), '# System Guide\n\nAuthoritative content.\n', 'utf8');
      fs.writeFileSync(path.join(tmpRepo, 'AGENTS.md'), '# Agent Instructions\n\nSecret harness marker xylophone-agent-rule.\n', 'utf8');
      fs.writeFileSync(path.join(tmpRepo, 'CLAUDE.md'), '# Claude Instructions\n\nSecret harness marker xylophone-agent-rule.\n', 'utf8');
      fs.copyFileSync(
        path.join(ROOT, 'skills/focuswiki-docs/SKILL.md'),
        path.join(tmpRepo, '.agents/skills/focuswiki-docs/SKILL.md')
      );
      fs.symlinkSync(
        '../../.agents/skills/focuswiki-docs',
        path.join(tmpRepo, '.claude/skills/focuswiki-docs')
      );

      hub = createHubApp({
        projects: [
          {
            id: 'skill-test-repo',
            name: 'Skill Test Repo',
            description: 'Repo with installed agent skills',
            rootPath: tmpRepo,
            defaultDoc: 'README.md'
          }
        ],
        enableWatcher: false
      });

      const listRes = await request(hub.app).get('/api/projects').expect(200);
      const docPaths = listRes.body.projects[0].docs.map((d: { path: string }) => d.path);
      expect(docPaths).toEqual(['README.md', 'docs/guide.md']);

      const searchSkill = await request(hub.app).get('/api/search?q=xylophone-agent-rule').expect(200);
      expect(searchSkill.body.results).toEqual([]);
    } finally {
      if (hub) await hub.close();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
