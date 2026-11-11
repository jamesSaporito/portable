import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadEnv, saveEnv } from '../lib/config.mjs';
import { createApi, findComposeFiles, parseClaudeInfo, parseContainers } from '../lib/api.mjs';
import { serveApi, tempHome } from './support/helpers.mjs';

const TOKEN = 'secret-token';

async function startApi(t) {
  const { home } = tempHome(t);
  const { server, port, paths, folder, sbx } = await serveApi({
    home,
    token: TOKEN,
    global: { claudeConfigRepo: 'https://github.com/me/config.git' },
    runner: {
      async run(cmd, args) {
        if (cmd === 'aws' && args[1] === 'list-profiles') return { code: 0, stdout: 'default\nTerraform\n', stderr: '' };
        if (cmd === 'aws' && args[1] === 'export-credentials') return { code: 1, stdout: '', stderr: 'Token has expired' };
        return { code: 0, stdout: '', stderr: '' };
      },
    },
    secrets: { backend: 'Keychain', async has(name) { return name === 'GH_TOKEN'; } },
  });
  fs.mkdirSync(path.join(folder, 'api'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(folder, 'api', 'docker-compose.yml'), 'services: {}\n');
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
  const module = await call('GET', '/hosts.mjs', { token: null });
  assert.equal(module.status, 200);
  assert.match(module.headers['content-type'], /^text\/javascript/);
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

test('GET /api/network lists every allowed host, and says when sbx does not answer', async (t) => {
  const { call, sbx } = await startApi(t);
  assert.deepEqual((await call('GET', '/api/network')).body.groups, [{ source: 'kit', name: 'kit', hosts: ['github.com'] }]);
  sbx.networkPolicy = async () => undefined;
  assert.equal((await call('GET', '/api/network')).status, 502);
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
  const info = parseClaudeInfo('abc123\tAdd a rule\t2 days ago\n---\ncommit\nrun-tests\n---\ngit\n');
  assert.deepEqual(info.commit, { hash: 'abc123', subject: 'Add a rule', when: '2 days ago' });
  assert.deepEqual(info.skills, ['commit', 'run-tests']);
  assert.deepEqual(info.rules, ['git']);
  assert.equal(parseClaudeInfo('\n---\n\n---\n').installed, false);
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

test('PUT /api/offline denies every host but Claude\'s in one call, and undoes only its own denies', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.rules = [
    { decision: 'allow', resources: ['api.anthropic.com:443', 'github.com:443'], provenance: { created_via: 'default' } },
    { decision: 'allow', resources: ['pypi.org'], editable: true, sandbox_id: 'portable-app', provenance: { created_via: 'added' } },
    { id: 'mine', decision: 'deny', resources: ['evil.example'], sandbox_id: 'portable-app', provenance: { created_via: 'added' } },
  ];
  sbx.sandboxDomains = async () => sbx.rules.filter((r) => r.decision === 'allow' && r.sandbox_id).flatMap((r) => r.resources);
  sbx.allowDomain = async (name, host) => {
    sbx.rules.push({ decision: 'allow', resources: [host], editable: true, sandbox_id: name, provenance: { created_via: 'added' } });
    return true;
  };
  assert.equal((await call('PUT', '/api/offline', { body: { offline: 'yes' } })).status, 400);
  // The sandbox's own allow on pypi.org goes first, or sbx would refuse the deny next to it.
  const on = await call('PUT', '/api/offline', { body: { offline: true } });
  assert.deepEqual(on.body, { offline: true, problems: [] });
  assert.deepEqual(sbx.calls.filter((c) => c[0] === 'deny'), [['deny', 'portable-app', 'github.com', 'pypi.org']]);
  assert.equal(loadEnv(paths, 'app').offline, true);
  assert.equal((await call('GET', '/api/status')).body.offline, true);

  // Hosts saved while offline wait for going back online; nothing is denied twice.
  const saved = await call('PUT', '/api/settings', { body: { overrides: { allowDomains: ['pypi.org', 'example.com'] } } });
  assert.deepEqual(saved.body, { problems: [] });
  assert.equal(sbx.calls.filter((c) => c[0] === 'deny').length, 1);
  assert.deepEqual(await sbx.sandboxDomains(), []);

  const off = await call('PUT', '/api/offline', { body: { offline: false } });
  assert.deepEqual(off.body, { offline: false, problems: [] });
  assert.deepEqual(sbx.rules.filter((r) => r.decision === 'deny').map((r) => r.id), ['mine']);
  assert.deepEqual((await sbx.sandboxDomains()).sort(), ['example.com', 'pypi.org']);
  assert.equal(loadEnv(paths, 'app').offline, undefined);
  assert.equal((await call('GET', '/api/status')).body.offline, false);
});

test('hosts kept while offline stay reachable, and follow the list while offline', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.rules = [
    { decision: 'allow', resources: ['**.github.com:443', 'github.com:443', 'registry.npmjs.org:443'], provenance: { created_via: 'default' } },
    { decision: 'allow', resources: ['pypi.org'], editable: true, sandbox_id: 'portable-app', provenance: { created_via: 'added' } },
  ];
  sbx.sandboxDomains = async () => sbx.rules.filter((r) => r.decision === 'allow' && r.sandbox_id).flatMap((r) => r.resources);
  sbx.allowDomain = async (name, host) => {
    sbx.rules.push({ decision: 'allow', resources: [host], editable: true, sandbox_id: name, provenance: { created_via: 'added' } });
    return true;
  };
  const denied = () => sbx.rules.filter((r) => r.decision === 'deny').map((r) => r.resources[0]).sort();
  await call('PUT', '/api/settings', { body: { overrides: { allowDomains: ['pypi.org'], offlineAllow: ['github.com', 'pypi.org'] } } });

  // Kept: github.com, the wider **.github.com that would deny it, and the environment's own pypi.org.
  const on = await call('PUT', '/api/offline', { body: { offline: true } });
  assert.deepEqual(on.body, { offline: true, problems: [] });
  assert.deepEqual(denied(), ['registry.npmjs.org']);
  assert.deepEqual(await sbx.sandboxDomains(), ['pypi.org']);

  // Keeping one more while offline takes its deny off right away.
  await call('PUT', '/api/settings', { body: { overrides: { offlineAllow: ['github.com', 'pypi.org', 'registry.npmjs.org'] } } });
  assert.deepEqual(denied(), []);

  // Removing them denies them again, and the environment's own allow goes first.
  const cleared = await call('PUT', '/api/settings', { body: { overrides: { offlineAllow: null } } });
  assert.deepEqual(cleared.body, { problems: [] });
  assert.deepEqual(denied(), ['**.github.com', 'github.com', 'pypi.org', 'registry.npmjs.org']);
  assert.deepEqual(await sbx.sandboxDomains(), []);
  assert.equal(loadEnv(paths, 'app').overrides.offlineAllow, undefined);

  // Kept again while offline, the environment's host gets its allow back.
  await call('PUT', '/api/settings', { body: { overrides: { offlineAllow: ['pypi.org'] } } });
  assert.deepEqual(await sbx.sandboxDomains(), ['pypi.org']);
  assert.deepEqual(denied(), ['**.github.com', 'github.com', 'registry.npmjs.org']);

  // The list stays saved across going back online, for the next time.
  const off = await call('PUT', '/api/offline', { body: { offline: false } });
  assert.deepEqual(off.body, { offline: false, problems: [] });
  assert.deepEqual(denied(), []);
  assert.deepEqual(loadEnv(paths, 'app').overrides.offlineAllow, ['pypi.org']);
});

test('going back online removes the denies sbx holds, not a list kept elsewhere', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.rules = [
    { decision: 'allow', resources: ['github.com:443', 'pypi.org:443'], provenance: { created_via: 'default' } },
    { id: 'deny-github.com', decision: 'deny', resources: ['github.com'], sandbox_id: 'portable-app', provenance: { created_via: 'added' } },
    { id: 'deny-pypi.org', decision: 'deny', resources: ['pypi.org'], sandbox_id: 'portable-app', provenance: { created_via: 'added' } },
  ];
  // An environment saved by the earlier offline mode, with a list of denies that's out of date.
  saveEnv(paths, { ...loadEnv(paths, 'app'), offline: { denied: ['gone.example'] } });
  const off = await call('PUT', '/api/offline', { body: { offline: false } });
  assert.deepEqual(off.body, { offline: false, problems: [] });
  assert.deepEqual(sbx.rules.filter((r) => r.decision === 'deny'), []);
});

test('going back online while denies are still being added leaves none behind', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.rules = [
    { decision: 'allow', resources: ['github.com:443', 'pypi.org:443'], provenance: { created_via: 'default' } },
  ];
  const denyDomains = sbx.denyDomains.bind(sbx);
  sbx.denyDomains = async (name, hosts) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return denyDomains(name, hosts);
  };
  const on = call('PUT', '/api/offline', { body: { offline: true } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const off = call('PUT', '/api/offline', { body: { offline: false } });
  await Promise.all([on, off]);
  assert.deepEqual(sbx.rules.filter((r) => r.decision === 'deny'), []);
  assert.equal(loadEnv(paths, 'app').offline, undefined);
});

test('going back online stays offline while a deny won\'t come off, and removes the rest', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.rules = [
    { decision: 'allow', resources: ['github.com:443', 'pypi.org:443'], provenance: { created_via: 'default' } },
  ];
  await call('PUT', '/api/offline', { body: { offline: true } });
  const removeDomains = sbx.removeDomains.bind(sbx);
  sbx.removeDomains = async (name, hosts) => !hosts.includes('pypi.org') && removeDomains(name, hosts);
  const off = await call('PUT', '/api/offline', { body: { offline: false } });
  assert.equal(off.body.offline, true);
  assert.equal(off.body.problems.length, 1);
  assert.match(off.body.problems[0], /pypi\.org/);
  assert.deepEqual(sbx.rules.filter((r) => r.decision === 'deny').map((r) => r.resources[0]), ['pypi.org']);
  assert.equal(loadEnv(paths, 'app').offline, true);
});

test('PUT /api/offline refuses when a rule allows every host', async (t) => {
  const { call, paths, sbx } = await startApi(t);
  sbx.rules = [{ decision: 'allow', resources: ['**'], provenance: { created_via: 'default' } }];
  const result = await call('PUT', '/api/offline', { body: { offline: true } });
  assert.equal(result.body.offline, false);
  assert.match(result.body.problems[0], /Open preset/);
  assert.equal(loadEnv(paths, 'app').offline, undefined);
  assert.deepEqual(sbx.calls.filter((c) => c[0] === 'deny'), []);
});
