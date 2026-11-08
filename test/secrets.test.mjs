import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure, secretStatus } from '../lib/secrets.mjs';

// A fake secret store: `stored` names, what set() returns, and a log of calls.
function setup({ stored = [], registered = [], setCode = 0, answers = [], sandboxes = [] } = {}) {
  const calls = [];
  const lines = [];
  const questions = [];
  const secrets = {
    backend: 'Keychain',
    async has(name) { return stored.includes(name); },
    async set(name) { calls.push(['set', name]); if (setCode === 0) stored.push(name); return setCode; },
    async register(name) { calls.push(['register', name]); return 0; },
  };
  const sbx = {
    async secrets() { return registered.map((name) => ({ name })); },
    async ours() { return sandboxes.map((name) => ({ name: `portable-${name}` })); },
  };
  const ask = async (question) => {
    questions.push(question);
    return answers.shift() ?? false;
  };
  const run = () => configure({ secrets, sbx, ask, write: (l) => lines.push(l), interactive: true });
  return { run, calls, lines, questions };
}

test('configure offers each missing secret, defaulting to no, and succeeds whatever the answers', async () => {
  const { run, calls, questions, lines } = setup({ answers: [true] });
  assert.equal(await run(), 0);
  assert.deepEqual(questions, ['Store it now?']);
  assert.deepEqual(calls, [['set', 'GH_TOKEN']]);
  assert.ok(lines.some((l) => l.includes('Fine-grained tokens')));
  assert.ok(lines.includes('New sandboxes will use them.'));

  const declined = setup();
  assert.equal(await declined.run(), 0);
  assert.deepEqual(declined.calls, []);
});

test('configure registers a stored secret sbx isn\'t reading, without asking', async () => {
  const { run, calls, questions } = setup({ stored: ['GH_TOKEN'] });
  assert.equal(await run(), 0);
  assert.deepEqual(calls, [['register', 'GH_TOKEN']]);
  assert.deepEqual(questions, []);
});

test('configure offers to replace stored secrets, which existing sandboxes pick up', async () => {
  const { run, calls, questions, lines } = setup({
    stored: ['GH_TOKEN'],
    registered: ['github', 'anthropic'],
    answers: [true],
    sandboxes: ['app', 'api'],
  });
  assert.equal(await run(), 0);
  assert.deepEqual(questions, ['Replace it?']);
  assert.deepEqual(calls, [['set', 'GH_TOKEN']]);
  assert.ok(lines.some((l) => l.startsWith('Existing sandboxes use the new value')));
  assert.ok(!lines.some((l) => l.includes('portable rm')));
  assert.ok(lines.includes('Claude: signed in.'));
});

test('configure names the sandboxes to recreate for a secret sbx reads for the first time', async () => {
  const { run, lines } = setup({ answers: [true], sandboxes: ['app', 'api'] });
  assert.equal(await run(), 0);
  assert.ok(lines.some((l) => l.includes('portable rm app, portable rm api')));
});

test('secretStatus says which secrets are stored and read by sbx, and whether Claude is signed in', async () => {
  const secrets = { async has(name) { return name === 'GH_TOKEN'; } };
  const status = await secretStatus(secrets, { async secrets() { return [{ name: 'anthropic' }]; } });
  assert.deepEqual(status.secrets.map(({ name, stored, registered }) => ({ name, stored, registered })), [{ name: 'GH_TOKEN', stored: true, registered: false }]);
  assert.equal(status.claudeSignedIn, true);
});

test('configure reports a store that failed and still succeeds', async () => {
  const failed = setup({ setCode: 1, answers: [true] });
  assert.equal(await failed.run(), 0);
  assert.ok(failed.lines.includes("Didn't store GH_TOKEN."));
});

test('configure needs a terminal', async () => {
  const lines = [];
  assert.equal(await configure({ interactive: false, write: (l) => lines.push(l) }), 1);
  assert.match(lines[0], /terminal/);
});
