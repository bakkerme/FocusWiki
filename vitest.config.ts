import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Also cover capture-process tests that import Playwright before their hooks run.
const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH || [
  path.join(__dirname, '.runtime', 'ms-playwright'),
  '/workspace/wiki-prototype/.runtime/ms-playwright'
].find((candidate) => fs.existsSync(candidate));

export default defineConfig({
  test: {
    environment: 'node',
    env: browserCache ? { PLAYWRIGHT_BROWSERS_PATH: browserCache } : {},
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/setupBuildClient.ts'],
    testTimeout: 60000,
    hookTimeout: 60000
  }
});
