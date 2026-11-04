import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULTS, loadEnv, saveEnv } from '../lib/config.mjs';
import { createApi, findComposeFiles, parseClaudeInfo, parseContainers } from '../lib/api.mjs';
import { fakeSbx, tempHome } from './support/helpers.mjs';

const TOKEN = 'secret-token';

async function startApi(t) {
  const { home, paths } = tempHome(t);
  const folder = path.join(home, 'ws', 'app');
  fs.mkdirSync(path.join(folder, 'api'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(folder, 'api', 'docker-compose.yml'), 'services: {}\n');
  saveEnv(paths, { id: 'app', path: folder, sandbox: 'portable-app', overrides: {}, ports: {}, createdWith: { cpus: 4, memory: '8g' } });
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', status: 'running', ports: [] }], published: { 'portable-app': [] } });
  const ctx = {
    paths,
    global: { ...DEFAULTS, claudeConfigRepo: 'https://github.com/me/config.git' },
    sbx,
    runner: {
      async run(cmd, args) {
        if (cmd === 'aws' && args[1] === 'list-profiles') return { code: 0, stdout: 'default\nTerraform\n', stderr: '' };
        if (cmd === 'aws' && args[1] === 'export-credentials') return { code: 1, stdout: '', stderr: 'Token has expired' };
        return { code: 0, stdout: '', stderr: '' };
      },
    },
    secrets: { backend: 'Keychain', async has(name) { return name === 'GH_TOKEN'; } },
  };
  const state = {
    sandbox: { name: 'portable-app', status: 'running' },
    sbxAnswered: true,
    forwards: [],
    blocked: [],
    events: [],
    event(m) { this.events.push({ at: new Date().toISOString(), message: m }); },
    async sync() { return []; },
    async refreshBlocked() { this.blocked = await sbx.approvals('portable-app'); },
  };
  let port;
  const server = http.createServer(createApi({ ctx, id: 'app', token: TOKEN, getPort: () => port, state }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(() => server.close());
  const call = (method, url, { body, token = TOKEN, host } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: url,
      headers: {
        host: host ?? `127.0.0.1:${port}`,
        ...(token ? { 'x-portable-token': token } : {}),
        ...(data ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text.startsWith('{') ? JSON.parse(text) : text }));
    });
    req.on('error', reject);
    req.end(data);
  });
  return { call, paths, sbx, folder, port };
}

test('the API refuses a wrong Host header and a missing token', async (t) => {
  const { call } = await startApi(t);
  assert.equal((await call('GET', '/api/status', { host: 'evil.example:80' })).status, 421);
  assert.equal((await call('GET', '/api/status', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/status', { token: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/api/health', { token: null })).status, 200);
});

test('the page itself loads without the token and with a strict CSP', async (t) => {
  const { call } = await startApi(t);
  const page = await call('GET', '/', { token: null });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.match(page.body, /<title>portable<\/title>/);
});

test('GET /api/status reports the environment', async (t) => {
  const { call, folder } = await startApi(t);
  const { status, body } = await call('GET', '/api/status');
  assert.equal(status, 200);
  assert.equal(body.id, 'app');
  assert.equal(body.path, folder);
  assert.equal(body.status, 'running');
  assert.deepEqual(body.recreateNeeded, []);
});

test('PUT /api/ports saves a sticky port and validates input', async (t) => {
  const { call, paths, port } = await startApi(t);
  assert.equal((await call('PUT', '/api/ports', { body: { sandboxPort: 3000, hostPort: 3999 } })).status, 200);
  assert.deepEqual(loadEnv(paths, 'app').ports, { 3000: 3999 });
  assert.equal((await call('PUT', '/api/ports', { body: { sandboxPort: 3000, hostPort: null } })).status, 200);
  assert.deepEqual(loadEnv(paths, 'app').ports, {});
  assert.equal((await call('PUT', '/api/ports', { body: { sandboxPort: 3000, hostPort: 80 } })).status, 400);
  assert.equal((await call('PUT', '/api/ports', { body: { sandboxPort: 3000, hostPort: port } })).status, 409);
});

