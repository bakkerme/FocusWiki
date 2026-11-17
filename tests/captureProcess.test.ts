import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CaptureManifest,
  buildBrowserRunScript,
  createCapturePlan,
  importCompetitorPng,
  inspectPngFile,
  loadCaptureManifest,
  recordTargetCapture,
  recordTargetFailure,
  selectCaptureTargets,
  validateCapturePacket
} from '../scripts/captureLib';
import { assertLocalFocusWikiBaseUrl, runPlaywrightCapture } from '../scripts/captureRunner';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'config', 'capture-manifest.json');

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createSyntheticPng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Minimal 1-scanline compressed data (valid header + IHDR is sufficient for PNG inspection)
  const rawRow = Buffer.alloc(1 + Math.min(width, 4) * 3, 0);
  const idat = zlib.deflateSync(rawRow);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const tempDirs: string[] = [];
function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-capture-test-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.copyFileSync(MANIFEST_PATH, path.join(dir, 'config', 'capture-manifest.json'));
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Screenshot capture manifest & packet workflow', () => {
  it('loads capture-manifest.json, selects targets, and generates valid async run_script code', () => {
    const manifest = loadCaptureManifest(MANIFEST_PATH);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.targets.length).toBeGreaterThanOrEqual(5);

    const defaults = selectCaptureTargets(manifest, {});
    expect(defaults.map((t) => t.id)).toEqual([
      'doc-initial-read',
      'doc-visual-edit',
      'source-editing',
      'review-thread-open',
      'embed-visible',
      'narrow-viewport'
    ]);

    const subset = selectCaptureTargets(manifest, {
      targetIds: ['narrow-viewport', 'helios-lab-embed']
    });
    expect(subset.map((t) => t.id)).toEqual(['narrow-viewport', 'helios-lab-embed']);

    expect(() =>
      selectCaptureTargets(manifest, { targetIds: ['nonexistent-screen'] })
    ).toThrow(/Unknown capture target/);

    for (const target of manifest.targets) {
      const code = buildBrowserRunScript(target, 'http://127.0.0.1:8088');
      expect(() => {
        // Verify generated script has valid async JS syntax
        new Function('return async (navigate, waitFor, evaluate) => {\n' + code + '\n}');
      }).not.toThrow();
      expect(code).toContain('document.fonts.ready');
      expect(code).toContain('assertSavedState');
    }
  });

  it('plans, records valid PNGs, catches viewport mismatches, and validates packets', async () => {
    const tmpProj = makeTempProject();
    const plan = await createCapturePlan({
      projectRoot: tmpProj,
      manifestPath: 'config/capture-manifest.json',
      packetId: 'unit-packet',
      targetIds: ['doc-initial-read', 'narrow-viewport'],
      skipLiveProbe: true
    });

    expect(plan.packetManifest.plannedTargets).toHaveLength(2);

    // Partial validation fails when planned targets are not yet recorded
    const beforeRecord = validateCapturePacket({
      projectRoot: tmpProj,
      packetIdOrDir: 'unit-packet'
    });
    expect(beforeRecord.valid).toBe(false);
    expect(beforeRecord.issues.some((i) => i.includes('doc-initial-read'))).toBe(true);

    const desktopPng = path.join(tmpProj, 'raw-desktop.png');
    const narrowPng = path.join(tmpProj, 'raw-narrow.png');
    fs.writeFileSync(desktopPng, createSyntheticPng(1440, 900));
    fs.writeFileSync(narrowPng, createSyntheticPng(768, 960));

    // Rejects mismatched PNG dimensions
    expect(() =>
      recordTargetCapture({
        projectRoot: tmpProj,
        packetIdOrDir: 'unit-packet',
        targetId: 'doc-initial-read',
        sourceImagePath: narrowPng
      })
    ).toThrow(/PNG pixel dimension mismatch/);

    // Records matching PNGs with readiness telemetry
    const rec1 = recordTargetCapture({
      projectRoot: tmpProj,
      packetIdOrDir: 'unit-packet',
      targetId: 'doc-initial-read',
      sourceImagePath: desktopPng,
      telemetry: {
        status: 'ready',
        targetId: 'doc-initial-read',
        url: 'http://127.0.0.1:8088/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md',
        elapsedMs: 920
      }
    });
    expect(rec1.viewport.pngPixels).toEqual({ width: 1440, height: 900 });
    expect(rec1.replacesTargetId).toBe('doc-initial-edit');

    recordTargetCapture({
      projectRoot: tmpProj,
      packetIdOrDir: 'unit-packet',
      targetId: 'narrow-viewport',
      sourceImagePath: narrowPng,
      telemetry: {
        status: 'ready',
        targetId: 'narrow-viewport',
        url: 'http://127.0.0.1:8088/?project=cindervault-rpg&doc=docs%2Fvault-breach-action.md',
        elapsedMs: 880
      }
    });

    const afterRecord = validateCapturePacket({
      projectRoot: tmpProj,
      packetIdOrDir: 'unit-packet'
    });
    expect(afterRecord.valid).toBe(true);
    expect(afterRecord.checkedScreens).toBe(2);
    expect(afterRecord.issues).toEqual([]);
  });

  it('records structured target failures and surfaces them during validation', async () => {
    const tmpProj = makeTempProject();
    await createCapturePlan({
      projectRoot: tmpProj,
      manifestPath: 'config/capture-manifest.json',
      packetId: 'fail-packet',
      targetIds: ['embed-visible'],
      skipLiveProbe: true
    });

    recordTargetFailure({
      projectRoot: tmpProj,
      packetIdOrDir: 'fail-packet',
      targetId: 'embed-visible',
      reason: 'Readiness assertions timed out: missing iframe.embed-sandbox-iframe',
      telemetry: {
        status: 'failed',
        targetId: 'embed-visible',
        url: 'http://127.0.0.1:8088/',
        elapsedMs: 15000,
        failedStep: 'readiness-assertions',
        missingSelectors: ['iframe.embed-sandbox-iframe']
      }
    });

    const check = validateCapturePacket({
      projectRoot: tmpProj,
      packetIdOrDir: 'fail-packet'
    });
    expect(check.valid).toBe(false);
    expect(check.issues.some((i) => i.includes('embed-visible') && i.includes('readiness-assertions'))).toBe(
      true
    );
  });

  it('imports local competitor PNG references with metadata and rejects remote URLs or corrupt files', async () => {
    const tmpProj = makeTempProject();
    await createCapturePlan({
      projectRoot: tmpProj,
      manifestPath: 'config/capture-manifest.json',
      packetId: 'ref-packet',
      targetIds: ['doc-initial-read'],
      skipLiveProbe: true
    });

    const compPng = path.join(tmpProj, 'user-supplied-competitor.png');
    fs.writeFileSync(compPng, createSyntheticPng(1440, 900));

    // Reject remote URLs (never fetch private/authenticated content)
    expect(() =>
      importCompetitorPng({
        projectRoot: tmpProj,
        sourceImagePath: 'https://example.com/private-screen.png',
        product: 'ExampleWiki',
        screen: 'reader',
        task: 'reading',
        source: 'remote'
      })
    ).toThrow(/only imports local user-provided PNG files/);

    // Reject non-PNG files
    const notPng = path.join(tmpProj, 'not-a-png.png');
    fs.writeFileSync(notPng, 'plain text');
    expect(() => inspectPngFile(notPng)).toThrow(/too small|Invalid PNG/);

    const imported = importCompetitorPng({
      projectRoot: tmpProj,
      sourceImagePath: compPng,
      product: 'Outline Wiki',
      screen: 'Document Reader + Comments',
      task: 'reading-and-inline-feedback',
      viewport: '1440x900',
      source: 'User-captured local PNG from public demo',
      date: '2026-11-15',
      notes: 'Clean viewer mode reference',
      packetIdOrDir: 'ref-packet'
    });

    expect(imported.entry.id).toBe('2026-11-15-outline-wiki-document-reader-comments');
    expect(imported.entry.pngPixels).toEqual({ width: 1440, height: 900 });
    expect(fs.existsSync(imported.storedImagePath)).toBe(true);
    expect(fs.existsSync(imported.storedMetaPath)).toBe(true);

    const partialCheck = validateCapturePacket({
      projectRoot: tmpProj,
      packetIdOrDir: 'ref-packet',
      requireAllPlanned: false
    });
    expect(partialCheck.valid).toBe(true);
    expect(partialCheck.checkedReferences).toBe(1);

    const unknownMetadata = importCompetitorPng({
      projectRoot: tmpProj,
      sourceImagePath: compPng,
      product: 'ExampleWiki',
      screen: 'unknown-origin',
      task: 'reading',
      source: 'User-supplied image; original capture details unavailable'
    });
    expect(unknownMetadata.entry.capturedDate).toBeNull();
    expect(unknownMetadata.entry.declaredViewport).toBeNull();
    expect(unknownMetadata.entry.pngPixels).toEqual({ width: 1440, height: 900 });
    expect(unknownMetadata.entry.importedAt).toBeTruthy();
  });

  it('enforces local/private base-url scope and fails cleanly on unavailable service or partial readiness failure', async () => {
    expect(() => assertLocalFocusWikiBaseUrl('http://127.0.0.1:8088')).not.toThrow();
    expect(() => assertLocalFocusWikiBaseUrl('http://100.117.116.91:8088')).not.toThrow();
    expect(() => assertLocalFocusWikiBaseUrl('https://example.com')).toThrow(/Refusing non-local/);
    expect(() => assertLocalFocusWikiBaseUrl('file:///etc/passwd')).toThrow(/Unsupported protocol/);

    const tmpProj = makeTempProject();

    // Unknown target throws immediately before launching a browser
    await expect(
      runPlaywrightCapture({
        projectRoot: tmpProj,
        manifestPath: 'config/capture-manifest.json',
        packetId: 'bad-target',
        targetIds: ['missing-state-id'],
        baseUrl: 'http://127.0.0.1:18099'
      })
    ).rejects.toThrow(/Unknown capture target/);

    // Unavailable service returns ok:false and records failure so partial validation cannot pass
    const downRes = await runPlaywrightCapture({
      projectRoot: tmpProj,
      manifestPath: 'config/capture-manifest.json',
      packetId: 'service-down',
      targetIds: ['doc-initial-read'],
      baseUrl: 'http://127.0.0.1:18099'
    });
    expect(downRes.ok).toBe(false);
    expect(downRes.validation.valid).toBe(false);
    expect(downRes.failures).toHaveLength(1);
    expect(downRes.failures[0].failedStep).toBe('live-server-probe');

    // Ephemeral local test HTTP server to verify headless Playwright capture + partial packet failure
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'focuswiki-test' }));
        return;
      }
      if (req.url === '/api/projects') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects: [] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
  <body style="margin:0;padding:24px;font-family:sans-serif">
    <div class="workbench">
      <button class="git-status-btn">clean</button>
      <span class="save-badge saved">Saved to disk</span>
      <div class="ProseMirror"><h1>Fixture Ready</h1></div>
    </div>
  </body>
