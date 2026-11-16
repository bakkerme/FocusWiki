import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CaptureFailureEntry,
  type CaptureTargetSpec,
  type InPageCaptureResult,
  type RecordedScreenEntry,
  CAIRN_APP_BOOT_CHECK_EXPRESSION,
  buildInPageStepAndReadinessExpression,
  buildTargetInPageSpec,
  createCapturePlan,
  recordTargetCapture,
  recordTargetFailure,
  toBrowserCaptureTelemetry,
  validateCapturePacket
} from './captureLib.js';

export interface PlaywrightCaptureRunOptions {
  projectRoot: string;
  manifestPath: string;
  packetId?: string;
  targetIds?: string[];
  all?: boolean;
  baseUrl?: string;
}

export interface PlaywrightCaptureRunResult {
  ok: boolean;
  packetId: string;
  packetDir: string;
  baseUrl: string;
  browserVersion: string | null;
  captured: RecordedScreenEntry[];
  failures: CaptureFailureEntry[];
  validation: {
    valid: boolean;
    checkedScreens: number;
    checkedReferences: number;
    issues: string[];
  };
  error?: string;
}

function isAllowedLocalOrPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]') {
    return true;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (!ipv4Match) {
    return false;
  }
  const octets = ipv4Match.slice(1).map((n) => Number.parseInt(n, 10));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return false;
  }

  const [a, b] = octets;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Tailscale CGNAT range 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

