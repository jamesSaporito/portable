// Browser tests for the environment page (`npm run test:ui`). `channel: 'chrome'` drives the Google
// Chrome already on the machine, headless, so there's no `playwright install` step:
// https://playwright.dev/docs/browsers#google-chrome--microsoft-edge
// The unit and API tests stay on Node's runner (`npm test`, test/*.test.mjs); these are in test/ui.
// In a sandbox, scripts/test-ui-docker.mjs sets UI_TEST_CHROMIUM to Debian's Chromium in its container,
// where the repo is read-only, so the output goes to the container's /tmp.
import { defineConfig } from '@playwright/test';

const chromium = process.env.UI_TEST_CHROMIUM;

export default defineConfig({
  testDir: 'test/ui',
  testMatch: '*.spec.mjs',
  reporter: 'list',
  ...(chromium && { outputDir: '/tmp/test-results' }),
  use: { headless: true, ...(chromium ? { launchOptions: { executablePath: chromium } } : { channel: 'chrome' }) },
});