test('PUT /api/ports refuses a host port another port or environment sticks to', async (t) => {
  const { call, paths } = await startApi(t);
  assert.equal((await call('PUT', '/api/ports', { body: { sandboxPort: 3000, hostPort: 9000 } })).status, 200);
  const dup = await call('PUT', '/api/ports', { body: { sandboxPort: 4000, hostPort: 9000 } });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /port 3000 sticks/);
  saveEnv(paths, { id: 'other', path: '/w/other', sandbox: 'portable-other', overrides: {}, ports: { 80: 8088 }, uiPort: 7777 });
  assert.match((await call('PUT', '/api/ports', { body: { sandboxPort: 4000, hostPort: 8088 } })).body.error, /'other'/);
  assert.match((await call('PUT', '/api/ports', { body: { sandboxPort: 4000, hostPort: 7777 } })).body.error, /'other'/);
  assert.deepEqual(loadEnv(paths, 'app').ports, { 3000: 9000 });
});

test('GET /api/status reports what the agent last learned, including when sbx did not answer', async (t) => {
  const { call } = await startApi(t);
  // startApi's state says running; the API never asks sbx itself.
  assert.equal((await call('GET', '/api/status')).body.status, 'running');
});

test('PUT /api/settings saves overrides, applies domains and flags a needed recreate', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.sandboxDomains = async () => ['old.example.com'];
  const allowed = [];
  const removed = [];
  sbx.allowDomain = async (name, host) => { allowed.push(host); return true; };
  sbx.removeDomain = async (name, host) => { removed.push(host); return true; };
  const result = await call('PUT', '/api/settings', { body: { overrides: { allowDomains: ['pypi.org'], cpus: 2 } } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.problems, []);
  assert.deepEqual(allowed, ['pypi.org']);
  assert.deepEqual(removed, ['old.example.com']);
  assert.deepEqual(loadEnv(paths, 'app').overrides, { allowDomains: ['pypi.org'], cpus: 2 });
  assert.deepEqual((await call('GET', '/api/status')).body.recreateNeeded, ['cpus']);
  assert.equal((await call('PUT', '/api/settings', { body: { overrides: { allowDomains: ['$(reboot)'] } } })).status, 400);
});

test('POST /api/services only runs compose files inside the environment', async (t) => {
  const { call, sbx, folder } = await startApi(t);
  const ok = await call('POST', '/api/services', { body: { file: path.join(folder, 'compose.yaml'), action: 'up' } });
  assert.equal(ok.status, 200);
  const exec = sbx.calls.find((c) => c[0] === 'exec');
  assert.deepEqual(exec[2], ['docker', 'compose', '-f', path.join(folder, 'compose.yaml'), 'up', '--build', '--detach']);
  assert.equal((await call('POST', '/api/services', { body: { file: '/etc/compose.yaml', action: 'up' } })).status, 400);
  assert.equal((await call('POST', '/api/services', { body: { file: path.join(folder, 'compose.yaml'), action: 'rm' } })).status, 400);
});

test('AWS is off by default, and the page turns it on per environment', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  let off = (await call('GET', '/api/aws')).body;
  assert.equal(off.enabled, false);
  assert.deepEqual(off.profiles, ['default', 'Terraform']);
  assert.equal((await call('POST', '/api/aws/refresh')).status, 400);

  assert.equal((await call('PUT', '/api/settings', { body: { overrides: { awsProfile: 'Terraform' } } })).status, 200);
  assert.equal(loadEnv(paths, 'app').overrides.awsProfile, 'Terraform');
  const on = (await call('GET', '/api/aws')).body;
  assert.deepEqual({ enabled: on.enabled, profile: on.profile, exists: on.profileExists, signedIn: on.signedIn }, { enabled: true, profile: 'Terraform', exists: true, signedIn: false });
  // Turning it on pushed (empty, since signed out) credentials into the sandbox: a cleared block.
  assert.ok(sbx.calls.some((c) => c[0] === 'exec' && c[2].join(' ') === 'portable-setup aws'));

  assert.equal((await call('PUT', '/api/settings', { body: { overrides: { awsProfile: null } } })).status, 200);
  off = (await call('GET', '/api/aws')).body;
  assert.equal(off.enabled, false);
});

test('GET /api/secrets lists names and status, never values', async (t) => {
  const { call } = await startApi(t);
  const { body } = await call('GET', '/api/secrets');
  assert.equal(body.backend, 'Keychain');
  const gh = body.secrets.find((s) => s.name === 'GH_TOKEN');
  assert.deepEqual({ stored: gh.stored, registered: gh.registered }, { stored: true, registered: true });
  assert.ok(!JSON.stringify(body).includes('ghp_'));
});