export function assertLocalCairnBaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid --base-url "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${parsed.protocol}" in --base-url "${rawUrl}"`);
  }

  if (!isAllowedLocalOrPrivateHost(parsed.hostname)) {
    throw new Error(
      `Refusing non-local --base-url host "${parsed.hostname}". Playwright runner is scoped strictly to local/private Cairn services.`
    );
  }
}

function configureLocalPlaywrightBrowsersPath(projectRoot: string): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const candidateRoot of [projectRoot, repoRoot]) {
    const localCache = path.join(candidateRoot, '.runtime', 'ms-playwright');
    if (fs.existsSync(localCache)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = localCache;
      return;
    }
  }
}

async function captureSingleTargetWithPlaywright(options: {
  browser: import('playwright').Browser;
  projectRoot: string;
  packetDir: string;
  baseUrl: string;
  target: CaptureTargetSpec;
  stagingDir: string;
}): Promise<{ captured?: RecordedScreenEntry; failure?: CaptureFailureEntry }> {
  const { browser, projectRoot, packetDir, baseUrl, target, stagingDir } = options;
  const spec = buildTargetInPageSpec(target, baseUrl);
  const startedAt = Date.now();
  const totalTimeoutMs = Math.max(3000, target.readiness.timeoutMs || 12000);
  let currentStep = 'navigate';

  const bootViewport = target.initialViewport ?? {
    width: target.viewport.width,
    height: target.viewport.height
  };

  const context = await browser.newContext({
    viewport: {
      width: bootViewport.width,
      height: bootViewport.height
    },
    deviceScaleFactor: target.viewport.deviceScaleFactor,
    colorScheme: target.viewport.colorScheme === 'system' ? 'no-preference' : target.viewport.colorScheme,
    reducedMotion: target.viewport.reducedMotion ? 'reduce' : 'no-preference'
  });

  try {
    const page = await context.newPage();
    const embedHttpErrors: string[] = [];

    page.on('response', (res) => {
      try {
        const u = new URL(res.url());
        if (u.pathname.startsWith('/embed-sandbox/') && res.status() >= 400) {
          embedHttpErrors.push(`${u.pathname} returned HTTP ${res.status()}`);
        }
      } catch {
        // Ignore non-standard URLs
      }
    });

    const navResponse = await page.goto(spec.fullUrl, {
      waitUntil: 'domcontentloaded',
      timeout: totalTimeoutMs
    });

    if (navResponse && navResponse.status() >= 400) {
      throw new Error(`Navigation to ${spec.fullUrl} returned HTTP ${navResponse.status()}`);
    }

    currentStep = 'wait-app-boot';
    await page.waitForFunction(CAIRN_APP_BOOT_CHECK_EXPRESSION, undefined, {
      timeout: totalTimeoutMs
    });

    if (target.initialViewport) {
      currentStep = 'resize-orientation-transition';
      if (typeof target.initialScrollY === 'number' && target.initialScrollY > 0) {
        await page.evaluate(`window.scrollTo(0, ${Math.round(target.initialScrollY)})`);
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      }
      await page.setViewportSize({
        width: target.viewport.width,
        height: target.viewport.height
      });
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    }

    currentStep = 'apply-steps-and-assert';
    const inPageExpr = buildInPageStepAndReadinessExpression(spec);
    const pageResult = (await page.evaluate(inPageExpr)) as InPageCaptureResult;

    if (pageResult.ok && target.readiness.waitForVisibleEmbeds) {
      currentStep = 'wait-visible-embed-frames';
      if (embedHttpErrors.length > 0) {
        throw new Error(`Sandboxed embed HTTP error(s): ${embedHttpErrors.join('; ')}`);
      }

      const iframeHandles = await page.$$('iframe.embed-sandbox-iframe');
      let verifiedVisibleCount = 0;

      for (const handle of iframeHandles) {
        const box = await handle.boundingBox();
        if (!box) continue;
        const intersectsViewport = box.y + box.height > 0 && box.y < target.viewport.height;
        if (!intersectsViewport) continue;

        const frame = await handle.contentFrame();
        if (!frame) {
          throw new Error('Visible iframe.embed-sandbox-iframe has no accessible Playwright contentFrame');
        }

        const remainingMs = Math.max(1500, totalTimeoutMs - (Date.now() - startedAt));
        await frame.waitForLoadState('load', { timeout: remainingMs });
        await frame.waitForFunction(
          'document.readyState === "complete" && Boolean(document.body && document.body.children.length > 0)',
          undefined,
          { timeout: remainingMs }
        );
        verifiedVisibleCount += 1;
      }

      if (verifiedVisibleCount === 0) {
        throw new Error('Expected at least one visible sandboxed embed frame in viewport, found 0');
      }

      if (embedHttpErrors.length > 0) {
        throw new Error(`Sandboxed embed HTTP error(s): ${embedHttpErrors.join('; ')}`);
      }

      // Allow postMessage resize/telemetry settlement in parent React wrapper
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    }

    const telemetry = toBrowserCaptureTelemetry(spec, pageResult, Date.now() - startedAt);
    if (telemetry.status !== 'ready') {
      const failure = recordTargetFailure({
        projectRoot,
        packetIdOrDir: packetDir,
        targetId: target.id,
        reason: telemetry.reason || 'Target failed readiness assertions',
        telemetry
      });
      return { failure };
    }

    currentStep = 'screenshot';
    const rawPngPath = path.join(stagingDir, `${target.id}.png`);
    await page.screenshot({
      path: rawPngPath,
      type: 'png',
      fullPage: target.captureScope === 'full-page',
      animations: 'disabled'
    });

    const captured = recordTargetCapture({
      projectRoot,
      packetIdOrDir: packetDir,
      targetId: target.id,
      sourceImagePath: rawPngPath,
      telemetry
    });
    return { captured };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failure = recordTargetFailure({
      projectRoot,
      packetIdOrDir: packetDir,
      targetId: target.id,
      reason,
      telemetry: {
        status: 'failed',
        targetId: target.id,
        actualAppState: target.actualAppState,
        url: spec.fullUrl,
        elapsedMs: Date.now() - startedAt,
        failedStep: currentStep,
        reason,
        missingSelectors: []
      }
    });
    return { failure };
  } finally {
    await context.close();
  }
}

export async function runPlaywrightCapture(
  options: PlaywrightCaptureRunOptions
): Promise<PlaywrightCaptureRunResult> {
  configureLocalPlaywrightBrowsersPath(options.projectRoot);

  if (options.baseUrl) {
    assertLocalCairnBaseUrl(options.baseUrl);
  }

  const plan = await createCapturePlan({
    projectRoot: options.projectRoot,
    manifestPath: options.manifestPath,
    packetId: options.packetId,
    targetIds: options.targetIds,
    all: options.all,
    baseUrl: options.baseUrl,
    browserDriver: 'playwright-chromium',
    resetExistingResults: true
  });

  assertLocalCairnBaseUrl(plan.packetManifest.baseUrl);

  if (!plan.liveReachable) {
    const probeReason = plan.probeError ?? `Live Cairn server unreachable at ${plan.packetManifest.baseUrl}`;
    const failures: CaptureFailureEntry[] = [];
    for (const target of plan.selectedTargets) {
      failures.push(
        recordTargetFailure({
          projectRoot: options.projectRoot,
          packetIdOrDir: plan.packetDir,
          targetId: target.id,
          reason: probeReason,
          telemetry: {
            status: 'failed',
            targetId: target.id,
            actualAppState: target.actualAppState,
            url: `${plan.packetManifest.baseUrl}${target.route}`,
            elapsedMs: 0,
            failedStep: 'live-server-probe',
            reason: probeReason,
            missingSelectors: []
          }
        })
      );
    }

    const validation = validateCapturePacket({
      projectRoot: options.projectRoot,
      packetIdOrDir: plan.packetDir,
      requireAllPlanned: true
    });

    return {
      ok: false,
      packetId: plan.packetManifest.packetId,
      packetDir: plan.packetDir,
      baseUrl: plan.packetManifest.baseUrl,
      browserVersion: null,
      captured: [],
      failures,
      validation: {
        valid: validation.valid,
        checkedScreens: validation.checkedScreens,
        checkedReferences: validation.checkedReferences,
        issues: validation.issues
      },
      error: probeReason
    };
  }

  const { chromium } = await import('playwright');
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-pw-capture-'));
  let browser: import('playwright').Browser | null = null;
  let browserVersion: string | null = null;
  const captured: RecordedScreenEntry[] = [];
  const failures: CaptureFailureEntry[] = [];

  try {
    // Playwright disables Chromium's sandbox unless explicitly enabled.
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    browserVersion = browser.version();

    for (const target of plan.selectedTargets) {
      const res = await captureSingleTargetWithPlaywright({
        browser,
        projectRoot: options.projectRoot,
        packetDir: plan.packetDir,
        baseUrl: plan.packetManifest.baseUrl,
        target,
        stagingDir
      });
      if (res.captured) {
        captured.push(res.captured);
      }
      if (res.failure) {
        failures.push(res.failure);
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  const validation = validateCapturePacket({
    projectRoot: options.projectRoot,
    packetIdOrDir: plan.packetDir,
    requireAllPlanned: true
  });

  const ok =
    validation.valid &&
    failures.length === 0 &&
    captured.length === plan.selectedTargets.length;

  return {
    ok,
    packetId: plan.packetManifest.packetId,
    packetDir: plan.packetDir,
    baseUrl: plan.packetManifest.baseUrl,
    browserVersion,
    captured,
    failures,
    validation: {
      valid: validation.valid,
      checkedScreens: validation.checkedScreens,
      checkedReferences: validation.checkedReferences,
      issues: validation.issues
    },
    ...(ok ? {} : { error: validation.issues.join('; ') || 'Packet validation failed' })
  };
}
