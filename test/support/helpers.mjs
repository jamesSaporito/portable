// Shared test helpers: a throwaway portable home, the `app` environment, a fake sbx and runner,
// and the environment page's API served against them.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { portablePaths } from '../../lib/paths.mjs';
import { DEFAULTS, loadEnv, saveEnv } from '../../lib/config.mjs';
import { createApi } from '../../lib/api.mjs';

export function tempHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, paths: portablePaths({ HOME: home }) };
}

// Saves the environment most tests use, `app` in /w/app, with `extra` on top, and loads it back.
export function saveAppEnv(paths, extra = {}) {
  saveEnv(paths, { id: 'app', path: '/w/app', sandbox: 'portable-app', overrides: {}, ports: {}, ...extra });
  return loadEnv(paths, 'app');
}

// A fake sbx: `sandboxes` is what `sbx ls` returns; publish/unpublish edit their ports, and
// `refuse` lists host ports whose publish fails (something grabbed them).
export function fakeSbx({ sandboxes = [], published = {}, refuse = [] } = {}) {
  const calls = [];
  const find = (name) => sandboxes.find((s) => s.name === name);
  return {
    calls,
    sandboxes,
    published,
    async list() { return sandboxes; },
    async ours() { return sandboxes.filter((s) => s.name.startsWith('portable-')); },
    async get(name) { return find(name) ?? null; },
    async published(name) { return published[name]; },
    async forwards(name) {
      return (find(name)?.ports ?? []).map((p) => ({ host: p.host_port, sandbox: p.sandbox_port }));
    },
    async publish(name, host, port) {
      calls.push(['publish', name, host, port]);
      if (refuse.includes(host)) return false;
      find(name).ports = [...(find(name).ports ?? []), { host_port: host, sandbox_port: port, protocol: 'tcp4' }];
      return true;
    },
    async unpublish(name, host, port) {
      calls.push(['unpublish', name, host, port]);
      find(name).ports = find(name).ports.filter((p) => !(p.host_port === host && p.sandbox_port === port));
      return true;
    },
    async exec(name, command, opts) {
      calls.push(['exec', name, command, opts?.input]);
      return { code: 0, stdout: '', stderr: '' };
    },
    async secrets() { return [{ name: 'github', scope: 'global', stored: true }]; },
    async networkPolicy() { return [{ source: 'kit', name: 'kit', hosts: ['github.com'] }]; },
    // Raw `sbx policy ls` rules; the deny and remove methods edit them the way sbx 0.51.0 does:
    // a deny next to an allow on the same host in the sandbox's scope is refused, and a batch with
    // one refused host changes nothing.
    rules: [],
    async policyRules() { return this.rules; },
    async denyDomains(name, hosts) {
      calls.push(['deny', name, ...hosts]);
      const scoped = this.rules.filter((r) => r.sandbox_id === name);
      if (scoped.some((r) => r.decision === 'allow' && hosts.some((h) => r.resources.includes(h)))) return false;
      for (const host of hosts) {
        if (scoped.some((r) => r.decision === 'deny' && r.resources.includes(host))) continue;
        this.rules.push({ id: `deny-${host}`, decision: 'deny', sandbox_id: name, resources: [host], provenance: { created_via: 'added' } });
      }
      return true;
    },
    async removeDomain(name, host) {
      return this.removeDomains(name, [host]);
    },
    async removeDomains(name, hosts) {
      calls.push(['rm', name, ...hosts]);
      const scoped = (h) => this.rules.some((r) => r.sandbox_id === name && r.resources.includes(h));
      if (!hosts.every(scoped)) return false;
      this.rules = this.rules.filter((r) => !(r.sandbox_id === name && hosts.some((h) => r.resources.includes(h))));
      return true;
    },
    async sandboxDomains() { return []; },
    approvalsList: [],
    async approvals(name) { return this.approvalsList.filter((a) => a.sandbox === name); },
    async respond(id, option) { calls.push(['respond', id, option]); this.approvalsList = this.approvalsList.filter((a) => a.id !== id); return true; },
  };
}

// A runner whose `run` answers from a table of "cmd arg..." prefixes.
export function fakeRunner(answers = {}) {
  return {
    async run(cmd, args) {
      const line = [cmd, ...args].join(' ');
      const key = Object.keys(answers).find((k) => line.startsWith(k));
      return key ? { code: 0, stdout: answers[key], stderr: '' } : { code: 127, stdout: '', stderr: 'not found' };
    },
    async runInteractive() { return 0; },
  };
}

// Serves the real page and API for the `app` environment (folder <home>/ws/app) against a fake sbx,
// on a free port. `global` goes over the default settings; `groups` is what `sbx policy ls` gives
// the Network grid and `blocked` the requests sbx refused. The caller closes `server`.
export async function serveApi({ home, token, global = {}, runner, secrets, groups, blocked = [] }) {
  const paths = portablePaths({ HOME: home });
  const folder = path.join(home, 'ws', 'app');
  fs.mkdirSync(folder, { recursive: true });
  saveAppEnv(paths, { path: folder, createdWith: { cpus: 4, memory: '8g' } });
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', status: 'running', ports: [] }], published: { 'portable-app': [] } });
  if (groups) sbx.networkPolicy = async () => groups;
  sbx.approvalsList = blocked.map((b) => ({ ...b, sandbox: 'portable-app' }));
  const ctx = {
    paths,
    global: { ...DEFAULTS, ...global },
    sbx,
    runner: runner ?? { async run() { return { code: 0, stdout: '', stderr: '' }; } },
    secrets: secrets ?? { backend: 'Keychain', async has() { return false; } },
  };
  const state = {
    sandbox: { name: 'portable-app', status: 'running' },
    sbxAnswered: true,
    forwards: [],
    blocked: await sbx.approvals('portable-app'),
    events: [],
    event(message) { this.events.push({ at: new Date().toISOString(), message }); },
    async sync() { return []; },
    async refreshBlocked() { this.blocked = await sbx.approvals('portable-app'); },
  };
  let port;
  const server = http.createServer(createApi({ ctx, id: 'app', token, getPort: () => port, state }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return { server, port, paths, folder, sbx };
}
