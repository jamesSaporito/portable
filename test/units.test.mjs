// Small parsers and helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedDomains, blockedHosts, createSbx, parsePublished, tcpForwards, versionAtLeast } from '../lib/sbx.mjs';
import { parseExport } from '../lib/aws.mjs';
import { claudeArgs, versionLine } from '../bin/portable.mjs';

test('parsePublished keeps TCP ports published on all interfaces', () => {
  const text = '0.0.0.0 3000 3000/tcp\n:: 3000 3000/tcp\n127.0.0.1 9229 9229/tcp\n0.0.0.0 5353 5353/udp\n0.0.0.0 80 8080/tcp\n';
  assert.deepEqual(parsePublished(text), [80, 3000]);
});

test('tcpForwards reads sbx port entries', () => {
  assert.deepEqual(tcpForwards([
    { host_port: 3001, sandbox_port: 3000, protocol: 'tcp4' },
    { host_port: 53, sandbox_port: 53, protocol: 'udp' },
  ]), [{ host: 3001, sandbox: 3000 }]);
  assert.deepEqual(tcpForwards(undefined), []);
});

test('versionAtLeast compares dotted versions', () => {
  assert.ok(versionAtLeast('0.50.1', '0.50.0'));
  assert.ok(versionAtLeast('1.0.0', '0.50.0'));
  assert.ok(!versionAtLeast('0.49.9', '0.50.0'));
});

test('sbx.list is undefined when sbx did not answer, and get tells missing from unknown', async () => {
  const failing = createSbx({ run: async () => ({ code: 1, stdout: '', stderr: 'daemon down' }) });
  assert.equal(await failing.list(), undefined);
  assert.equal(await failing.get('portable-x'), undefined);
  assert.equal(await failing.ours(), undefined);
  const ok = createSbx({ run: async () => ({ code: 0, stdout: JSON.stringify([{ name: 'portable-a', status: 'running' }]), stderr: '' }) });
  assert.equal((await ok.get('portable-a')).status, 'running');
  assert.equal(await ok.get('portable-b'), null);
});

test('sbx.create passes size, env and the kit, and skips empty values', async () => {
  let seen;
  const sbx = createSbx({ runInteractive: async (cmd, args) => { seen = args; return 0; } });
  await sbx.create('portable-app', '/w/app', { env: { A: '1', B: '', C: undefined }, kit: '/kit', cpus: 2, memory: '4g' });
  assert.deepEqual(seen.slice(0, 9), ['create', '--name', 'portable-app', '--skills=off', '--cpus', '2', '--memory', '4g', '-e']);
  assert.ok(seen.includes('A=1'));
  assert.ok(!seen.some((a) => a.startsWith('B=') || a.startsWith('C=')));
  assert.deepEqual(seen.slice(-3), ['--kit', '/kit', '/w/app']);
});

test('sbx.create builds the kit in the builder sandbox unless SBX_KIT_BUILDER is set', async () => {
  let seen;
  const sbx = createSbx({ runInteractive: async (cmd, args, opts) => { seen = opts.env; return 0; } });
  const saved = process.env.SBX_KIT_BUILDER;
  try {
    delete process.env.SBX_KIT_BUILDER;
    await sbx.create('portable-app', '/w/app', { kit: '/kit' });
    assert.equal(seen.SBX_KIT_BUILDER, 'sandbox');
    assert.equal(seen.PATH, process.env.PATH);
    process.env.SBX_KIT_BUILDER = 'host';
    await sbx.create('portable-app', '/w/app', { kit: '/kit' });
    assert.equal(seen.SBX_KIT_BUILDER, 'host');
  } finally {
    if (saved === undefined) delete process.env.SBX_KIT_BUILDER;
    else process.env.SBX_KIT_BUILDER = saved;
  }
});

test('parseExport only takes the AWS credential names', () => {
  assert.deepEqual(parseExport('AWS_ACCESS_KEY_ID=AKIA\nAWS_SECRET_ACCESS_KEY=s\nPATH=/evil\nAWS_SESSION_TOKEN=t\n'), {
    AWS_ACCESS_KEY_ID: 'AKIA',
    AWS_SECRET_ACCESS_KEY: 's',
    AWS_SESSION_TOKEN: 't',
  });
});

test('claudeArgs asks before acting unless a permission flag is given', () => {
  assert.deepEqual(claudeArgs([]), ['--permission-mode', 'default']);
  assert.deepEqual(claudeArgs(['--worktree', 'x']), ['--permission-mode', 'default', '--worktree', 'x']);
  assert.deepEqual(claudeArgs(['--permission-mode', 'acceptEdits']), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(claudeArgs(['--dangerously-skip-permissions']), ['--dangerously-skip-permissions']);
});

test('addedDomains keeps only hosts added for this sandbox', () => {
  // Shapes from `sbx policy ls portable-smoke --format json` (sbx 0.50.1).
  const rules = [
    { scope: 'sandbox:portable-smoke', decision: 'allow', resources: ['github.com'], editable: false, sandbox_id: 'portable-smoke', provenance: { created_via: 'provisioned' } },
    { scope: 'sandbox:portable-smoke', decision: 'allow', resources: ['pypi.org'], editable: true, sandbox_id: 'portable-smoke', provenance: { created_via: 'added' } },
    { scope: 'global', decision: 'allow', resources: ['api.anthropic.com:443'], editable: true, provenance: { created_via: 'default' } },
    { scope: 'sandbox:other', decision: 'allow', resources: ['x.org'], editable: true, sandbox_id: 'other', provenance: { created_via: 'added' } },
  ];
  assert.deepEqual(addedDomains(rules, 'portable-smoke'), ['pypi.org']);
});

test('blockedHosts keeps this sandbox\'s network requests and drops the HTTPS port', () => {
  // Shape from `sbx policy approval ls --format json` (sbx 0.50.1).
  const approvals = [
    { id: 'network:a', title: 'jamessaporito.com:443', sandbox_name: 'portable-smoke', created_at: 't1' },
    { id: 'network:b', title: 'db.example.com:5432', sandbox_name: 'portable-smoke', created_at: 't2' },
    { id: 'network:c', title: 'other.com:443', sandbox_name: 'portable-other', created_at: 't3' },
  ];
  assert.deepEqual(blockedHosts(approvals, 'portable-smoke'), [
    { id: 'network:a', host: 'jamessaporito.com', at: 't1' },
    { id: 'network:b', host: 'db.example.com:5432', at: 't2' },
  ]);
  assert.deepEqual(blockedHosts(undefined, 'x'), []);
});

test('versionLine shows the version, the commit and whether the copy has changes', () => {
  assert.equal(versionLine('3.0.0', 'abc1234', false), 'portable 3.0.0 (abc1234)');
  assert.equal(versionLine('3.0.0', 'abc1234', true), 'portable 3.0.0 (abc1234, with local changes)');
  assert.equal(versionLine('3.0.0', '', false), 'portable 3.0.0');
});
