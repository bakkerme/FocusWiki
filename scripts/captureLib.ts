import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface CaptureViewportSpec {
  width: number;
  height: number;
  deviceScaleFactor: number;
  colorScheme: 'light' | 'dark' | 'system';
  reducedMotion: boolean;
}

export type CaptureStep =
  | { kind: 'navigate' }
  | { kind: 'ensureMode'; mode: 'read' | 'visual' | 'source' }
  | { kind: 'ensureReviewSidebar'; open: boolean; showResolved?: boolean }
  | { kind: 'ensureNavDrawer'; open: boolean }
  | { kind: 'selectThread'; index: number; expandHistory?: boolean }
  | {
      kind: 'selectProseText';
      snippet: string;
      clickCommentPill?: boolean;
      draftText?: string;
    }
  | { kind: 'scrollContainerTop'; selector: string; top: number }
  | {
      kind: 'scrollElementIntoContainer';
      container: string;
      target: string;
      offsetTop?: number;
    }
  | { kind: 'scrollWindowToElement'; target: string; offsetTop?: number };

export interface CaptureReadinessSpec {
  requiredSelectors: string[];
  minTextareaChars?: number;
  waitForFonts: boolean;
  waitForVisibleEmbeds: boolean;
  assertSavedState: boolean;
  timeoutMs: number;
}

export interface CaptureTargetSpec {
  id: string;
  replacesTargetId?: string;
  label: string;
  defaultSelected: boolean;
  actualAppState: string;
  honestStateNote: string;
  route: string;
  projectId: string;
  docPath: string;
  captureScope: 'viewport' | 'full-page';
  initialViewport?: { width: number; height: number };
  initialScrollY?: number;
  viewport: CaptureViewportSpec;
  steps: CaptureStep[];
  readiness: CaptureReadinessSpec;
}

export interface CaptureManifest {
  schemaVersion: number;
  appName: string;
  defaultBaseUrl: string;
  alternateBaseUrls?: string[];
  targets: CaptureTargetSpec[];
}

export interface PngInspection {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  byteSize: number;
  sha256: string;
}

export interface GitRevisionSnapshot {
  sha: string;
  branch: string;
  isClean: boolean;
  dirtyFiles: string[];
}

export interface ProjectRepoSnapshot {
  projectId: string;
  name: string;
  branch: string;
  headSha: string;
  isClean: boolean;
  changedFiles: string[];
}

export interface BrowserCaptureTelemetry {
  status: 'ready' | 'failed';
  targetId: string;
  actualAppState?: string;
  url: string;
  title?: string;
  elapsedMs: number;
  failedStep?: string;
  reason?: string;
  missingSelectors?: string[];
  observedDom?: {
    saveBadgeText: string | null;
    noticeBannerText: string | null;
    activeMode: string | null;
    h1Text: string | null;
    presentSelectors: string[];
  };
  viewportCss?: {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
    sheetScrollTop: number | null;
  };
  readiness?: {
    passed: boolean;
    fontsStatus: string;
    saveBadgeText: string | null;
    textareaChars: number | null;
    checkedSelectors: Record<string, boolean>;
    visibleEmbeds: Array<{
      src: string;
      title: string;
      width: number;
      height: number;
      sandbox: string;
    }>;
    openThreadCount: number;
    activeThreadSelected: boolean;
  };
}

export interface RecordedScreenEntry {
  order: number;
  targetId: string;
  replacesTargetId?: string;
  label: string;
  actualAppState: string;
  honestStateNote: string;
  capturedAt: string;
  url: string;
  route: string;
  projectId: string;
  docPath: string;
  captureScope: 'viewport' | 'full-page';
  viewport: {
    requested: CaptureViewportSpec;
    measuredCss: BrowserCaptureTelemetry['viewportCss'] | null;
    pngPixels: { width: number; height: number };
  };
  revisions: {
    appGit: GitRevisionSnapshot | null;
    projectGit: ProjectRepoSnapshot | null;
  };
  readiness: BrowserCaptureTelemetry['readiness'] | null;
  elapsedMs: number | null;
  file: {
    relativePath: string;
    metaRelativePath: string;
    byteSize: number;
    sha256: string;
  };
}

export interface CaptureFailureEntry {
  targetId: string;
  recordedAt: string;
  url: string;
  failedStep: string;
  reason: string;
  missingSelectors: string[];
  observedDom: BrowserCaptureTelemetry['observedDom'] | null;
}

export interface CompetitorReferenceEntry {
  id: string;
  product: string;
  screen: string;
  task: string;
  declaredViewport: string | null;
  pngPixels: { width: number; height: number };
  source: string;
  capturedDate: string | null;
  importedAt: string;
  notes?: string;
  file: {
    relativePath: string;
    byteSize: number;
    sha256: string;
  };
}

export type CaptureBrowserDriver = 'playwright-chromium' | 'openbot_browser';

export interface CapturePacketManifest {
  schemaVersion: 1;
  packetId: string;
  createdAt: string;
  updatedAt: string;
  baseUrl: string;
  manifestPath: string;
  browserDriver: CaptureBrowserDriver;
  appGit: GitRevisionSnapshot | null;
  projectsGit: Record<string, ProjectRepoSnapshot>;
  plannedTargets: Array<{
    order: number;
    targetId: string;
    label: string;
    actualAppState: string;
    route: string;
    viewport: CaptureViewportSpec;
    scriptRelativePath: string;
  }>;
  captures: RecordedScreenEntry[];
  failures: CaptureFailureEntry[];
  competitorReferences: CompetitorReferenceEntry[];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function ensureSharedDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o770 });
  try {
    fs.chmodSync(dirPath, 0o770);
  } catch {
    // Ignore chmod errors on filesystems that disallow mode changes
  }
}

export function writeSharedFile(filePath: string, data: string | Buffer): void {
  ensureSharedDir(path.dirname(filePath));
  fs.writeFileSync(filePath, data, { mode: 0o660 });
  try {
    fs.chmodSync(filePath, 0o660);
  } catch {
    // Ignore chmod errors if not owner
  }
}

export function copySharedFile(srcPath: string, destPath: string): void {
  ensureSharedDir(path.dirname(destPath));
  fs.copyFileSync(srcPath, destPath);
  try {
    fs.chmodSync(destPath, 0o660);
  } catch {
    // Ignore chmod errors if not owner
  }
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'item';
}