</html>`);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const testManifest: CaptureManifest = {
        schemaVersion: 1,
        appName: 'FocusWiki Test Fixture',
        defaultBaseUrl: baseUrl,
        targets: [
          {
            id: 'ready-state',
            label: 'Ready State',
            defaultSelected: true,
            actualAppState: 'fixture-ready',
            honestStateNote: 'Test fixture state',
            route: '/?doc=ok',
            projectId: 'fixture',
            docPath: 'docs/ok.md',
            captureScope: 'viewport',
            viewport: {
              width: 800,
              height: 600,
              deviceScaleFactor: 1,
              colorScheme: 'light',
              reducedMotion: true
            },
            steps: [{ kind: 'navigate' }],
            readiness: {
              requiredSelectors: ['.workbench', '.ProseMirror h1', '.save-badge.saved'],
              waitForFonts: true,
              waitForVisibleEmbeds: false,
              assertSavedState: true,
              timeoutMs: 4000
            }
          },
          {
            id: 'missing-selector-state',
            label: 'Missing Selector State',
            defaultSelected: true,
            actualAppState: 'fixture-broken',
            honestStateNote: 'Intentionally missing selector',
            route: '/?doc=broken',
            projectId: 'fixture',
            docPath: 'docs/broken.md',
            captureScope: 'viewport',
            viewport: {
              width: 800,
              height: 600,
              deviceScaleFactor: 1,
              colorScheme: 'light',
              reducedMotion: true
            },
            steps: [{ kind: 'navigate' }],
            readiness: {
              requiredSelectors: ['.workbench', '.selector-that-never-renders'],
              waitForFonts: true,
              waitForVisibleEmbeds: false,
              assertSavedState: true,
              timeoutMs: 600
            }
          }
        ]
      };

      const customManifestPath = path.join(tmpProj, 'config', 'test-manifest.json');
      fs.writeFileSync(customManifestPath, JSON.stringify(testManifest, null, 2));

      // Single valid target succeeds end-to-end
      const singleOk = await runPlaywrightCapture({
        projectRoot: tmpProj,
        manifestPath: 'config/test-manifest.json',
        packetId: 'pw-valid',
        targetIds: ['ready-state'],
        baseUrl
      });
      expect(singleOk.ok).toBe(true);
      expect(singleOk.validation.valid).toBe(true);
      expect(singleOk.captured).toHaveLength(1);
      expect(singleOk.captured[0].viewport.pngPixels).toEqual({ width: 800, height: 600 });

      // Partial run (1 ready + 1 missing selector) must NEVER report ok:true
      const partialFail = await runPlaywrightCapture({
        projectRoot: tmpProj,
        manifestPath: 'config/test-manifest.json',
        packetId: 'pw-partial-fail',
        all: true,
        baseUrl
      });
      expect(partialFail.ok).toBe(false);
      expect(partialFail.captured).toHaveLength(1);
      expect(partialFail.failures).toHaveLength(1);
      expect(partialFail.failures[0].targetId).toBe('missing-selector-state');
      expect(partialFail.validation.valid).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);
});
