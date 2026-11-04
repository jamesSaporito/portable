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
  const ask = async (question, defaultYes) => {
    questions.push([question, defaultYes]);
    const answer = answers.shift();
    return answer === undefined ? defaultYes : answer;
  };
  const run = () => configure({ secrets, sbx, ask, write: (l) => lines.push(l), interactive: true });
  return { run, calls, lines, questions };
}

test('configure prompts for missing secrets, required ones defaulting to yes', async () => {
  const { run, calls, questions, lines } = setup({ answers: [undefined, undefined] });
  assert.equal(await run(), 0);
  assert.deepEqual(questions, [['Store it now?', true], ['Store it now?', false]]);
  assert.deepEqual(calls, [['set', 'GH_TOKEN']]);
  assert.ok(lines.some((l) => l.includes('Fine-grained tokens')));
  assert.ok(lines.includes('New sandboxes will use them.'));
});

test('configure registers a stored secret sbx isn\'t reading, without asking', async () => {
  const { run, calls, questions } = setup({ stored: ['GH_TOKEN'], registered: ['infracost'], answers: [false] });
  assert.equal(await run(), 0);
  assert.deepEqual(calls, [['register', 'GH_TOKEN']]);
  assert.deepEqual(questions, [['Store it now?', false]]);
});

test('configure offers to replace stored secrets, defaulting to no, and names sandboxes to recreate', async () => {
  const { run, calls, questions, lines } = setup({
    stored: ['GH_TOKEN', 'INFRACOST_CLI_AUTHENTICATION_TOKEN'],
    registered: ['github', 'infracost', 'anthropic'],
    answers: [true, false],
    sandboxes: ['app', 'api'],
  });
  assert.equal(await run(), 0);
  assert.deepEqual(questions, [['Replace it?', false], ['Replace it?', false]]);
  assert.deepEqual(calls, [['set', 'GH_TOKEN']]);
  assert.ok(lines.some((l) => l.includes('portable rm app, portable rm api')));
  assert.ok(lines.includes('Claude: signed in.'));
});

test('configure fails while a required secret is missing', async () => {
  const declined = setup({ answers: [false, false] });
  assert.equal(await declined.run(), 1);
  const failed = setup({ setCode: 1, answers: [true, false] });
  assert.equal(await failed.run(), 1);
  assert.ok(failed.lines.includes("Didn't store GH_TOKEN."));
});

test('configure needs a terminal', async () => {
  const lines = [];
  assert.equal(await configure({ interactive: false, write: (l) => lines.push(l) }), 1);
  assert.match(lines[0], /terminal/);
});
