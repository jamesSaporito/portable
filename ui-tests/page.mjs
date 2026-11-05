// Serves the real page and API for one environment against a fake sbx, for the browser tests.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, saveEnv } from '../lib/config.mjs';
import { createApi } from '../lib/api.mjs';
import { portablePaths } from '../lib/paths.mjs';
import { fakeSbx } from '../test/support/helpers.mjs';

const TOKEN = 'ui-test-token';

// `groups` is what `sbx policy ls` gives the Network grid; `blocked` the requests sbx refused.
export async function startPage({ groups = [], blocked = [] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ui-test-')));
  const paths = portablePaths({ HOME: home });
  const folder = path.join(home, 'ws', 'app');
  fs.mkdirSync(folder, { recursive: true });
  saveEnv(paths, { id: 'app', path: folder, sandbox: 'portable-app', overrides: {}, ports: {}, createdWith: { cpus: 4, memory: '8g' } });

  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', status: 'running', ports: [] }], published: { 'portable-app': [] } });
  sbx.networkPolicy = async () => groups;
  sbx.approvalsList = blocked.map((b) => ({ ...b, sandbox: 'portable-app' }));
  const added = [];
  sbx.sandboxDomains = async () => [...added];
  sbx.allowDomain = async (name, host) => { added.push(host); return true; };
  sbx.removeDomain = async () => true;

  const ctx = {
    paths,
    global: { ...DEFAULTS },
    sbx,
    runner: { async run() { return { code: 0, stdout: '', stderr: '' }; } },
    secrets: { backend: 'Keychain', async has() { return false; } },
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
  const server = http.createServer(createApi({ ctx, id: 'app', token: TOKEN, getPort: () => port, state }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/?t=${TOKEN}`,
    added,
    async close() {
      // The page polls with keep-alive connections and is still open here, so drop them;
      // close() alone waits for them and hangs the test now and then.
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
