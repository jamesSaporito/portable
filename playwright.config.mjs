// Browser tests for the environment page (`npm run test:ui`). `channel: 'chrome'` drives the Google
// Chrome already on the machine, headless, so there's no `playwright install` step:
// https://playwright.dev/docs/browsers#google-chrome--microsoft-edge
// The unit and API tests stay on Node's runner (`npm test`); these live in ui-tests/ so it skips them.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'ui-tests',
  testMatch: '*.spec.mjs',
  reporter: 'list',
  use: { channel: 'chrome', headless: true },
});
