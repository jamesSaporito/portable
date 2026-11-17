// The environment page's GitHub Packages section, in a real browser.
import { expect, test } from '@playwright/test';
import { startPage } from './page.mjs';

let server;

test.afterEach(async () => {
  await server.close();
});

const npmInputs = () => server.sbx.calls.filter((c) => c[0] === 'exec' && c[2].join(' ') === 'portable-setup npm').map((c) => c[3]);

test('Turn on puts the stored token in the sandbox, and Turn off takes it out', async ({ page }) => {
  server = await startPage({
    secrets: { backend: 'Keychain', async has(name) { return name === 'GH_PACKAGES_TOKEN'; }, async read() { return 'ghp_ui123'; } },
  });
  await page.goto(server.url);
  const section = page.locator('#packages');
  await expect(section.locator('.packages-state')).toHaveText('Off');
  await section.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.locator('#banner')).toHaveText('GitHub Packages is on; new sessions have NPM_TOKEN.');
  await expect(section.locator('.packages-state')).toHaveText('On');
  expect(npmInputs()).toEqual(['export NPM_TOKEN=ghp_ui123\n']);

  await section.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.locator('#banner')).toHaveText('GitHub Packages is off; new sessions have no NPM_TOKEN.');
  await expect(section.locator('.packages-state')).toHaveText('Off');
  expect(npmInputs()).toEqual(['export NPM_TOKEN=ghp_ui123\n', '']);
});

test('without a stored token there is nothing to turn on, only how to store one', async ({ page }) => {
  server = await startPage();
  await page.goto(server.url);
  const section = page.locator('#packages');
  await expect(section).toContainText('No GitHub packages token is stored on this computer; store one with portable configure.');
  await expect(section.getByRole('button')).toHaveCount(0);
});
