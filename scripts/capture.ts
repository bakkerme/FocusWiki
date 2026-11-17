import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHubApp } from '../server/app.js';
import {
  type BrowserCaptureTelemetry,
  createCapturePlan,
  ensureSharedDir,
  importCompetitorPng,
  loadCaptureManifest,
  recordTargetCapture,
  recordTargetFailure,
  validateCapturePacket,
  writeSharedFile
} from './captureLib.js';
import { runPlaywrightCapture } from './captureRunner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = 'config/capture-manifest.json';

function parseArgs(argv: string[]): { subcommand: string; flags: Record<string, string | boolean> } {
  const subcommand = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const startIdx = subcommand === argv[0] ? 1 : 0;
  const flags: Record<string, string | boolean> = {};

  for (let i = startIdx; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eqIdx = token.indexOf('=');
    if (eqIdx !== -1) {
      const key = token.slice(2, eqIdx);
      flags[key] = token.slice(eqIdx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { subcommand, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === 'string' ? val : undefined;
}

function parseTelemetryArg(raw: string | undefined): BrowserCaptureTelemetry | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as BrowserCaptureTelemetry;
  }
  const filePath = path.resolve(PROJECT_ROOT, trimmed);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BrowserCaptureTelemetry;
}

function printUsage(): void {
  console.log(`FocusWiki Screenshot & Visual Review Packet CLI

Usage:
  npm run capture -- list [--manifest config/capture-manifest.json]
  npm run capture -- run [--packet <id>] [--targets id1,id2 | --all] [--base-url http://127.0.0.1:8088] [--manifest config/capture-manifest.json]
  npm run capture -- plan [--packet <id>] [--targets id1,id2 | --all] [--base-url http://127.0.0.1:8088]
  npm run capture -- record --packet <id> --target <target-id> --image <saved.png> [--telemetry <json-or-file>]
  npm run capture -- record-failure --packet <id> --target <target-id> --reason <message> [--telemetry <json-or-file>]
  npm run capture -- validate --packet <id> [--allow-partial]
  npm run capture -- import-reference --image <local.png> --product <name> --screen <name> --task <task> --source <source> [--viewport <WxH>] [--date YYYY-MM-DD] [--notes <text>] [--packet <id>]
  npm run capture -- isolated-fixture [--port 8089]
`);
}

function copyDirRecursive(src: string, dest: string): void {
  ensureSharedDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

async function runIsolatedFixtureServer(port: number): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focuswiki-capture-fixture-'));
  const reposDir = path.join(tmpRoot, 'repos');
  ensureSharedDir(reposDir);

  for (const repoId of ['cindervault-rpg', 'helios-lab']) {
    const srcSeed = path.join(PROJECT_ROOT, 'seeds', repoId);
    const destRepo = path.join(reposDir, repoId);
    copyDirRecursive(srcSeed, destRepo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: destRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'FocusWiki Capture Fixture'], { cwd: destRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'fixture@helios-lab.example'], { cwd: destRepo, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: destRepo, stdio: 'ignore' });
    execFileSync(
      'git',
      ['commit', '-m', `Initialize isolated ${repoId} capture fixture`],
      { cwd: destRepo, stdio: 'ignore' }
    );
  }

  const clientDistDir = path.join(PROJECT_ROOT, 'dist', 'client');
  const { app, close } = createHubApp({
    projects: [
      {
        id: 'cindervault-rpg',
        name: 'Cindervault RPG (Isolated Fixture)',
        description: 'Clean seeded RPG fixture isolated from persistent sample-repos',
        rootPath: path.join(reposDir, 'cindervault-rpg'),
        defaultDoc: 'docs/vault-breach-action.md'
      },
      {
        id: 'helios-lab',
        name: 'Helios Bench Runbook (Isolated Fixture)',
        description: 'Clean seeded lab fixture isolated from persistent sample-repos',
        rootPath: path.join(reposDir, 'helios-lab'),
        defaultDoc: 'docs/bench-inventory.md'
      }
    ],
    clientDistDir: fs.existsSync(clientDistDir) ? clientDistDir : undefined,
    enableWatcher: false
  });

  const server = app.listen(port, '127.0.0.1', () => {
    console.log(
      JSON.stringify({
        status: 'listening',
        baseUrl: `http://127.0.0.1:${port}`,
        fixtureRoot: tmpRoot,
        note: 'Persistent sample-repos are untouched. Press Ctrl+C to stop and remove temporary fixture.'
      })
    );
  });

  const shutdown = async () => {
    server.close();
    await close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function main(): Promise<void> {
  const { subcommand, flags } = parseArgs(process.argv.slice(2));
  const manifestRel = getStringFlag(flags, 'manifest') ?? DEFAULT_MANIFEST;

  if (subcommand === 'help' || flags.help) {
    printUsage();
    return;
  }

  if (subcommand === 'list') {
    const manifest = loadCaptureManifest(path.resolve(PROJECT_ROOT, manifestRel));
    console.log(`Manifest: ${manifestRel} (defaultBaseUrl: ${manifest.defaultBaseUrl})\n`);
    for (const t of manifest.targets) {
      const defBadge = t.defaultSelected ? '[default]' : '[optional]';
      console.log(
        `- ${t.id.padEnd(20)} ${defBadge.padEnd(11)} ${String(t.viewport.width)}x${String(t.viewport.height)}  state=${t.actualAppState}`
      );
      console.log(`    ${t.label}`);
      console.log(`    Route: ${t.route}`);
    }
    return;
  }

  if (subcommand === 'run') {
    const rawTargets = getStringFlag(flags, 'targets');
    const targetIds = rawTargets
      ? rawTargets
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const runResult = await runPlaywrightCapture({
      projectRoot: PROJECT_ROOT,
      manifestPath: manifestRel,
      packetId: getStringFlag(flags, 'packet'),
      targetIds,
      all: Boolean(flags.all),
      baseUrl: getStringFlag(flags, 'base-url')
    });

    const summaryPayload = {
      status: runResult.ok ? 'complete' : 'failed',
      packetId: runResult.packetId,
      packetDir: runResult.packetDir,
      baseUrl: runResult.baseUrl,
      browserDriver: 'playwright-chromium',
      browserVersion: runResult.browserVersion,
      captured: runResult.captured.map((c) => ({
        order: c.order,
        targetId: c.targetId,
        actualAppState: c.actualAppState,
        file: path.join(runResult.packetDir, c.file.relativePath),
        relativePath: c.file.relativePath,
        pixels: `${c.viewport.pngPixels.width}x${c.viewport.pngPixels.height}`,
        elapsedMs: c.elapsedMs,
        sha256: c.file.sha256
      })),
      failures: runResult.failures,
      validation: runResult.validation,
      ...(runResult.error ? { error: runResult.error } : {})
    };

    if (!runResult.ok) {
      console.error(JSON.stringify(summaryPayload, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify(summaryPayload, null, 2));
    return;
  }

  if (subcommand === 'plan') {
    const rawTargets = getStringFlag(flags, 'targets');
    const targetIds = rawTargets
      ? rawTargets
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const result = await createCapturePlan({
      projectRoot: PROJECT_ROOT,
      manifestPath: manifestRel,
      packetId: getStringFlag(flags, 'packet'),
      targetIds,
      all: Boolean(flags.all),
      baseUrl: getStringFlag(flags, 'base-url'),
      skipLiveProbe: Boolean(flags['skip-probe'])
    });

    if (!result.liveReachable) {
      console.error(
        `[capture] Failure: Live FocusWiki server check failed (${result.probeError ?? 'unreachable'}). Start the server or pass --base-url.`
      );
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          status: 'planned',
          packetId: result.packetManifest.packetId,
          packetDir: result.packetDir,
          baseUrl: result.packetManifest.baseUrl,
          targets: result.packetManifest.plannedTargets.map((t) => ({
            order: t.order,
            targetId: t.targetId,
            viewport: `${t.viewport.width}x${t.viewport.height}@${t.viewport.deviceScaleFactor}x`,
            scriptPath: path.join(result.packetDir, t.scriptRelativePath)
          }))
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === 'record') {
    const packetId = getStringFlag(flags, 'packet');
    const targetId = getStringFlag(flags, 'target');
    const imagePath = getStringFlag(flags, 'image');
    if (!packetId || !targetId || !imagePath) {
      throw new Error('record requires --packet <id>, --target <target-id>, and --image <png-path>');
    }
    const telemetry = parseTelemetryArg(getStringFlag(flags, 'telemetry'));
    const entry = recordTargetCapture({
      projectRoot: PROJECT_ROOT,
      packetIdOrDir: packetId,
      targetId,
      sourceImagePath: path.resolve(imagePath),
      telemetry
    });
    console.log(
      JSON.stringify(
        {
          status: 'recorded',
          packet: packetId,
          targetId: entry.targetId,
          file: entry.file.relativePath,
          pixels: `${entry.viewport.pngPixels.width}x${entry.viewport.pngPixels.height}`,
          sha256: entry.file.sha256
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === 'record-failure') {
    const packetId = getStringFlag(flags, 'packet');
    const targetId = getStringFlag(flags, 'target');
    const reason = getStringFlag(flags, 'reason');
    if (!packetId || !targetId || !reason) {
      throw new Error('record-failure requires --packet <id>, --target <target-id>, and --reason <message>');
    }
    const telemetry = parseTelemetryArg(getStringFlag(flags, 'telemetry'));
    const failure = recordTargetFailure({
      projectRoot: PROJECT_ROOT,
      packetIdOrDir: packetId,
      targetId,
      reason,
      telemetry
    });
    console.error(JSON.stringify({ status: 'failure-recorded', failure }, null, 2));
    process.exit(1);
  }

  if (subcommand === 'validate') {
    const packetId = getStringFlag(flags, 'packet');
    if (!packetId) {
      throw new Error('validate requires --packet <id-or-dir>');
    }
    const check = validateCapturePacket({
      projectRoot: PROJECT_ROOT,
      packetIdOrDir: packetId,
      requireAllPlanned: !flags['allow-partial']
    });
    if (!check.valid) {
      console.error(
        JSON.stringify(
          {
            status: 'invalid',
            packetDir: check.packetDir,
            checkedScreens: check.checkedScreens,
            issues: check.issues
          },
          null,
          2
        )
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          status: 'valid',
          packetDir: check.packetDir,
          checkedScreens: check.checkedScreens,
          checkedReferences: check.checkedReferences
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === 'import-reference') {
    const imagePath = getStringFlag(flags, 'image');
    const product = getStringFlag(flags, 'product');
    const screen = getStringFlag(flags, 'screen');
    const task = getStringFlag(flags, 'task');
    const source = getStringFlag(flags, 'source');
    if (!imagePath || !product || !screen || !task || !source) {
      throw new Error(
        'import-reference requires --image <png-path> --product <name> --screen <name> --task <task> --source <source>'
      );
    }
    const imported = importCompetitorPng({
      projectRoot: PROJECT_ROOT,
      sourceImagePath: imagePath,
      product,
      screen,
      task,
      source,
      viewport: getStringFlag(flags, 'viewport'),
      date: getStringFlag(flags, 'date'),
      notes: getStringFlag(flags, 'notes'),
      packetIdOrDir: getStringFlag(flags, 'packet')
    });
    console.log(
      JSON.stringify(
        {
          status: 'imported',
          id: imported.entry.id,
          storedImagePath: imported.storedImagePath,
          storedMetaPath: imported.storedMetaPath,
          pixels: `${imported.entry.pngPixels.width}x${imported.entry.pngPixels.height}`,
          sha256: imported.entry.file.sha256
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === 'isolated-fixture') {
    const portRaw = getStringFlag(flags, 'port') ?? '8089';
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid --port "${portRaw}"`);
    }
    await runIsolatedFixtureServer(port);
    return;
  }

  throw new Error(`Unknown capture subcommand "${subcommand}". Run with --help for usage.`);
}

main().catch((err) => {
  console.error(`[capture] Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
