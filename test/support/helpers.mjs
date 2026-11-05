// Shared test helpers: a throwaway portable home and a fake sbx.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { portablePaths } from '../../lib/paths.mjs';

export function tempHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, paths: portablePaths({ HOME: home }) };
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
