// Serves the real page and API for one environment against a fake sbx, for the browser tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveApi } from '../support/helpers.mjs';

const TOKEN = 'ui-test-token';

// `groups` is what `sbx policy ls` gives the Network grid; `blocked` the requests sbx refused.
export async function startPage({ groups = [], blocked = [] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ui-test-')));
  const { server, port, sbx } = await serveApi({ home, token: TOKEN, groups, blocked });
  const added = [];
  sbx.sandboxDomains = async () => [...added];
  sbx.allowDomain = async (name, host) => { added.push(host); return true; };
  sbx.removeDomain = async () => true;
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
