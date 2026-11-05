import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv, saveEnv } from '../lib/config.mjs';
import { candidates, parseLsof, reopenForwards, syncPorts, takenPorts } from '../lib/ports.mjs';
import { fakeRunner, fakeSbx, tempHome } from './support/helpers.mjs';

const LSOF = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
postgres  101 me     7u  IPv4 0x1      0t0  TCP 127.0.0.1:5432 (LISTEN)
node      202 me     21u IPv6 0x2      0t0  TCP *:3000 (LISTEN)
`;

test('parseLsof reads listening ports', () => {
  assert.deepEqual([...parseLsof(LSOF)], [5432, 3000]);
});

test('takenPorts leaves out this sandbox\'s own forwards and reserves other environments\' ports', () => {
  const taken = takenPorts({
    sandboxes: [
      { name: 'portable-a', ports: [{ host_port: 3000, sandbox_port: 3000 }] },
      { name: 'portable-b', ports: [{ host_port: 4000, sandbox_port: 4000 }] },
    ],
    listeners: new Set([3000, 5432]),
    envs: [{ id: 'b', ports: { 5000: 5001 }, uiPort: 7000 }],
    self: { id: 'a', sandbox: 'portable-a', uiPort: 7100 },
  });
  assert.deepEqual([...taken].sort(), [4000, 5001, 5432, 7000, 7100].sort());
});

test('candidates try the sticky port, then the same number, then the next free ones', () => {
  const taken = new Set([3001]);
  assert.deepEqual([...candidates(3000, 3005, taken)].slice(0, 3), [3005, 3000, 3002]);
  assert.deepEqual([...candidates(3000, undefined, new Set([3000]))].slice(0, 2), [3001, 3002]);
  // A sticky port someone else holds is skipped for now.
  assert.deepEqual([...candidates(3000, 3001, taken)].slice(0, 2), [3000, 3002]);
});

function env(paths, extra = {}) {
  const e = { id: 'app', path: '/w/app', sandbox: 'portable-app', overrides: {}, ports: {}, ...extra };
  saveEnv(paths, e);
  return loadEnv(paths, 'app');
}

test('syncPorts forwards new ports at the same number and remembers them', async (t) => {
  const { paths } = tempHome(t);
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', ports: [] }], published: { 'portable-app': [3000, 5432] } });
  const result = await syncPorts({ sbx, runner: fakeRunner({ lsof: LSOF }), paths, env: env(paths) });
  // 5432 is a host Postgres and 3000 is taken by a node process.
  assert.deepEqual(result.forwards, [{ host: 3001, sandbox: 3000 }, { host: 5433, sandbox: 5432 }]);
  assert.deepEqual(loadEnv(paths, 'app').ports, { 3000: 3001, 5432: 5433 });
  const write = sbx.calls.find((c) => c[0] === 'exec');
  assert.equal(write[3], '3000 3001\n5432 5433\n');
});

test('syncPorts reuses the sticky port next time', async (t) => {
  const { paths } = tempHome(t);
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', ports: [] }], published: { 'portable-app': [3000] } });
  const result = await syncPorts({ sbx, runner: fakeRunner({ lsof: 'HEADER\n' }), paths, env: env(paths, { ports: { 3000: 3999 } }) });
  assert.deepEqual(result.forwards, [{ host: 3999, sandbox: 3000 }]);
});

test('syncPorts keeps a sticky port that is busy and moves back once it is free', async (t) => {
  const { paths } = tempHome(t);
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', ports: [] }], published: { 'portable-app': [3000] } });
  const busy = fakeRunner({ lsof: 'H\nx 1 me 1u IPv4 0 0t0 TCP *:3999 (LISTEN)\n' });
  let result = await syncPorts({ sbx, runner: busy, paths, env: env(paths, { ports: { 3000: 3999 } }) });
  assert.deepEqual(result.forwards, [{ host: 3000, sandbox: 3000 }]);
  assert.deepEqual(loadEnv(paths, 'app').ports, { 3000: 3999 });

  result = await syncPorts({ sbx, runner: fakeRunner({ lsof: 'H\n' }), paths, env: loadEnv(paths, 'app') });
  assert.deepEqual(result.forwards, [{ host: 3999, sandbox: 3000 }]);
});

test('syncPorts closes forwards nothing publishes anymore, keeping the sticky port', async (t) => {
  const { paths } = tempHome(t);
  const sbx = fakeSbx({
    sandboxes: [{ name: 'portable-app', ports: [{ host_port: 8080, sandbox_port: 8080, protocol: 'tcp4' }] }],
    published: { 'portable-app': [] },
  });
  const result = await syncPorts({ sbx, runner: fakeRunner({ lsof: 'H\n' }), paths, env: env(paths, { ports: { 8080: 8080 } }) });
  assert.deepEqual(result.forwards, []);
  assert.deepEqual(loadEnv(paths, 'app').ports, { 8080: 8080 });
});

test('syncPorts tries the next port when a publish fails', async (t) => {
  const { paths } = tempHome(t);
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', ports: [] }], published: { 'portable-app': [3000] }, refuse: [3000, 3001] });
  const result = await syncPorts({ sbx, runner: fakeRunner({ lsof: 'H\n' }), paths, env: env(paths) });
  assert.deepEqual(result.forwards, [{ host: 3002, sandbox: 3000 }]);
});

test('syncPorts does nothing when the sandbox can\'t be asked', async (t) => {
  const { paths } = tempHome(t);
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', ports: [{ host_port: 1, sandbox_port: 1 }] }], published: {} });
  assert.equal(await syncPorts({ sbx, runner: fakeRunner(), paths, env: env(paths) }), undefined);
  assert.equal(sbx.calls.length, 0);
});

test('syncPorts leaves a host port that another of this environment\'s ports sticks to, and stays put', async (t) => {
  const { paths } = tempHome(t);
  // Two sandbox ports stuck to one host port (hand-edited settings; the page refuses this): neither
  // may take it, so both use their own numbers, and nothing flips back and forth on later ticks.
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', ports: [] }], published: { 'portable-app': [3000, 4000] } });
  const first = await syncPorts({ sbx, runner: fakeRunner({ lsof: 'H\n' }), paths, env: env(paths, { ports: { 3000: 9000, 4000: 9000 } }) });
  assert.deepEqual(first.forwards, [{ host: 3000, sandbox: 3000 }, { host: 4000, sandbox: 4000 }]);
  const second = await syncPorts({ sbx, runner: fakeRunner({ lsof: 'H\n' }), paths, env: loadEnv(paths, 'app') });
  assert.deepEqual(second.changes, []);
});

test('syncPorts uses the sandbox list it is given and gives up when sbx did not answer', async (t) => {
  const { paths } = tempHome(t);
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-app', ports: [] }], published: { 'portable-app': [3000] } });
  let listed = 0;
  sbx.list = async () => { listed++; return undefined; };
  assert.equal(await syncPorts({ sbx, runner: fakeRunner({ lsof: 'H\n' }), paths, env: env(paths) }), undefined);
  const result = await syncPorts({ sbx, runner: fakeRunner({ lsof: 'H\n' }), paths, env: env(paths), sandboxes: sbx.sandboxes });
  assert.deepEqual(result.forwards, [{ host: 3000, sandbox: 3000 }]);
  assert.equal(listed, 1);
});

test('reopenForwards closes and reopens each forward at the same host port', async () => {
  const sbx = fakeSbx({ sandboxes: [{ name: 'portable-a', ports: [
    { host_port: 5432, sandbox_port: 5432, protocol: 'tcp4' },
    { host_port: 3001, sandbox_port: 3000, protocol: 'tcp4' },
  ] }], refuse: [3001] });
  const failed = await reopenForwards(sbx, 'portable-a');
  assert.deepEqual(sbx.calls, [
    ['unpublish', 'portable-a', 5432, 5432], ['publish', 'portable-a', 5432, 5432],
    ['unpublish', 'portable-a', 3001, 3000], ['publish', 'portable-a', 3001, 3000],
  ]);
  assert.deepEqual(failed, [{ host: 3001, sandbox: 3000 }]);
});
