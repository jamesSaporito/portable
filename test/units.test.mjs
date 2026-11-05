// Small parsers and helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedDomains, allowedHosts, blockedHosts, createSbx, parsePublished, tcpForwards, versionAtLeast } from '../lib/sbx.mjs';
import { parseExport } from '../lib/aws.mjs';
import { covers, parseRequest } from '../lib/ui/hosts.mjs';
import { claudeArgs, parseCommand, versionLine } from '../bin/portable.mjs';

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

test('parseCommand takes only portable\'s own commands, and --name only before claude or exec', () => {
  assert.deepEqual(parseCommand([]), { command: 'shell', name: undefined, args: [] });
  assert.deepEqual(parseCommand(['claude', '--worktree', 'x']), { command: 'claude', name: undefined, args: ['--worktree', 'x'] });
  assert.deepEqual(parseCommand(['configure']), { command: 'configure', args: [] });
  assert.deepEqual(parseCommand(['ui', 'api']), { command: 'ui', args: ['api'] });
  assert.deepEqual(parseCommand(['exec', 'docker', 'compose', 'up', '-d']), { command: 'exec', name: undefined, args: ['docker', 'compose', 'up', '-d'] });
  assert.deepEqual(parseCommand(['--name', 'blah']), { command: 'shell', name: 'blah', args: [] });
  assert.deepEqual(parseCommand(['--name', 'api', 'claude']), { command: 'claude', name: 'api', args: [] });
  assert.deepEqual(parseCommand(['--name', 'api', 'exec', 'ls']), { command: 'exec', name: 'api', args: ['ls'] });

  // Anything else is refused before portable touches settings or sbx.
  assert.throws(() => parseCommand(['blah']), /unknown command 'blah'; see 'portable help' \(to run it in the sandbox: portable exec blah\)/);
  assert.throws(() => parseCommand(['terraform', 'plan']), /unknown command 'terraform'/);
  assert.throws(() => parseCommand(['--bogus']), /unknown option '--bogus'/);
  assert.throws(() => parseCommand(['--name', 'api', 'ps']), /unknown command 'ps' after --name api; see 'portable help' \(to run it in the sandbox: portable --name api exec ps\)/);
  assert.throws(() => parseCommand(['--name']), /usage: portable --name NAME/);
  assert.throws(() => parseCommand(['--name', '--x']), /usage: portable --name NAME/);
  assert.throws(() => parseCommand(['exec']), /usage: portable exec CMD/);
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

test('allowedHosts groups every allow rule for the sandbox by where it came from', () => {
  // Shapes from `sbx policy ls portable-Portfolio2 --type network --format json` (sbx 0.51.0).
  const rules = [
    { name: 'default-ai-services', decision: 'allow', resources: ['api.anthropic.com:443', '**.openai.com:443'], provenance: { created_via: 'default' } },
    { name: 'kit:portable-smoke', decision: 'allow', resources: ['github.com:443', 'mcp.atlassian.com'], sandbox_id: 'portable-smoke', provenance: { created_via: 'provisioned', source: 'sandboxes' } },
    { decision: 'allow', resources: ['pypi.org'], sandbox_id: 'portable-smoke', provenance: { created_via: 'added' } },
    { decision: 'allow', resources: ['old.example.com'], provenance: { created_via: 'added' } },
    { decision: 'allow', resources: ['x.org'], sandbox_id: 'other', provenance: { created_via: 'added' } },
    { name: 'default-deny-all', decision: 'deny', resources: ['**'] },
  ];
  assert.deepEqual(allowedHosts(rules, 'portable-smoke'), [
    { source: 'sbx', name: 'ai services', hosts: ['api.anthropic.com:443', '**.openai.com:443'] },
    { source: 'kit', name: 'kit', hosts: ['github.com:443', 'mcp.atlassian.com'] },
    { source: 'environment', name: 'environment', hosts: ['pypi.org'] },
    { source: 'global', name: 'global', hosts: ['old.example.com'] },
  ]);
  assert.deepEqual(allowedHosts(undefined, 'x'), []);
});

test('covers matches hosts and ports the way sbx did (0.51.0)', () => {
  // https://amazonaws.com answered through `**.amazonaws.com:443`; http://amazonaws.com didn't.
  assert.ok(covers('**.amazonaws.com:443', 'amazonaws.com', 443));
  assert.ok(!covers('**.amazonaws.com:443', 'amazonaws.com', 80));
  assert.ok(covers('**.amazonaws.com:443', 's3.us-east-1.amazonaws.com', 443));
  // The kit's `*.amazonaws.com` has no port: one level of subdomain, any port, not the domain.
  assert.ok(covers('*.amazonaws.com', 's3.amazonaws.com', 80));
  assert.ok(!covers('*.amazonaws.com', 's3.us-east-1.amazonaws.com', 80));
  assert.ok(!covers('*.amazonaws.com', 'amazonaws.com', 80));
  assert.ok(covers('mcp.atlassian.com', 'mcp.atlassian.com', 8443));
  assert.ok(!covers('mcp.atlassian.com', 'atlassian.com', 443));
});

test('parseRequest reads a host, host:port or URL typed into the search', () => {
  assert.deepEqual(parseRequest('http://amazonaws.com/'), { name: 'amazonaws.com', port: 80 });
  assert.deepEqual(parseRequest('https://Docs.AWS.amazon.com/lambda'), { name: 'docs.aws.amazon.com', port: 443 });
  assert.deepEqual(parseRequest('db.example.com:5432'), { name: 'db.example.com', port: 5432 });
  assert.deepEqual(parseRequest('www.amazonaws.com'), { name: 'www.amazonaws.com', port: 443 });
  assert.equal(parseRequest('amazon'), undefined);
  assert.equal(parseRequest('**.amazonaws.com'), undefined);
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
