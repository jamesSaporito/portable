// The environment page's Claude configuration section, in a real browser.
import { expect, test } from '@playwright/test';
import { startPage } from './page.mjs';

const REPO = 'https://github.com/me/config.git';
const GROUPS = [{ source: 'kit', name: 'kit', hosts: ['github.com:443', 'api.anthropic.com:443'] }];

let page;
let server;
// What the fake sandbox's `portable-setup` answers: `pull` and `repo` alike.
let setup;

test.beforeEach(async ({ page: browserPage }) => {
  server = await startPage({ groups: GROUPS, global: { claudeConfigRepo: REPO } });
  setup = { code: 0, stdout: 'updated abc1234\n', stderr: '' };
  server.sbx.exec = async (name, command) => (command[0] === 'portable-setup'
    ? setup
    : { code: 0, stdout: 'abc1234\n---\ncommit\n---\ngit\n', stderr: '' });
  page = browserPage;
  await page.goto(server.url);
  await expect(page.locator('#claude-repo')).toHaveText('Installed at abc1234');
});

test.afterEach(async () => {
  await server.close();
});

const banner = () => page.locator('#banner');
const lastEvent = () => page.locator('#events li').first();

test('Update from GitHub pulls the repo and says what it got, in the activity too', async () => {
  await page.locator('#claude-update').click();
  await expect(banner()).toHaveText('Updated the Claude configuration to abc1234; new Claude sessions pick it up.');
  await expect(lastEvent()).toContainText('Claude configuration updated to abc1234');

  setup = { code: 0, stdout: 'current abc1234\n', stderr: '' };
  await page.locator('#claude-update').click();
  await expect(banner()).toHaveText('The Claude configuration is already up to date at abc1234.');
  await expect(lastEvent()).toContainText('Claude configuration already up to date at abc1234');
});

test('Update from GitHub is off while offline mode denies the repo\'s host, and back once it\'s kept', async () => {
  const update = page.locator('#claude-update');
  const note = page.locator('#claude-update-note');
  await expect(update).toBeEnabled();
  await expect(note).toBeHidden();

  await page.locator('#offline-toggle').click();
  await expect(page.locator('#offline-state')).toHaveText('Offline');
  await expect(update).toBeDisabled();
  await expect(note).toHaveText('This sandbox is offline, which denies github.com. To update from GitHub while offline, add github.com to Kept while offline (Network).');

  await page.locator('#offline-keep-form input[name=host]').fill('github.com');
  await page.locator('#offline-keep-form button[type=submit]').click();
  await expect(update).toBeEnabled();
  await expect(note).toBeHidden();
});

test('saving a repo the sandbox can\'t reach says so, without claiming it switched', async () => {
  setup = {
    code: 1,
    stdout: '',
    stderr: `portable: couldn't fetch ${REPO}: github.com is blocked by the sandbox's network rules; using the copy already there\n`,
  };
  await page.locator('#claude-repo-form button[type=submit]').click();
  await expect(banner()).toHaveText(`Saved, but couldn't pull the configuration repo into app: couldn't fetch ${REPO}: github.com is blocked by the sandbox's network rules; using the copy already there`);
  await expect(lastEvent()).toContainText(`configuration repo set to ${REPO}, but not pulled:`);
  await expect(lastEvent()).toContainText('github.com is blocked');
});
