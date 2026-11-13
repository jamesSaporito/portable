import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './support/helpers.mjs';

const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit', 'files', 'portable-setup');
const REPO = 'https://github.com/me/config.git';

// Runs `portable-setup pull` against a clone in a fake agent home, already filtered and linked, with
// git, curl and timeout stubbed: `fetch` fails unless `fetched`, and curl answers with `page` (the
// proxy's block page or GitHub's) or fails without one.
function pull(t, { repo = REPO, fetched = false, page } = {}) {
  const { home } = tempHome(t);
  const config = path.join(home, 'claude-configuration');
  fs.mkdirSync(path.join(config, '.git'), { recursive: true });
  fs.mkdirSync(path.join(config, 'global'));
  fs.writeFileSync(path.join(config, '.git', 'portable-filtered'), '\n');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.symlinkSync(path.join(config, 'global', 'CLAUDE.md'), path.join(home, '.claude', 'CLAUDE.md'));
  fs.writeFileSync(path.join(home, 'repo'), repo);
  fs.writeFileSync(path.join(home, 'disable'), '');

  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('timeout', 'shift; exec "$@"');
  stub('git', `[ "$1" = -C ] && shift 2
case "$1" in
  config) echo ${REPO} ;;
  fetch) ${fetched ? 'exit 0' : "echo \"fatal: unable to access '${REPO}/': The requested URL returned error: 403\" >&2; exit 128"} ;;
  rev-parse) echo 1111111 ;;
  log) echo abc1234 ;;
esac`);
  stub('curl', page === undefined ? 'exit 7' : `echo '${page}'`);

  return spawnSync('bash', [SETUP, 'pull'], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      PORTABLE_AGENT_HOME: home,
      PORTABLE_REPO_FILE: path.join(home, 'repo'),
      PORTABLE_DISABLE_FILE: path.join(home, 'disable'),
    },
    encoding: 'utf8',
  });
}

const lastLine = (text) => text.trim().split('\n').at(-1);

test('pull reports a repo already up to date with its commit', (t) => {
  const result = pull(t, { fetched: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'current abc1234\n');
});

test('pull fails saying the host is blocked when the proxy refuses it', (t) => {
  const result = pull(t, { page: 'Blocked by the network policy. Run sbx policy approval to allow it.' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(lastLine(result.stderr), `portable: couldn't fetch ${REPO}: github.com is blocked by the sandbox's network rules; using the copy already there`);
});

test('pull fails with git\'s reason when the host answers, and says when it can\'t be reached', (t) => {
  assert.match(lastLine(pull(t, { page: '<html>GitHub</html>' }).stderr), /couldn't fetch .*: fatal: unable to access .*error: 403; using the copy/);
  assert.match(lastLine(pull(t).stderr), /couldn't fetch .*: github\.com can't be reached from the sandbox; using the copy/);
});

test('pull fails without a repo set', (t) => {
  const result = pull(t, { repo: '' });
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stderr), 'portable: no Claude configuration repo set');
});
