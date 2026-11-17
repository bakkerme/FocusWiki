#!/usr/bin/env node
/**
 * Zero-dependency validator for FocusWiki documentation repositories.
 * Checks:
 *  1. Fenced ```embed blocks in Markdown files (exact parity with parseEmbedBlockText,
 *     respecting outer CommonMark fences so 4-backtick examples are not misflagged).
 *  2. Task list uniformity (mixed [ ] and plain bullets degrade to plain bulletList).
 *  3. Sandboxed embed assets under embeds/ (allowed extensions, no external CDN/network URLs,
 *     no unguarded localStorage/sessionStorage/cookie calls, dark-mode color-scheme support).
 *  4. Portable .comments.json sidecars (schema validity and prose quote/context resolution).
 *
 * Usage:
 *   node validate-wiki.mjs [repo-root]
 */

import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_EMBED_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.json',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.woff',
  '.woff2',
  '.txt'
]);

const IGNORED_DOC_FILENAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

function parseEmbedBlockText(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Empty embed fence body.' };
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.src === 'string' && parsed.src.trim()) {
        if (
          parsed.props !== undefined &&
          (!parsed.props || typeof parsed.props !== 'object' || Array.isArray(parsed.props))
        ) {
          return { ok: false, reason: '"props" in JSON embed block must be a JSON object.' };
        }
        return {
          ok: true,
          descriptor: {
            src: parsed.src.trim(),
            title: typeof parsed.title === 'string' ? parsed.title : parsed.src.trim(),
            height: typeof parsed.height === 'number' && parsed.height >= 120 ? parsed.height : 420,
            props: parsed.props ?? {}
          }
        };
      }
      return { ok: false, reason: 'JSON embed block is missing a non-empty "src" string.' };
    } catch (err) {
      return { ok: false, reason: `Invalid JSON embed block (${err.message}).` };
    }
  }

  const ALLOWED_KEYS = new Set(['src', 'title', 'height', 'props']);
  const map = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    if (/^[ \t]+/.test(line)) {
      return {
        ok: false,
        reason: `Malformed embed line "${clean}": indented multi-line YAML/JSON is not supported (props would be silently dropped).`
      };
    }
    const colonIdx = clean.indexOf(':');
    if (colonIdx === -1) {
      return {
        ok: false,
        reason: `Line "${clean}" is missing ":" (use single-line key: value).`
      };
    }
    const key = clean.slice(0, colonIdx).trim();
    const val = clean.slice(colonIdx + 1).trim();
    if (!ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        reason: `Unknown embed field "${key}" (only src, title, height, props are supported; extra keys are dropped on save).`
      };
    }
    map[key] = val;
  }

  if (!map.src) {
    return { ok: false, reason: 'Missing required "src: embeds/<widget>/index.html" field.' };
  }

  let props = {};
  if ('props' in map) {
    if (!map.props) {
      return {
        ok: false,
        reason: '"props:" is empty (must be a single-line JSON object on the same line, e.g. props: {"key":"value"}).'
      };
    }
    try {
      const parsedProps = JSON.parse(map.props);
      if (parsedProps && typeof parsedProps === 'object' && !Array.isArray(parsedProps)) {
        props = parsedProps;
      } else {
        return { ok: false, reason: '"props" must be a single-line JSON object (e.g. props: {"key":"value"}).' };
      }
    } catch {
      return {
        ok: false,
        reason: '"props" contains invalid JSON (must be a single-line JSON object, not YAML or multi-line JSON).'
      };
    }
  }

  const parsedHeight = map.height ? Number(map.height) : 420;
  if (map.height && (!Number.isFinite(parsedHeight) || parsedHeight < 120)) {
    return {
      ok: true,
      warning: `height "${map.height}" is invalid or < 120; FocusWiki will clamp/default to 420.`,
      descriptor: {
        src: map.src,
        title: map.title || map.src,
        height: 420,
        props
      }
    };
  }

  return {
    ok: true,
    descriptor: {
      src: map.src,
      title: map.title || map.src,
      height: Number.isFinite(parsedHeight) && parsedHeight >= 120 ? Math.round(parsedHeight) : 420,
      props
    }
  };
}

function stripInlineMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1$2');
}

function scanTopLevelFencesAndLists(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const embedBlocks = [];
  const mixedTaskLists = [];
  const proseLines = [];

  let activeFence = null;
  let currentList = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (!activeFence) {
      const openMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})([^`~]*)$/);
      if (openMatch) {
        if (currentList) {
          if (currentList.taskCount > 0 && currentList.plainCount > 0) {
            mixedTaskLists.push(currentList.startLine);
          }
          currentList = null;
        }
        const marker = openMatch[1];
        const info = openMatch[2].trim().split(/\s+/)[0] || '';
        activeFence = {
          char: marker[0],
          length: marker.length,
          lang: info,
          startLine: lineNum,
          bodyLines: []
        };
        continue;
      }

      const listMatch = line.match(/^[ \t]{0,3}(?:[-+*]|\d+\.)[ \t]+(.*)$/);
      if (listMatch) {
        const rest = listMatch[1];
        const isTask = /^\[[ xX]\][ \t]+/.test(rest);
        if (!currentList) {
          currentList = { startLine: lineNum, taskCount: 0, plainCount: 0 };
        }
        if (isTask) {
          currentList.taskCount++;
          proseLines.push(stripInlineMarkdown(rest.replace(/^\[[ xX]\][ \t]+/, '')));
        } else {
          currentList.plainCount++;
          proseLines.push(stripInlineMarkdown(rest));
        }
        continue;
      }

      if (line.trim() === '' && currentList) {
        if (currentList.taskCount > 0 && currentList.plainCount > 0) {
          mixedTaskLists.push(currentList.startLine);
        }
        currentList = null;
      } else if (currentList && !/^[ \t]{2,}/.test(line)) {
        if (currentList.taskCount > 0 && currentList.plainCount > 0) {
          mixedTaskLists.push(currentList.startLine);
        }
        currentList = null;
      }

      if (line.trim().length > 0) {
        const cleanProse = stripInlineMarkdown(
          line
            .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '')
            .replace(/^[ \t]{0,3}>[ \t]?/, '')
        );
        proseLines.push(cleanProse);
      }
    } else {
      const closeRegex = new RegExp(`^[ \\t]{0,3}${activeFence.char}{${activeFence.length},}[ \\t]*$`);
      if (closeRegex.test(line)) {
        if (activeFence.lang === 'embed') {
          embedBlocks.push({
            line: activeFence.startLine,
            value: activeFence.bodyLines.join('\n')
          });
        }
        activeFence = null;
      } else {
        activeFence.bodyLines.push(line);
      }
    }
  }

  if (currentList && currentList.taskCount > 0 && currentList.plainCount > 0) {
    mixedTaskLists.push(currentList.startLine);
  }

  return { embedBlocks, mixedTaskLists, proseText: proseLines.join('\n') };
}

function stripJsComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

export function validateWikiRepo(targetRoot) {
  const rootAbs = path.resolve(targetRoot);
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    errors.push(`Target directory does not exist: ${rootAbs}`);
    return { errors, warnings };
  }

  const markdownFiles = [];
  const sidecarFiles = [];
  const embedFiles = [];

  function walk(dirAbs) {
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory() && entry.name.startsWith('.')) continue;

      const full = path.join(dirAbs, entry.name);
      const rel = path.relative(rootAbs, full).split(path.sep).join('/');

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (rel.startsWith('embeds/')) {
          embedFiles.push({ abs: full, rel });
        } else if (entry.name.endsWith('.comments.json')) {
          sidecarFiles.push({ abs: full, rel });
        } else if (entry.name.endsWith('.md') && !IGNORED_DOC_FILENAMES.has(entry.name)) {
          markdownFiles.push({ abs: full, rel });
        }
      }
    }
  }

  walk(rootAbs);

  const proseByDoc = new Map();

  // 1. Validate Markdown documents & fenced embed blocks
  for (const doc of markdownFiles) {
    const raw = fs.readFileSync(doc.abs, 'utf8');
    const { embedBlocks, mixedTaskLists, proseText } = scanTopLevelFencesAndLists(raw);
    proseByDoc.set(doc.rel, { raw, proseText });

    for (const listLine of mixedTaskLists) {
      warnings.push(
        `${doc.rel}:${listLine}: Mixed task items ([ ]/[x]) and plain bullets in the same list will render as a plain bullet list in FocusWiki.`
      );
    }

    for (const block of embedBlocks) {
      const parsed = parseEmbedBlockText(block.value);
      if (!parsed.ok) {
        errors.push(
          `${doc.rel}:${block.line}: Malformed \`\`\`embed block will degrade to inert embed-raw: ${parsed.reason}`
        );
        continue;
      }
      if (parsed.warning) {
        warnings.push(`${doc.rel}:${block.line}: ${parsed.warning}`);
      }

      const src = parsed.descriptor.src;
      if (!src.startsWith('embeds/') || src.includes('..') || src.includes('\\')) {
        errors.push(
          `${doc.rel}:${block.line}: Embed src "${src}" must reside inside "embeds/" using forward slashes and no "..".`
        );
        continue;
      }

      const ext = path.extname(src).toLowerCase();
      if (!ALLOWED_EMBED_EXTENSIONS.has(ext)) {
        errors.push(`${doc.rel}:${block.line}: Embed src "${src}" uses disallowed extension "${ext}".`);
        continue;
      }

      const embedAbs = path.resolve(rootAbs, src);
      if (!embedAbs.startsWith(rootAbs + path.sep) || !fs.existsSync(embedAbs) || !fs.statSync(embedAbs).isFile()) {
        errors.push(`${doc.rel}:${block.line}: Referenced embed file "${src}" does not exist on disk.`);
      }
    }
  }

  // 2. Validate embed sandbox & CSP invariants
  for (const asset of embedFiles) {
    const ext = path.extname(asset.rel).toLowerCase();
    if (!ALLOWED_EMBED_EXTENSIONS.has(ext)) {
      errors.push(`${asset.rel}: Unsupported embed asset extension "${ext}" (blocked by FocusWiki pathGuard).`);
      continue;
    }

    if (ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css') {
      const content = fs.readFileSync(asset.abs, 'utf8');

      if (ext === '.html') {
        if (/<\s*(?:script|link|img|iframe)\b[^>]*(?:src|href)\s*=\s*["']https?:\/\//i.test(content)) {
          errors.push(
            `${asset.rel}: External http(s):// script/stylesheet/image/iframe URLs are blocked by FocusWiki's sandbox CSP.`
          );
        }
        if (!/<meta\s+name=["']color-scheme["']\s+content=["'][^"']*dark/i.test(content)) {
          warnings.push(
            `${asset.rel}: Missing <meta name="color-scheme" content="light dark" /> for automatic dark-mode contrast.`
          );
        }
        if (!/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i.test(content)) {
          warnings.push(`${asset.rel}: Missing @media (prefers-color-scheme: dark) token overrides.`);
        }
        if (/(?:html|body)\s*\{[^}]*\bheight\s*:\s*100d?vh\b/i.test(content)) {
          warnings.push(
            `${asset.rel}: Avoid height: 100vh/100dvh on html/body inside embeds; use html { height: auto } so scrollHeight auto-fits.`
          );
        }
      }

      if (ext === '.css' || ext === '.html') {
        if (/@import\s+(?:url\()?\s*["']?https?:\/\//i.test(content)) {
          errors.push(`${asset.rel}: External CSS @import URLs are blocked by FocusWiki's sandbox CSP.`);
        }
      }

      if (ext === '.js' || ext === '.mjs' || ext === '.html') {
        const scriptBody =
          ext === '.html'
            ? Array.from(content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
                .map((m) => m[1])
                .join('\n')
            : content;
        const cleanJs = stripJsComments(scriptBody);

        if (/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(cleanJs) || /\bdocument\.cookie\b/.test(cleanJs)) {
          errors.push(
            `${asset.rel}: Storage/cookie APIs (localStorage, sessionStorage, indexedDB, document.cookie) throw SecurityError inside FocusWiki's opaque-origin <iframe sandbox="allow-scripts">.`
          );
        }
        if (/\bfetch\s*\(\s*["'`](?:https?:\/\/|\/api\/)/.test(cleanJs) || /\bnew\s+WebSocket\s*\(/.test(cleanJs)) {
          errors.push(
            `${asset.rel}: Network requests (fetch/WebSocket) are blocked by FocusWiki's CSP (connect-src 'none').`
          );
        }
      }
    }
  }

  // 3. Validate .comments.json sidecar files
  for (const sidecar of sidecarFiles) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(sidecar.abs, 'utf8'));
    } catch (err) {
      errors.push(`${sidecar.rel}: Invalid JSON (${err.message}).`);
      continue;
    }

    const expectedDoc = `${sidecar.rel.slice(0, -'.comments.json'.length)}.md`;
    if (parsed.version !== 1) {
      errors.push(`${sidecar.rel}: "version" must be 1.`);
    }
    if (parsed.document !== expectedDoc) {
      errors.push(`${sidecar.rel}: "document" is "${parsed.document}", expected "${expectedDoc}".`);
    }
    if (!Array.isArray(parsed.threads)) {
      errors.push(`${sidecar.rel}: "threads" must be an array.`);
      continue;
    }

    const docInfo = proseByDoc.get(expectedDoc);
    if (!docInfo) {
      errors.push(`${sidecar.rel}: Target Markdown document "${expectedDoc}" does not exist.`);
      continue;
    }

    for (const thread of parsed.threads) {
      const tid = thread?.id || '<missing-id>';
      if (!thread?.id || typeof thread.id !== 'string') {
        errors.push(`${sidecar.rel}: Thread is missing string "id".`);
      }
      if (thread?.status !== 'open' && thread?.status !== 'resolved') {
        errors.push(`${sidecar.rel} (${tid}): Thread "status" must be "open" or "resolved".`);
      }
      const quote = thread?.anchor?.quote;
      if (typeof quote !== 'string' || !quote.trim()) {
        errors.push(`${sidecar.rel} (${tid}): Thread "anchor.quote" must be a non-empty string.`);
        continue;
      }
      if (!Array.isArray(thread.messages) || thread.messages.length === 0) {
        errors.push(`${sidecar.rel} (${tid}): Thread must contain at least one message in "messages".`);
      }
      if (!Array.isArray(thread.history) || thread.history.length === 0) {
        errors.push(`${sidecar.rel} (${tid}): Thread must contain at least one event in "history".`);
      }

      if (!docInfo.proseText.includes(quote) && !docInfo.raw.includes(quote)) {
        warnings.push(
          `${sidecar.rel} (${tid}): Anchor quote "${quote.slice(0, 60)}" was not found in "${expectedDoc}" (thread will appear orphaned). Remember quotes match plain rendered text without Markdown ** or \` marks.`
        );
      }
    }
  }

  return {
    errors,
    warnings,
    stats: {
      docs: markdownFiles.length,
      embeds: embedFiles.length,
      sidecars: sidecarFiles.length
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || '.';
  const { errors, warnings, stats } = validateWikiRepo(target);

  for (const w of warnings) {
    console.warn(`WARN:  ${w}`);
  }
  for (const e of errors) {
    console.error(`ERROR: ${e}`);
  }

  if (errors.length > 0) {
    console.error(
      `\nValidation failed with ${errors.length} error(s) and ${warnings.length} warning(s).`
    );
    process.exit(1);
  }

  console.log(
    `FocusWiki validation passed (${stats.docs} docs, ${stats.embeds} embed assets, ${stats.sidecars} comment sidecars${warnings.length ? `, ${warnings.length} warning(s)` : ''}).`
  );
}
