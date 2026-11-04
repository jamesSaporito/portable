import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure } from '../lib/configure.mjs';

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
  assert.deepEqual(questions, ['Store it now?', 'Store it now?']);
  assert.deepEqual(calls, [['set', 'GH_TOKEN']]);
  assert.ok(lines.some((l) => l.includes('Fine-grained tokens')));
  assert.ok(lines.includes('New sandboxes will use them.'));

  const declined = setup();
  assert.equal(await declined.run(), 0);
  assert.deepEqual(declined.calls, []);
});

test('configure registers a stored secret sbx isn\'t reading, without asking', async () => {
  const { run, calls, questions } = setup({ stored: ['GH_TOKEN'], registered: ['infracost'] });
  assert.equal(await run(), 0);
  assert.deepEqual(calls, [['register', 'GH_TOKEN']]);
  assert.deepEqual(questions, ['Store it now?']);
});

test('configure offers to replace stored secrets and names sandboxes to recreate', async () => {
  const { run, calls, questions, lines } = setup({
    stored: ['GH_TOKEN', 'INFRACOST_CLI_AUTHENTICATION_TOKEN'],
    registered: ['github', 'infracost', 'anthropic'],
    answers: [true, false],
    sandboxes: ['app', 'api'],
  });
  assert.equal(await run(), 0);
  assert.deepEqual(questions, ['Replace it?', 'Replace it?']);
  assert.deepEqual(calls, [['set', 'GH_TOKEN']]);
  assert.ok(lines.some((l) => l.includes('portable rm app, portable rm api')));
  assert.ok(lines.includes('Claude: signed in.'));
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
