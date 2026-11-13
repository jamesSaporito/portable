// Runs the browser tests (`npm run test:ui:docker`) in a throwaway container on the sandbox's own Docker,
// for a portable sandbox, which has no Chrome. Arguments go to `playwright test`.
//
// Debian's Chromium is installed into the container on each run (Google Chrome has no Linux arm64 build),
// so nothing is cached: the container goes with --rm, the repo is mounted read-only and Playwright's
// output stays in the container, and the base image is removed afterwards unless it was already there.
// Node is the sandbox's own, mounted read-only at the same path. Both are Debian trixie on the same arch.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// The kit's base image, so its digest is bumped in one place.
const IMAGE = fs.readFileSync(path.join(ROOT, 'kit/portable.dockerfile'), 'utf8').match(/^FROM (\S+)/m)[1];
const NODE = path.resolve(process.execPath, '../..');

if (process.platform !== 'linux') {
  console.error('test:ui:docker runs in a portable sandbox. On the Mac, use npm run test:ui');
  process.exit(2);
}

const docker = (...args) => spawnSync('docker', args, { stdio: 'inherit' });
const hadImage = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;

const run = docker(
  'run', '--rm', '--init',
  '-v', `${ROOT}:${ROOT}:ro`, '-w', ROOT,
  '-v', `${NODE}:${NODE}:ro`,
  '-e', `PATH=${NODE}/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  '-e', 'UI_TEST_CHROMIUM=/usr/bin/chromium',
  IMAGE, 'sh', '-c',
  'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends chromium >/dev/null'
    + ' && exec node node_modules/@playwright/test/cli.js test "$@"',
  'test-ui', ...process.argv.slice(2),
);
if (!hadImage) spawnSync('docker', ['image', 'rm', IMAGE], { stdio: 'ignore' });
process.exit(run.status ?? 1);