test('findComposeFiles looks two levels down and skips dependency folders', (t) => {
  const { home } = tempHome(t);
  for (const dir of ['a', 'a/b', 'a/b/c', 'node_modules/x', '.hidden']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  for (const file of ['compose.yaml', 'a/docker-compose.yml', 'a/b/compose.yml', 'a/b/c/compose.yaml', 'node_modules/x/compose.yaml', '.hidden/compose.yaml']) {
    fs.writeFileSync(path.join(home, file), '');
  }
  assert.deepEqual(findComposeFiles(home).map((f) => path.relative(home, f)).sort(), ['a/b/compose.yml', 'a/docker-compose.yml', 'compose.yaml']);
});

test('parseContainers reads docker ps JSON lines with compose labels', () => {
  const line = JSON.stringify({ ID: 'abc', Names: 'app-db-1', Image: 'postgres:17', State: 'running', Status: 'Up 2 minutes', Ports: '0.0.0.0:5432->5432/tcp', Labels: 'com.docker.compose.project=app,com.docker.compose.service=db,com.docker.compose.project.working_dir=/w/app' });
  const [c] = parseContainers(`${line}\nnot json\n`);
  assert.equal(c.service, 'db');
  assert.equal(c.project, 'app');
  assert.equal(c.workingDir, '/w/app');
});

test('parseClaudeInfo splits the probe output', () => {
  const info = parseClaudeInfo('abc123\tAdd a rule\t2 days ago\n---\ncommit\nrun-tests\n---\ngit\n---\nwriting\n');
  assert.deepEqual(info.commit, { hash: 'abc123', subject: 'Add a rule', when: '2 days ago' });
  assert.deepEqual(info.skills, ['commit', 'run-tests']);
  assert.deepEqual(info.rules, ['git']);
  assert.deepEqual(info.disabledInSandbox, ['writing']);
  assert.equal(parseClaudeInfo('\n---\n\n---\n\n---\n').installed, false);
});

test('POST /api/blocked allows a blocked host for this environment and clears the request', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.approvalsList = [{ id: 'network:abc', host: 'example.com', sandbox: 'portable-app' }];
  sbx.sandboxDomains = async () => [];
  const allowed = [];
  sbx.allowDomain = async (name, host) => { allowed.push(host); return true; };
  const result = await call('POST', '/api/blocked', { body: { id: 'network:abc', action: 'allow' } });
  assert.equal(result.status, 200);
  assert.deepEqual(loadEnv(paths, 'app').overrides.allowDomains, ['example.com']);
  assert.deepEqual(allowed, ['example.com']);
  assert.ok(sbx.calls.some((c) => c[0] === 'respond' && c[1] === 'network:abc' && c[2] === 'dismiss'));
  assert.equal((await call('POST', '/api/blocked', { body: { id: 'network:abc', action: 'allow' } })).status, 404);
});

test('PUT /api/claude/repo saves the repo for every environment and switches this sandbox to it', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  const repo = 'https://github.com/me/other-config.git';
  const result = await call('PUT', '/api/claude/repo', { body: { repo } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.problems, []);
  assert.equal(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).claudeConfigRepo, repo);
  assert.deepEqual(sbx.calls.at(-1), ['exec', 'portable-app', ['portable-setup', 'repo'], `${repo}\n`]);
  assert.equal(loadEnv(paths, 'app').appliedRepo, repo);
  assert.equal((await call('GET', '/api/claude')).body.repo, repo);
  assert.equal((await call('PUT', '/api/claude/repo', { body: { repo: 'git@github.com:me/x.git' } })).status, 400);
});

test('PUT /api/claude/repo reports a sandbox that can\'t switch, and keeps the saved repo', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.exec = async () => ({ code: 2, stdout: '', stderr: 'usage: portable-setup install|update|config|aws|ports' });
  const result = await call('PUT', '/api/claude/repo', { body: { repo: '' } });
  assert.equal(result.status, 200);
  assert.match(result.body.problems[0], /portable rm app/);
  assert.equal(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).claudeConfigRepo, '');
  assert.equal(loadEnv(paths, 'app').appliedRepo, undefined);
});