export function loadCaptureManifest(manifestPath: string): CaptureManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Capture manifest not found at ${manifestPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CaptureManifest;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error(`Invalid capture manifest schema in ${manifestPath}`);
  }

  const seenIds = new Set<string>();
  for (const t of raw.targets) {
    if (!t.id || !/^[a-z0-9-]+$/.test(t.id)) {
      throw new Error(`Invalid target id "${String(t.id)}" in manifest`);
    }
    if (seenIds.has(t.id)) {
      throw new Error(`Duplicate target id "${t.id}" in manifest`);
    }
    seenIds.add(t.id);
    if (!t.route.startsWith('/')) {
      throw new Error(`Target "${t.id}" route must start with "/": ${t.route}`);
    }
    if (
      !Number.isInteger(t.viewport?.width) ||
      !Number.isInteger(t.viewport?.height) ||
      t.viewport.width < 280 ||
      t.viewport.height < 280
    ) {
      throw new Error(`Target "${t.id}" has invalid viewport dimensions`);
    }
    if (!Array.isArray(t.readiness?.requiredSelectors) || t.readiness.requiredSelectors.length === 0) {
      throw new Error(`Target "${t.id}" must declare at least one readiness selector`);
    }
  }

  return raw;
}

export function selectCaptureTargets(
  manifest: CaptureManifest,
  options: { targetIds?: string[]; all?: boolean }
): CaptureTargetSpec[] {
  if (options.all) {
    return [...manifest.targets];
  }
  if (options.targetIds && options.targetIds.length > 0) {
    const byId = new Map(manifest.targets.map((t) => [t.id, t]));
    const selected: CaptureTargetSpec[] = [];
    const unknown: string[] = [];
    for (const rawId of options.targetIds) {
      const id = rawId.trim();
      if (!id) continue;
      const found = byId.get(id);
      if (!found) {
        unknown.push(id);
      } else if (!selected.some((s) => s.id === id)) {
        selected.push(found);
      }
    }
    if (unknown.length > 0) {
      const valid = manifest.targets.map((t) => t.id).join(', ');
      throw new Error(`Unknown capture target(s): ${unknown.join(', ')}. Available targets: ${valid}`);
    }
    if (selected.length === 0) {
      throw new Error('No capture targets selected.');
    }
    return selected;
  }

  const defaults = manifest.targets.filter((t) => t.defaultSelected);
  return defaults.length > 0 ? defaults : [...manifest.targets];
}

export function inspectPngFile(pngPath: string): PngInspection {
  if (!fs.existsSync(pngPath)) {
    throw new Error(`PNG file does not exist: ${pngPath}`);
  }
  const stat = fs.statSync(pngPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${pngPath}`);
  }
  if (stat.size < 33) {
    throw new Error(`File is too small (${stat.size} bytes) to be a valid PNG: ${pngPath}`);
  }

  const buf = fs.readFileSync(pngPath);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`Invalid PNG header signature in ${pngPath}`);
  }

  const ihdrLength = buf.readUInt32BE(8);
  const ihdrType = buf.subarray(12, 16).toString('ascii');
  if (ihdrType !== 'IHDR' || ihdrLength !== 13) {
    throw new Error(`Corrupt PNG IHDR chunk in ${pngPath} (type=${ihdrType}, len=${ihdrLength})`);
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid PNG pixel dimensions (${width}x${height}) in ${pngPath}`);
  }

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  return {
    width,
    height,
    bitDepth,
    colorType,
    byteSize: buf.length,
    sha256
  };
}

export function readGitRevisionSnapshot(repoDir: string): GitRevisionSnapshot | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const dirtyFiles = porcelain
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      sha,
      branch,
      isClean: dirtyFiles.length === 0,
      dirtyFiles
    };
  } catch {
    return null;
  }
}

