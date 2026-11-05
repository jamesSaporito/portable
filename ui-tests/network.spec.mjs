// The environment page's Network grid, in a real browser.
import { expect, test } from '@playwright/test';
import { startPage } from './page.mjs';

// Shapes from `sbx policy ls` and `sbx policy approval ls` on sbx 0.51.0, trimmed.
const GROUPS = [
  { source: 'sbx', name: 'cloud infrastructure', hosts: ['**.amazonaws.com:443', '**.googleapis.com:443'] },
  { source: 'kit', name: 'kit', hosts: ['*.amazonaws.com', 'mcp.atlassian.com', 'api.anthropic.com:443'] },
  { source: 'sbx', name: 'ai services', hosts: ['api.anthropic.com:443'] },
];
const BLOCKED = [{ id: 'network:a', host: 'amazonaws.com:80', at: '2026-11-04T22:34:18-05:00' }];

let page;
let server;

test.beforeEach(async ({ page: browserPage }) => {
  server = await startPage({ groups: GROUPS, blocked: BLOCKED });
  page = browserPage;
  await page.goto(server.url);
  await expect(page.locator('#network-body tr').nth(1)).toBeVisible();
});

test.afterEach(async () => {
  await server.close();
});

const rows = () => page.locator('#network-body tr');
const row = (host, port) => rows().filter({ has: page.locator('td:nth-child(1)', { hasText: new RegExp(`^${host.replace(/[.*]/g, '\\$&')}$`) }) })
  .filter({ has: page.locator('td:nth-child(2)', { hasText: port }) });

test('lists blocked hosts first, then each rule with its port and source', async () => {
  await expect(page.locator('#network-count')).toHaveText('(5 allowed, 1 blocked)');
  await expect(rows().first()).toContainText('amazonaws.com');
  await expect(rows().first()).toContainText('80 (HTTP)');
  await expect(rows().first().locator('.policy')).toHaveText('Blocked');
  // The kit's rules before sbx's defaults; a rule both allow names both.
  await expect(rows().nth(1)).toContainText('Kit (portable and the Claude agent)');
  await expect(row('api.anthropic.com', '443 (HTTPS)')).toContainText("Kit (portable and the Claude agent), sbx's defaults: ai services");
  await expect(row('*.amazonaws.com', 'Any').locator('.policy')).toHaveText('Allowed');
  await expect(row('**.amazonaws.com', '443 (HTTPS)')).toContainText("sbx's defaults: cloud infrastructure");
  await expect(rows().last()).toContainText('Everything else');
});

test('searching for a URL says whether the request would be allowed, and by which rule', async () => {
  const search = page.locator('#network-search');
  await search.fill('http://amazonaws.com');
  await expect(rows().first().locator('.policy')).toHaveText('Blocked');
  await expect(rows().first()).toContainText('No rule covers this host on this port');

  await search.fill('https://amazonaws.com');
  await expect(rows().first().locator('.policy')).toHaveText('Allowed');
  await expect(rows().first()).toContainText('Allowed by **.amazonaws.com:443');

  // One level of subdomain on any port comes from the kit's `*.amazonaws.com`.
  await search.fill('http://s3.amazonaws.com');
  await expect(rows().first()).toContainText('Allowed by *.amazonaws.com');
  await search.fill('http://s3.us-east-1.amazonaws.com');
  await expect(rows().first().locator('.policy')).toHaveText('Blocked');

  // Partial text just filters the rows.
  await search.fill('atlassian');
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText('mcp.atlassian.com');
});

test('the policy filter shows only blocked or only allowed rows', async () => {
  await page.locator('#network-filter').selectOption('blocked');
  await expect(rows()).toHaveCount(2);
  await expect(rows().nth(0)).toContainText('amazonaws.com');
  await expect(rows().nth(1)).toContainText('Everything else');

  await page.locator('#network-filter').selectOption('allowed');
  await expect(rows()).toHaveCount(5);
  await expect(page.locator('#network-body .policy.blocked')).toHaveCount(0);
});

test('allowing a blocked host adds it to the environment and takes it off the blocked list', async () => {
  await rows().first().getByRole('button', { name: 'Allow' }).click();
  await expect(page.locator('#banner')).toHaveText('amazonaws.com:80 is allowed for this environment.');
  expect(server.added).toEqual(['amazonaws.com:80']);
  await expect(page.locator('#network-body .policy.blocked')).toHaveCount(1);
  await expect(page.locator('#network-count')).toHaveText('(5 allowed)');
});

test('Services sits right under Ports, and Network before the sandbox settings', async () => {
  const sections = await page.locator('main > section').evaluateAll((all) => all.map((s) => s.id));
  expect(sections.slice(0, 4)).toEqual(['ports', 'services', 'network', 'settings']);
});

test('extra allowed hosts are saved from the top of Network, not the sandbox settings', async () => {
  await expect(page.locator('#settings textarea')).toHaveCount(0);
  const field = page.locator('#network #hosts-form textarea[name=allowDomains]');
  await field.fill('pypi.org\nfiles.pythonhosted.org');
  await expect(page.locator('#hosts-form button[type=submit]')).toHaveText('Save changes');
  await page.locator('#hosts-form button[type=submit]').click();
  await expect(page.locator('#banner')).toHaveText('Saved. The hosts apply right away.');
  expect(server.added).toEqual(['pypi.org', 'files.pythonhosted.org']);
  await expect(field).toHaveValue('pypi.org\nfiles.pythonhosted.org');
  await expect(page.locator('#hosts-form button[type=submit]')).toHaveText('Save');
});

test('the page fits a phone screen without scrolling sideways', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
