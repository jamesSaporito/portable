// Browser tests for the environment page (`npm run test:ui`). `channel: 'chrome'` drives the Google
// Chrome already on the machine, headless, so there's no `playwright install` step:
// https://playwright.dev/docs/browsers#google-chrome--microsoft-edge
// The unit and API tests stay on Node's runner (`npm test`, test/*.test.mjs); these are in test/ui.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/ui',
  testMatch: '*.spec.mjs',
  reporter: 'list',
  use: { channel: 'chrome', headless: true },
});