export async function probeLiveCairnServer(
  baseUrl: string
): Promise<{
  reachable: boolean;
  health?: Record<string, unknown>;
  projectsGit: Record<string, ProjectRepoSnapshot>;
  error?: string;
}> {
  const trimmed = baseUrl.replace(/\/+$/, '');
  try {
    const healthRes = await fetch(`${trimmed}/healthz`);
    if (!healthRes.ok) {
      return {
        reachable: false,
        projectsGit: {},
        error: `Health endpoint ${trimmed}/healthz returned HTTP ${healthRes.status}`
      };
    }
    const health = (await healthRes.json()) as Record<string, unknown>;

    const projRes = await fetch(`${trimmed}/api/projects`);
    const projectsGit: Record<string, ProjectRepoSnapshot> = {};
    if (projRes.ok) {
      const payload = (await projRes.json()) as {
        projects?: Array<{
          id: string;
          name: string;
          git: {
            branch: string;
            headSha: string;
            isClean: boolean;
            changedFiles: Array<{ path: string }>;
          };
        }>;
      };
      for (const p of payload.projects ?? []) {
        projectsGit[p.id] = {
          projectId: p.id,
          name: p.name,
          branch: p.git.branch,
          headSha: p.git.headSha,
          isClean: p.git.isClean,
          changedFiles: (p.git.changedFiles ?? []).map((f) => f.path)
        };
      }
    }

    return { reachable: true, health, projectsGit };
  } catch (err) {
    return {
      reachable: false,
      projectsGit: {},
      error: `Unable to reach ${trimmed}: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export interface InPageCaptureSpec {
  targetId: string;
  actualAppState: string;
  fullUrl: string;
  steps: CaptureStep[];
  readiness: CaptureReadinessSpec;
}

export interface InPageCaptureResult {
  ok: boolean;
  stepName: string;
  reason?: string;
  missingSelectors: string[];
  title?: string;
  url: string;
  observedDom: BrowserCaptureTelemetry['observedDom'] | null;
  viewportCss?: BrowserCaptureTelemetry['viewportCss'];
  readiness?: BrowserCaptureTelemetry['readiness'];
}

export function buildTargetInPageSpec(target: CaptureTargetSpec, baseUrl: string): InPageCaptureSpec {
  const fullUrl = `${baseUrl.replace(/\/+$/, '')}${target.route}`;
  return {
    targetId: target.id,
    actualAppState: target.actualAppState,
    fullUrl,
    steps: target.steps,
    readiness: target.readiness
  };
}

export const CAIRN_APP_BOOT_CHECK_EXPRESSION = `(() => {
  const wb = document.querySelector(".workbench");
  const gitBtn = document.querySelector(".git-status-btn");
  const docReady =
    Boolean(document.querySelector(".ProseMirror")) ||
    Boolean(document.querySelector("textarea.markdown-source-editor"));
  return Boolean(wb && gitBtn && docReady);
})()`;

/**
 * Shared in-page step and readiness expression used by both the unattended Playwright
 * runner (`scripts/captureRunner.ts`) and optional `openbot_browser.run_script` inspection.
 * Consumes only validated `InPageCaptureSpec` JSON data (never arbitrary shell scripts).
 */
export function buildInPageStepAndReadinessExpression(spec: InPageCaptureSpec): string {
  const specJson = JSON.stringify(spec);
  return `(async () => {
    const spec = ${specJson};
    let stepName = "init";
    const waitCond = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 40));
      }
      return Boolean(fn());
    };

    try {
      for (const s of spec.steps) {
        stepName = s.kind;
        if (s.kind === "navigate") continue;

        if (s.kind === "ensureMode") {
          const getMode = () =>
            document.querySelector(".workbench")?.getAttribute("data-workspace-mode") || null;

          if (s.mode === "read") {
            if (getMode() !== "read") {
              const doneBtn = document.querySelector(".btn-done-editing");
              if (!doneBtn) throw new Error("Done editing button (.btn-done-editing) not found");
              doneBtn.click();
            }
            const ok = await waitCond(
              () => getMode() === "read" && Boolean(document.querySelector(".ProseMirror"))
            );
            if (!ok) throw new Error("Timed out switching mode to read");
            continue;
          }

          if (getMode() === "read") {
            const editBtn = document.querySelector(".btn-edit-entry");
            if (!editBtn) throw new Error("Edit entry button (.btn-edit-entry) not found");
            editBtn.click();
            const enteredEdit = await waitCond(() => Boolean(document.querySelector(".mode-switch")));
            if (!enteredEdit) throw new Error("Authoring mode switch did not appear after clicking Edit");
          }

          const wantedLabel = s.mode === "source" ? "Markdown source" : "Visual editor";
          const buttons = Array.from(document.querySelectorAll(".mode-switch button"));
          const btn = buttons.find((b) => {
            const txt = (b.textContent || "").trim();
            return txt === wantedLabel || (s.mode === "visual" && txt === "Visual");
          });
          if (!btn) throw new Error("Mode switch button not found: " + wantedLabel);
          if (!btn.classList.contains("active")) btn.click();
          const ok = await waitCond(() =>
            s.mode === "source"
              ? Boolean(document.querySelector("textarea.markdown-source-editor"))
              : getMode() === "visual" && Boolean(document.querySelector(".ProseMirror"))
          );
          if (!ok) throw new Error("Timed out switching mode to " + wantedLabel);
          continue;
        }

        if (s.kind === "ensureReviewSidebar") {
          const isSidebarVisible = () => {
            const el = document.querySelector(".review-sidebar");
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const currentlyOpen = isSidebarVisible();
          if (currentlyOpen !== s.open) {
            if (!s.open) {
              const closeBtn = document.querySelector(".review-sidebar .panel-close-btn");
              if (closeBtn) {
                closeBtn.click();
              } else {
                const toggleBtn = document.querySelector(".review-toggle-btn");
                if (!toggleBtn) throw new Error("Review sidebar toggle button not found");
                toggleBtn.click();
              }
            } else {
              const toggleBtn =
                document.querySelector(".review-toggle-btn") ||
                Array.from(document.querySelectorAll(".repo-topbar button")).find((b) => {
                  const txt = (b.textContent || "").trim();
                  return txt === "Hide review" || txt.startsWith("Review");
                });
              if (!toggleBtn) throw new Error("Review sidebar toggle button not found");
              toggleBtn.click();
            }
          }
          if (s.open) {
            const ok = await waitCond(() => isSidebarVisible());
            if (!ok) throw new Error("Review sidebar did not open");
            if (typeof s.showResolved === "boolean") {
              const cb = document.querySelector(".review-sidebar input[type=checkbox]");
              if (!cb) throw new Error("Show resolved checkbox not found");
              if (cb.checked !== s.showResolved) {
                cb.click();
                await new Promise((r) => requestAnimationFrame(r));
              }
            }
          } else {
            await waitCond(() => !isSidebarVisible(), 3000);
          }
          continue;
        }

        if (s.kind === "ensureNavDrawer") {
          const isNavVisible = () => {
            const el = document.querySelector(".nav-sidebar");
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          if (isNavVisible() !== s.open) {
            if (s.open) {
              const navBtn =
                document.querySelector(".nav-toggle-btn") ||
                document.querySelector(".mobile-nav-btn");
              if (!navBtn) throw new Error("Navigation toggle button not found");
              navBtn.click();
            } else {
              const closeBtn =
                document.querySelector(".nav-sidebar .panel-close-btn") ||
                document.querySelector(".nav-sidebar .mobile-drawer-close");
              if (closeBtn) closeBtn.click();
            }
          }
          const ok = await waitCond(() => isNavVisible() === s.open, 3000);
          if (!ok) throw new Error("Navigation drawer did not reach open=" + String(s.open));
          continue;
        }

        if (s.kind === "selectThread") {
          const hasCard = await waitCond(
            () => document.querySelectorAll(".review-sidebar .thread-card").length > s.index
          );
          if (!hasCard) throw new Error("Thread card index out of range: " + s.index);
          const cards = Array.from(document.querySelectorAll(".review-sidebar .thread-card"));
          const card = cards[s.index];
          card.click();
          await waitCond(() => card.classList.contains("active"), 3000);
          if (s.expandHistory) {
            const histBtn = Array.from(card.querySelectorAll("button")).find((b) =>
              ((b.textContent || "").trim()).startsWith("History (")
            );
            if (histBtn) histBtn.click();
          }
          await new Promise((r) => requestAnimationFrame(r));
          continue;
        }

        if (s.kind === "selectProseText") {
          const prose = document.querySelector(".ProseMirror");
          if (!prose) throw new Error(".ProseMirror not found for selectProseText");
          const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
          let matchedNode = null;
          let matchedIdx = -1;
          let node = walker.nextNode();
          while (node) {
            const txt = node.nodeValue || "";
            const idx = txt.indexOf(s.snippet);
            if (idx >= 0) {
              matchedNode = node;
              matchedIdx = idx;
              break;
            }
            node = walker.nextNode();
          }
          if (!matchedNode || matchedIdx < 0) {
            throw new Error("Text snippet not found in .ProseMirror: " + s.snippet);
          }
          const range = document.createRange();
          range.setStart(matchedNode, matchedIdx);
          range.setEnd(matchedNode, matchedIdx + s.snippet.length);
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          document.dispatchEvent(new Event("selectionchange"));
          const popOk = await waitCond(
            () => Boolean(document.querySelector(".selection-comment-popover")),
            3000
          );
          if (!popOk) throw new Error("Selection comment popover did not appear");
          if (s.clickCommentPill) {
            const pillBtn = document.querySelector(".selection-comment-popover");
            if (!pillBtn) throw new Error("Selection comment button missing");
            pillBtn.click();
            const composerOk = await waitCond(
              () => Boolean(document.querySelector(".review-sidebar .composer-textarea")),
              3000
            );
            if (!composerOk) throw new Error("Review composer did not open from selection pill");
            if (typeof s.draftText === "string") {
              const ta = document.querySelector(".review-sidebar .composer-textarea");
              if (ta) {
                const setter = Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype,
                  "value"
                )?.set;
                if (setter) {
                  setter.call(ta, s.draftText);
                } else {
                  ta.value = s.draftText;
                }
                ta.dispatchEvent(new Event("input", { bubbles: true }));
              }
            }
          }
          await new Promise((r) => requestAnimationFrame(r));
          continue;
        }

        if (s.kind === "scrollContainerTop") {
          const el = document.querySelector(s.selector);
          if (!el) throw new Error("Scroll container not found: " + s.selector);
          const oy = window.getComputedStyle(el).overflowY;
          if (oy === "auto" || oy === "scroll") {
            el.scrollTop = s.top;
          } else {
            window.scrollTo(0, s.top);
          }
          await new Promise((r) => requestAnimationFrame(r));
          continue;
        }

        if (s.kind === "scrollElementIntoContainer") {
          const ok = await waitCond(
            () => Boolean(document.querySelector(s.container) && document.querySelector(s.target))
          );
          if (!ok) throw new Error("Missing container or target: " + s.container + " -> " + s.target);
          const container = document.querySelector(s.container);
          const targetEl = document.querySelector(s.target);
          const tRect = targetEl.getBoundingClientRect();
          const desiredOffset = typeof s.offsetTop === "number" ? s.offsetTop : 48;
          const oy = window.getComputedStyle(container).overflowY;
          if (oy === "auto" || oy === "scroll") {
            const cRect = container.getBoundingClientRect();
            container.scrollTop = Math.max(0, container.scrollTop + (tRect.top - cRect.top) - desiredOffset);
          } else {
            const headerOffset = (document.querySelector(".repo-topbar")?.getBoundingClientRect().height || 48) + desiredOffset;
            window.scrollTo(0, Math.max(0, window.scrollY + tRect.top - headerOffset));
          }
          await new Promise((r) => requestAnimationFrame(r));
          continue;
        }

        if (s.kind === "scrollWindowToElement") {
          const ok = await waitCond(() => Boolean(document.querySelector(s.target)));
          if (!ok) throw new Error("Target not found for scrollWindowToElement: " + s.target);
          const targetEl = document.querySelector(s.target);
          const rect = targetEl.getBoundingClientRect();
          const desiredOffset = typeof s.offsetTop === "number" ? s.offsetTop : 0;
          window.scrollTo(0, Math.max(0, window.scrollY + rect.top - desiredOffset));
          await new Promise((r) => requestAnimationFrame(r));
          continue;
        }
      }

      stepName = "readiness-assertions";
      const readiness = spec.readiness;
      const deadline = Date.now() + (readiness.timeoutMs || 12000);
      const checkVisible = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      if (readiness.waitForFonts && document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }

      while (Date.now() < deadline) {
        const missing = readiness.requiredSelectors.filter((sel) => !checkVisible(sel));
        let textareaOk = true;
        if (typeof readiness.minTextareaChars === "number") {
          const ta = document.querySelector("textarea.markdown-source-editor");
          textareaOk = Boolean(ta && typeof ta.value === "string" && ta.value.length >= readiness.minTextareaChars);
        }
        let savedOk = true;
        if (readiness.assertSavedState) {
          const wbSaved =
            document.querySelector('.workbench')?.getAttribute('data-save-state') === 'saved';
          savedOk =
            (wbSaved || Boolean(document.querySelector('.save-badge.saved'))) &&
            !document.querySelector('.save-badge.conflict');
        }
        let embedsOk = true;
        if (readiness.waitForVisibleEmbeds) {
          const iframes = Array.from(document.querySelectorAll("iframe.embed-sandbox-iframe")).filter((f) => {
            const r = f.getBoundingClientRect();
            return r.bottom > 0 && r.top < window.innerHeight;
          });
          embedsOk =
            iframes.length > 0 &&
            iframes.every((f) => {
              const r = f.getBoundingClientRect();
              const srcAttr = f.getAttribute("src") || "";
              const wrap = f.closest(".embed-frame-wrapper");
              const sizingMode = wrap ? wrap.getAttribute("data-sizing-mode") : "auto";
              return (
                r.width >= 200 &&
                r.height >= 120 &&
                srcAttr.startsWith("/embed-sandbox/") &&
                sizingMode !== "measuring"
              );
            });
        }
        if (missing.length === 0 && textareaOk && savedOk && embedsOk) {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          break;
        }
        await new Promise((r) => setTimeout(r, 60));
      }

      const checkedSelectors = {};
      const finalMissing = [];
      for (const sel of readiness.requiredSelectors) {
        const ok = checkVisible(sel);
        checkedSelectors[sel] = ok;
        if (!ok) finalMissing.push(sel);
      }

      const ta = document.querySelector("textarea.markdown-source-editor");
      const textareaChars = ta && typeof ta.value === "string" ? ta.value.length : null;
      if (typeof readiness.minTextareaChars === "number" && (textareaChars === null || textareaChars < readiness.minTextareaChars)) {
        finalMissing.push("textarea.markdown-source-editor[minChars=" + readiness.minTextareaChars + "]");
      }

      const saveBadge = document.querySelector(".save-badge");
      const wbSaveState = document.querySelector(".workbench")?.getAttribute("data-save-state") || null;
      const saveBadgeText = saveBadge
        ? (saveBadge.textContent || "").trim()
        : wbSaveState === "saved"
          ? "Saved (read-clean)"
          : null;
      if (
        readiness.assertSavedState &&
        wbSaveState !== "saved" &&
        !document.querySelector(".save-badge.saved")
      ) {
        finalMissing.push(
          ".workbench[data-save-state=saved] or .save-badge.saved (observed: " +
            String(saveBadgeText) +
            ")"
        );
      }

      const visibleEmbeds = Array.from(document.querySelectorAll(".embed-frame-wrapper"))
        .map((wrap) => {
          const iframe = wrap.querySelector("iframe.embed-sandbox-iframe");
          if (!iframe) return null;
          const r = iframe.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= window.innerHeight) return null;
          return {
            src: (wrap.querySelector(".embed-frame-src")?.textContent || "").trim(),
            title: iframe.getAttribute("title") || "",
            width: Math.round(r.width),
            height: Math.round(r.height),
            sandbox: iframe.getAttribute("sandbox") || ""
          };
        })
        .filter(Boolean);

      if (readiness.waitForVisibleEmbeds && visibleEmbeds.length === 0) {
        finalMissing.push("visible iframe.embed-sandbox-iframe inside viewport");
      }

      const sheetEl = document.querySelector(".sheet-scroll");
      const wbMode = document.querySelector(".workbench")?.getAttribute("data-workspace-mode");
      const activeModeBtn = document.querySelector(".mode-switch button.active");
      const activeModeLabel =
        wbMode === "read"
          ? "Read"
          : activeModeBtn
            ? (activeModeBtn.textContent || "").trim()
            : wbMode || null;
      const noticeEl = document.querySelector(".notice-banner span");
      const h1El = document.querySelector(".ProseMirror h1");

      return {
        ok: finalMissing.length === 0,
        stepName,
        missingSelectors: finalMissing,
        title: document.title,
        url: window.location.href,
        observedDom: {
          saveBadgeText,
          noticeBannerText: noticeEl ? (noticeEl.textContent || "").trim() : null,
          activeMode: activeModeLabel,
          h1Text: h1El ? (h1El.textContent || "").trim() : null,
          presentSelectors: Object.keys(checkedSelectors).filter((k) => checkedSelectors[k])
        },
        viewportCss: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          sheetScrollTop: sheetEl
            ? ['auto', 'scroll'].includes(window.getComputedStyle(sheetEl).overflowY)
              ? Math.round(sheetEl.scrollTop)
              : Math.round(window.scrollY)
            : null
        },
        readiness: {
          passed: finalMissing.length === 0,
          fontsStatus: document.fonts ? document.fonts.status : "unknown",
          saveBadgeText,
          textareaChars,
          checkedSelectors,
          visibleEmbeds,
          openThreadCount: document.querySelectorAll(".review-sidebar .thread-card").length,
          activeThreadSelected: Boolean(document.querySelector(".review-sidebar .thread-card.active"))
        }
      };
    } catch (innerErr) {
      return {
        ok: false,
        stepName,
        reason: innerErr && innerErr.message ? String(innerErr.message) : String(innerErr),
        missingSelectors: [],
        url: window.location.href,
        observedDom: {
          saveBadgeText: (document.querySelector(".save-badge")?.textContent || "").trim() || null,
          noticeBannerText: (document.querySelector(".notice-banner span")?.textContent || "").trim() || null,
          activeMode: (document.querySelector(".mode-switch button.active")?.textContent || "").trim() || null,
          h1Text: (document.querySelector(".ProseMirror h1")?.textContent || "").trim() || null,
          presentSelectors: [".workbench", ".nav-sidebar", ".repo-topbar", ".ProseMirror", "textarea.markdown-source-editor", ".review-sidebar"].filter((s) => Boolean(document.querySelector(s)))
        }
      };
    }
  })()`;
}

export function toBrowserCaptureTelemetry(
  spec: InPageCaptureSpec,
  pageResult: InPageCaptureResult,
  elapsedMs: number
): BrowserCaptureTelemetry {
  if (!pageResult.ok) {
    return {
      status: 'failed',
      targetId: spec.targetId,
      actualAppState: spec.actualAppState,
      url: pageResult.url || spec.fullUrl,
      elapsedMs,
      failedStep: pageResult.stepName || 'apply-steps-and-assert',
      reason:
        pageResult.reason ||
        `Readiness assertions timed out: missing ${(pageResult.missingSelectors || []).join(', ')}`,
      missingSelectors: pageResult.missingSelectors || [],
      observedDom: pageResult.observedDom ?? undefined
    };
  }

  return {
    status: 'ready',
    targetId: spec.targetId,
    actualAppState: spec.actualAppState,
    url: pageResult.url || spec.fullUrl,
    title: pageResult.title,
    elapsedMs,
    viewportCss: pageResult.viewportCss,
    readiness: pageResult.readiness
  };
}

/**
 * Generates a self-contained script for `openbot_browser.run_script` that reuses
 * the shared step and readiness expressions (`CAIRN_APP_BOOT_CHECK_EXPRESSION` and
 * `buildInPageStepAndReadinessExpression`).
 */
export function buildBrowserRunScript(target: CaptureTargetSpec, baseUrl: string): string {
  const spec = buildTargetInPageSpec(target, baseUrl);
  const inPageExpr = buildInPageStepAndReadinessExpression(spec);

  return `const startedAt = Date.now();
let currentStep = "navigate";

try {
  await navigate(${JSON.stringify(spec.fullUrl)});

  currentStep = "wait-app-boot";
  await waitFor(() => ${CAIRN_APP_BOOT_CHECK_EXPRESSION});

  currentStep = "apply-steps-and-assert";
  const pageResult = await evaluate(${JSON.stringify(inPageExpr)});

  if (!pageResult.ok) {
    return {
      status: "failed",
      targetId: ${JSON.stringify(spec.targetId)},
      actualAppState: ${JSON.stringify(spec.actualAppState)},
      url: pageResult.url || ${JSON.stringify(spec.fullUrl)},
      elapsedMs: Date.now() - startedAt,
      failedStep: pageResult.stepName || currentStep,
      reason: pageResult.reason || ("Readiness assertions timed out: missing " + (pageResult.missingSelectors || []).join(", ")),
      missingSelectors: pageResult.missingSelectors || [],
      observedDom: pageResult.observedDom || null
    };
  }

  return {
    status: "ready",
    targetId: ${JSON.stringify(spec.targetId)},
    actualAppState: ${JSON.stringify(spec.actualAppState)},
    url: pageResult.url,
    title: pageResult.title,
    elapsedMs: Date.now() - startedAt,
    viewportCss: pageResult.viewportCss,
    readiness: pageResult.readiness
  };
} catch (err) {
  return {
    status: "failed",
    targetId: ${JSON.stringify(spec.targetId)},
    actualAppState: ${JSON.stringify(spec.actualAppState)},
    url: ${JSON.stringify(spec.fullUrl)},
    elapsedMs: Date.now() - startedAt,
    failedStep: currentStep,
    reason: err && err.message ? String(err.message) : String(err),
    missingSelectors: [],
    observedDom: null
  };
}
`;
}

export function resolvePacketDir(projectRoot: string, packetIdOrPath: string): string {
  if (path.isAbsolute(packetIdOrPath) || packetIdOrPath.includes(path.sep)) {
    return path.resolve(projectRoot, packetIdOrPath);
  }
  return path.join(projectRoot, 'captures', 'packets', packetIdOrPath);
}

export async function createCapturePlan(options: {
  projectRoot: string;
  manifestPath: string;
  packetId?: string;
  targetIds?: string[];
  all?: boolean;
  baseUrl?: string;
  skipLiveProbe?: boolean;
  browserDriver?: CaptureBrowserDriver;
  resetExistingResults?: boolean;
}): Promise<{
  packetDir: string;
  packetManifest: CapturePacketManifest;
  selectedTargets: CaptureTargetSpec[];
  liveReachable: boolean;
  probeError?: string;
}> {
  const manifestAbs = path.resolve(options.projectRoot, options.manifestPath);
  const manifest = loadCaptureManifest(manifestAbs);
  const selectedTargets = selectCaptureTargets(manifest, {
    targetIds: options.targetIds,
    all: options.all
  });

  const baseUrl = (options.baseUrl ?? manifest.defaultBaseUrl).replace(/\/+$/, '');
  const nowIso = new Date().toISOString();
  const defaultPacketId = `cairn-${nowIso.slice(0, 19).replace(/[:T]/g, '-')}`;
  const packetId = options.packetId ? slugify(options.packetId) : defaultPacketId;
  const packetDir = resolvePacketDir(options.projectRoot, packetId);

  ensureSharedDir(packetDir);
  ensureSharedDir(path.join(packetDir, 'screens'));
  ensureSharedDir(path.join(packetDir, 'scripts'));

  const appGit = readGitRevisionSnapshot(options.projectRoot);
  const probe = options.skipLiveProbe
    ? { reachable: true, projectsGit: {} }
    : await probeLiveCairnServer(baseUrl);

  const plannedTargets = selectedTargets.map((target, idx) => {
    const order = idx + 1;
    const prefix = String(order).padStart(2, '0');
    const scriptRelativePath = `scripts/${prefix}-${target.id}.run-script.js`;
    const scriptText = buildBrowserRunScript(target, baseUrl);
    writeSharedFile(path.join(packetDir, scriptRelativePath), scriptText);

    return {
      order,
      targetId: target.id,
      label: target.label,
      actualAppState: target.actualAppState,
      route: target.route,
      viewport: target.viewport,
      scriptRelativePath
    };
  });

  const existingPacketPath = path.join(packetDir, 'packet.json');
  let existingCaptures: RecordedScreenEntry[] = [];
  let existingFailures: CaptureFailureEntry[] = [];
  let existingRefs: CompetitorReferenceEntry[] = [];
  let createdAt = nowIso;

  if (fs.existsSync(existingPacketPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(existingPacketPath, 'utf8')) as CapturePacketManifest;
      if (!options.resetExistingResults) {
        existingCaptures = prev.captures ?? [];
        existingFailures = prev.failures ?? [];
      }
      existingRefs = prev.competitorReferences ?? [];
      createdAt = prev.createdAt || nowIso;
    } catch {
      // Overwrite malformed draft
    }
  }

  const packetManifest: CapturePacketManifest = {
    schemaVersion: 1,
    packetId,
    createdAt,
    updatedAt: nowIso,
    baseUrl,
    manifestPath: path.relative(options.projectRoot, manifestAbs),
    browserDriver: options.browserDriver ?? 'openbot_browser',
    appGit,
    projectsGit: probe.projectsGit,
    plannedTargets,
    captures: existingCaptures,
    failures: existingFailures,
    competitorReferences: existingRefs
  };

  writeSharedFile(existingPacketPath, JSON.stringify(packetManifest, null, 2) + '\n');
  writeSharedFile(path.join(packetDir, 'SUMMARY.md'), renderPacketSummaryMarkdown(packetManifest));

  return {
    packetDir,
    packetManifest,
    selectedTargets,
    liveReachable: probe.reachable,
    probeError: probe.error
  };
}

export function recordTargetCapture(options: {
  projectRoot: string;
  packetIdOrDir: string;
  targetId: string;
  sourceImagePath: string;
  telemetry?: BrowserCaptureTelemetry | null;
}): RecordedScreenEntry {
  const packetDir = resolvePacketDir(options.projectRoot, options.packetIdOrDir);
  const packetJsonPath = path.join(packetDir, 'packet.json');
  if (!fs.existsSync(packetJsonPath)) {
    throw new Error(`Packet manifest not found at ${packetJsonPath}. Run "plan" first.`);
  }

  const packet = JSON.parse(fs.readFileSync(packetJsonPath, 'utf8')) as CapturePacketManifest;
  const manifestAbs = path.resolve(options.projectRoot, packet.manifestPath);
  const manifest = loadCaptureManifest(manifestAbs);
  const target = manifest.targets.find((t) => t.id === options.targetId);
  if (!target) {
    throw new Error(`Target "${options.targetId}" does not exist in ${packet.manifestPath}`);
  }

  if (options.telemetry && options.telemetry.status === 'failed') {
    recordTargetFailure({
      projectRoot: options.projectRoot,
      packetIdOrDir: options.packetIdOrDir,
      targetId: options.targetId,
      reason: options.telemetry.reason || 'Browser readiness script reported failed status',
      telemetry: options.telemetry
    });
    throw new Error(
      `Cannot record PNG for failed target "${options.targetId}" (step=${options.telemetry.failedStep ?? 'unknown'}): ${options.telemetry.reason ?? 'failed'}`
    );
  }

  const pngInfo = inspectPngFile(options.sourceImagePath);
  if (target.captureScope === 'viewport') {
    const expectedWidth = Math.round(target.viewport.width * target.viewport.deviceScaleFactor);
    const expectedHeight = Math.round(target.viewport.height * target.viewport.deviceScaleFactor);
    if (pngInfo.width !== expectedWidth || pngInfo.height !== expectedHeight) {
      throw new Error(
        `PNG pixel dimension mismatch for "${target.id}": expected ${expectedWidth}x${expectedHeight}, got ${pngInfo.width}x${pngInfo.height}`
      );
    }
  }

  const planned = packet.plannedTargets.find((p) => p.targetId === target.id);
  const order = planned ? planned.order : packet.captures.length + 1;
  const prefix = String(order).padStart(2, '0');
  const relativePath = `screens/${prefix}-${target.id}.png`;
  const metaRelativePath = `screens/${prefix}-${target.id}.meta.json`;

  copySharedFile(options.sourceImagePath, path.join(packetDir, relativePath));

  const capturedAt = new Date().toISOString();
  const fullUrl = options.telemetry?.url || `${packet.baseUrl}${target.route}`;
  const appGit = readGitRevisionSnapshot(options.projectRoot) ?? packet.appGit;
  const projectGit = packet.projectsGit[target.projectId] ?? null;

  const entry: RecordedScreenEntry = {
    order,
    targetId: target.id,
    ...(target.replacesTargetId ? { replacesTargetId: target.replacesTargetId } : {}),
    label: target.label,
    actualAppState: target.actualAppState,
    honestStateNote: target.honestStateNote,
    capturedAt,
    url: fullUrl,
    route: target.route,
    projectId: target.projectId,
    docPath: target.docPath,
    captureScope: target.captureScope,
    viewport: {
      requested: target.viewport,
      measuredCss: options.telemetry?.viewportCss ?? null,
      pngPixels: { width: pngInfo.width, height: pngInfo.height }
    },
    revisions: {
      appGit,
      projectGit
    },
    readiness: options.telemetry?.readiness ?? null,
    elapsedMs: options.telemetry?.elapsedMs ?? null,
    file: {
      relativePath,
      metaRelativePath,
      byteSize: pngInfo.byteSize,
      sha256: pngInfo.sha256
    }
  };

  writeSharedFile(path.join(packetDir, metaRelativePath), JSON.stringify(entry, null, 2) + '\n');

  packet.captures = packet.captures.filter((c) => c.targetId !== target.id);
  packet.captures.push(entry);
  packet.captures.sort((a, b) => a.order - b.order);
  packet.failures = packet.failures.filter((f) => f.targetId !== target.id);
  packet.updatedAt = capturedAt;

  writeSharedFile(packetJsonPath, JSON.stringify(packet, null, 2) + '\n');
  writeSharedFile(path.join(packetDir, 'SUMMARY.md'), renderPacketSummaryMarkdown(packet));

  return entry;
}

export function recordTargetFailure(options: {
  projectRoot: string;
  packetIdOrDir: string;
  targetId: string;
  reason: string;
  telemetry?: BrowserCaptureTelemetry | null;
}): CaptureFailureEntry {
  const packetDir = resolvePacketDir(options.projectRoot, options.packetIdOrDir);
  const packetJsonPath = path.join(packetDir, 'packet.json');
  if (!fs.existsSync(packetJsonPath)) {
    throw new Error(`Packet manifest not found at ${packetJsonPath}. Run "plan" first.`);
  }

  const packet = JSON.parse(fs.readFileSync(packetJsonPath, 'utf8')) as CapturePacketManifest;
  const recordedAt = new Date().toISOString();
  const failure: CaptureFailureEntry = {
    targetId: options.targetId,
    recordedAt,
    url: options.telemetry?.url || packet.baseUrl,
    failedStep: options.telemetry?.failedStep || 'capture',
    reason: options.reason,
    missingSelectors: options.telemetry?.missingSelectors ?? [],
    observedDom: options.telemetry?.observedDom ?? null
  };

  packet.failures = packet.failures.filter((f) => f.targetId !== options.targetId);
  packet.failures.push(failure);
  packet.updatedAt = recordedAt;

  writeSharedFile(packetJsonPath, JSON.stringify(packet, null, 2) + '\n');
  writeSharedFile(path.join(packetDir, 'SUMMARY.md'), renderPacketSummaryMarkdown(packet));
  return failure;
}

export function importCompetitorPng(options: {
  projectRoot: string;
  sourceImagePath: string;
  product: string;
  screen: string;
  task: string;
  source: string;
  viewport?: string;
  date?: string;
  notes?: string;
  packetIdOrDir?: string;
}): {
  entry: CompetitorReferenceEntry;
  storedImagePath: string;
  storedMetaPath: string;
} {
  if (/^https?:\/\//i.test(options.sourceImagePath.trim())) {
    throw new Error(
      'import-reference only imports local user-provided PNG files; fetching remote or authenticated URLs is prohibited.'
    );
  }

  const resolvedSrc = path.resolve(options.sourceImagePath);
  const baseName = path.basename(resolvedSrc);
  if (baseName.startsWith('.env') || resolvedSrc.includes(`${path.sep}.git${path.sep}`)) {
    throw new Error(`Refusing sensitive file path: ${resolvedSrc}`);
  }

  const product = options.product.trim();
  const screen = options.screen.trim();
  const task = options.task.trim();
  const source = options.source.trim();
  if (!product || !screen || !task || !source) {
    throw new Error('import-reference requires non-empty --product, --screen, --task, and --source');
  }

  const capturedDate = options.date?.trim() || null;
  if (capturedDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(capturedDate)) {
    throw new Error(`Invalid --date "${capturedDate}"; expected YYYY-MM-DD`);
  }

  const pngInfo = inspectPngFile(resolvedSrc);
  // Pixel dimensions alone cannot establish the original CSS viewport or capture date.
  const declaredViewport = options.viewport?.trim() || null;
  const id = `${capturedDate ?? 'date-unknown'}-${slugify(product)}-${slugify(screen)}`;

  const competitorsDir = path.join(options.projectRoot, 'captures', 'competitors');
  ensureSharedDir(competitorsDir);

  const storedImagePath = path.join(competitorsDir, `${id}.png`);
  const storedMetaPath = path.join(competitorsDir, `${id}.meta.json`);
  copySharedFile(resolvedSrc, storedImagePath);

  const importedAt = new Date().toISOString();
  const entry: CompetitorReferenceEntry = {
    id,
    product,
    screen,
    task,
    declaredViewport,
    pngPixels: { width: pngInfo.width, height: pngInfo.height },
    source,
    capturedDate,
    importedAt,
    ...(options.notes?.trim() ? { notes: options.notes.trim() } : {}),
    file: {
      relativePath: `captures/competitors/${id}.png`,
      byteSize: pngInfo.byteSize,
      sha256: pngInfo.sha256
    }
  };

  writeSharedFile(storedMetaPath, JSON.stringify(entry, null, 2) + '\n');

  if (options.packetIdOrDir) {
    const packetDir = resolvePacketDir(options.projectRoot, options.packetIdOrDir);
    const packetJsonPath = path.join(packetDir, 'packet.json');
    if (!fs.existsSync(packetJsonPath)) {
      throw new Error(`Packet manifest not found at ${packetJsonPath}`);
    }
    const packet = JSON.parse(fs.readFileSync(packetJsonPath, 'utf8')) as CapturePacketManifest;
    const packetRefRel = `references/${id}.png`;
    copySharedFile(resolvedSrc, path.join(packetDir, packetRefRel));

    const packetRefEntry: CompetitorReferenceEntry = {
      ...entry,
      file: {
        ...entry.file,
        relativePath: packetRefRel
      }
    };
    packet.competitorReferences = packet.competitorReferences.filter((r) => r.id !== id);
    packet.competitorReferences.push(packetRefEntry);
    packet.updatedAt = importedAt;
    writeSharedFile(packetJsonPath, JSON.stringify(packet, null, 2) + '\n');
    writeSharedFile(path.join(packetDir, 'SUMMARY.md'), renderPacketSummaryMarkdown(packet));
  }

  return { entry, storedImagePath, storedMetaPath };
}

export function validateCapturePacket(options: {
  projectRoot: string;
  packetIdOrDir: string;
  requireAllPlanned?: boolean;
}): {
  valid: boolean;
  packetDir: string;
  checkedScreens: number;
  checkedReferences: number;
  issues: string[];
} {
  const packetDir = resolvePacketDir(options.projectRoot, options.packetIdOrDir);
  const packetJsonPath = path.join(packetDir, 'packet.json');
  const issues: string[] = [];

  if (!fs.existsSync(packetJsonPath)) {
    return {
      valid: false,
      packetDir,
      checkedScreens: 0,
      checkedReferences: 0,
      issues: [`Missing packet.json at ${packetJsonPath}`]
    };
  }

  const packet = JSON.parse(fs.readFileSync(packetJsonPath, 'utf8')) as CapturePacketManifest;
  if (packet.failures.length > 0) {
    for (const f of packet.failures) {
      issues.push(`Target "${f.targetId}" failed at step "${f.failedStep}": ${f.reason}`);
    }
  }

  if (options.requireAllPlanned !== false) {
    for (const planned of packet.plannedTargets) {
      if (!packet.captures.some((c) => c.targetId === planned.targetId)) {
        issues.push(`Planned target "${planned.targetId}" has no recorded PNG capture`);
      }
    }
  }

  for (const cap of packet.captures) {
    const imgAbs = path.join(packetDir, cap.file.relativePath);
    const metaAbs = path.join(packetDir, cap.file.metaRelativePath);
    if (!fs.existsSync(metaAbs)) {
      issues.push(`Missing per-screen metadata sidecar for "${cap.targetId}": ${cap.file.metaRelativePath}`);
    }
    try {
      const png = inspectPngFile(imgAbs);
      if (png.sha256 !== cap.file.sha256) {
        issues.push(`SHA-256 mismatch for "${cap.targetId}" (${cap.file.relativePath})`);
      }
      if (cap.captureScope === 'viewport') {
        const expW = Math.round(cap.viewport.requested.width * cap.viewport.requested.deviceScaleFactor);
        const expH = Math.round(cap.viewport.requested.height * cap.viewport.requested.deviceScaleFactor);
        if (png.width !== expW || png.height !== expH) {
          issues.push(
            `Viewport pixel mismatch for "${cap.targetId}": expected ${expW}x${expH}, found ${png.width}x${png.height}`
          );
        }
      }
      if (cap.readiness && !cap.readiness.passed) {
        issues.push(`Readiness flag is false on recorded capture "${cap.targetId}"`);
      }
    } catch (err) {
      issues.push(
        `Invalid PNG for "${cap.targetId}" (${cap.file.relativePath}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const ref of packet.competitorReferences) {
    const refAbs = path.join(packetDir, ref.file.relativePath);
    try {
      const png = inspectPngFile(refAbs);
      if (png.sha256 !== ref.file.sha256) {
        issues.push(`SHA-256 mismatch for competitor reference "${ref.id}"`);
      }
    } catch (err) {
      issues.push(
        `Invalid competitor reference PNG "${ref.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    valid: issues.length === 0,
    packetDir,
    checkedScreens: packet.captures.length,
    checkedReferences: packet.competitorReferences.length,
    issues
  };
}

export function renderPacketSummaryMarkdown(packet: CapturePacketManifest): string {
  const lines: string[] = [];
  lines.push(`# Visual Review Packet: \`${packet.packetId}\``);
  lines.push('');
  lines.push(`- **Updated:** \`${packet.updatedAt}\``);
  lines.push(`- **Base URL:** \`${packet.baseUrl}\``);
  const driverLabel =
    packet.browserDriver === 'playwright-chromium'
      ? 'local headless Playwright Chromium'
      : 'OpenBot MCP embedded browser';
  lines.push(`- **Browser Driver:** \`${packet.browserDriver}\` (${driverLabel})`);
  if (packet.appGit) {
    lines.push(
      `- **App Revision:** \`${packet.appGit.sha}\` on \`${packet.appGit.branch}\` (${packet.appGit.isClean ? 'clean' : `${packet.appGit.dirtyFiles.length} uncommitted path(s)`})`
    );
  }
  const projIds = Object.keys(packet.projectsGit);
  if (projIds.length > 0) {
    const summary = projIds
      .map((id) => {
        const p = packet.projectsGit[id];
        return `\`${p.projectId}@${p.headSha}\` (${p.isClean ? 'clean' : `${p.changedFiles.length} modified`})`;
      })
      .join(', ');
    lines.push(`- **Content Repositories:** ${summary}`);
  }
  lines.push('');

  lines.push('## Captured Screens');
  lines.push('');
  if (packet.captures.length === 0) {
    lines.push('_No screenshots recorded yet._');
  } else {
    lines.push('| # | Target ID | Actual App State | PNG Pixels | Route | File |');
    lines.push('| :- | :--- | :--- | :--- | :--- | :--- |');
    for (const c of packet.captures) {
      lines.push(
        `| ${c.order} | \`${c.targetId}\` | \`${c.actualAppState}\` | \`${c.viewport.pngPixels.width}x${c.viewport.pngPixels.height}\` | \`${c.route}\` | \`${c.file.relativePath}\` |`
      );
    }
    lines.push('');
    lines.push('### Honest State Notes');
    lines.push('');
    for (const c of packet.captures) {
      const mapping = c.replacesTargetId ? ` [replaces \`${c.replacesTargetId}\`]` : '';
      lines.push(`- **\`${c.targetId}\`${mapping} (${c.label}):** ${c.honestStateNote}`);
    }
  }
  lines.push('');

  if (packet.failures.length > 0) {
    lines.push('## Capture Failures');
    lines.push('');
    for (const f of packet.failures) {
      lines.push(`- **\`${f.targetId}\`** failed at \`${f.failedStep}\`: ${f.reason}`);
    }
    lines.push('');
  }

  if (packet.competitorReferences.length > 0) {
    lines.push('## Imported Competitor / External References');
    lines.push('');
    lines.push('| Product | Screen | Task | Pixels | Date | Source | File |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const r of packet.competitorReferences) {
      lines.push(
        `| ${r.product} | ${r.screen} | ${r.task} | \`${r.pngPixels.width}x${r.pngPixels.height}\` | \`${r.capturedDate ?? 'unknown'}\` | ${r.source} | \`${r.file.relativePath}\` |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
