import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { saveEnv } from '../lib/config.mjs';
import { UserError, cleanName, protectedFolders, resolveEnv, sessionFolder, workspaceFolder } from '../lib/env.mjs';
import { tempHome } from './support/helpers.mjs';

function setup(t) {
  const { home, paths } = tempHome(t);
  const ws = path.join(home, 'Projects', 'sandboxed');
  fs.mkdirSync(path.join(ws, 'app'), { recursive: true });
  const folders = { self: path.join(home, 'portable'), config: path.join(home, 'claude-configuration') };
  return { home, paths, ws, folders };
}

test('workspaceFolder is optional and refuses broad, protected, settings and system folders', (t) => {
  const { home, ws, folders } = setup(t);
  assert.equal(workspaceFolder('', home, folders), null);
  assert.equal(workspaceFolder('~/Projects/sandboxed', home, folders), ws);
  for (const bad of ['/', '~', '~/', '/Users', '/usr/local/x', '~/.config/x', '~/Library/x']) {
    assert.throws(() => workspaceFolder(bad, home, folders), UserError, bad);
  }
  fs.mkdirSync(path.join(folders.config, 'ws'), { recursive: true });
  assert.throws(() => workspaceFolder('~/claude-configuration/ws', home, folders), /configuration repo/);
});

test('sessionFolder only allows the workspace and folders in it, minus protected ones', (t) => {
  const { home, ws, folders } = setup(t);
  assert.equal(sessionFolder(path.join(ws, 'app'), ws, folders, home), path.join(ws, 'app'));
  assert.equal(sessionFolder(ws, ws, folders, home), ws);
  assert.throws(() => sessionFolder(home, ws, folders, home), /workspace folder/);
  // A sibling whose name starts with the workspace's isn't inside it.
  fs.mkdirSync(`${ws}-other`);
  assert.throws(() => sessionFolder(`${ws}-other`, ws, folders, home), /workspace folder/);
  const inner = { ...folders, config: path.join(ws, 'config') };
  fs.mkdirSync(inner.config);
  assert.throws(() => sessionFolder(inner.config, ws, inner, home), /configuration repo/);
});

test('without a workspace folder, sessionFolder allows any project folder but not home, its parents or settings', (t) => {
  const { home, folders } = setup(t);
  const project = path.join(home, 'code', 'my-app');
  fs.mkdirSync(project, { recursive: true });
  assert.equal(sessionFolder(project, null, folders, home), project);
  assert.throws(() => sessionFolder(home, null, folders, home), /too broad/);
  assert.throws(() => sessionFolder(path.dirname(home), null, folders, home), /too broad/);
  assert.throws(() => sessionFolder('/', null, folders, home), /too broad/);
  for (const settings of ['.ssh', '.config/portable', 'Library/Application Support']) {
    fs.mkdirSync(path.join(home, settings), { recursive: true });
    assert.throws(() => sessionFolder(path.join(home, settings), null, folders, home), /settings or secrets/, settings);
  }
  fs.mkdirSync(path.join(folders.self, 'lib'), { recursive: true });
  assert.throws(() => sessionFolder(path.join(folders.self, 'lib'), null, folders, home), /copy of portable/);
});

test('protectedFolders finds the git repo ~/.claude/CLAUDE.md links into', (t) => {
  const { home } = tempHome(t);
  const repo = path.join(home, '.local', 'share', 'claude-configuration');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'global'));
  fs.writeFileSync(path.join(repo, 'global', 'CLAUDE.md'), '');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.symlinkSync(path.join(repo, 'global', 'CLAUDE.md'), path.join(home, '.claude', 'CLAUDE.md'));
  assert.equal(protectedFolders(home, home).config, repo);
});

test('cleanName makes sbx-safe names', () => {
  assert.equal(cleanName('My App_2'), 'My-App-2');
  assert.equal(cleanName('.hidden'), 'hidden');
  assert.throws(() => cleanName('---'), UserError);
});

test('resolveEnv names a new folder after it, and adds a hash when the name is taken', (t) => {
  const { paths, ws } = setup(t);
  const folder = path.join(ws, 'app');
  const fresh = resolveEnv({ paths, folder, sandboxes: [] });
  assert.equal(fresh.id, 'app');
  assert.equal(fresh.sandbox, 'portable-app');

  const other = resolveEnv({ paths, folder, sandboxes: [{ name: 'portable-app', workspaces: ['/elsewhere/app'] }] });
  assert.match(other.id, /^app-[0-9a-f]{6}$/);
});

test('resolveEnv adopts the sandbox an older portable made for the folder', (t) => {
  const { paths, ws } = setup(t);
  const folder = path.join(ws, 'app');
  const env = resolveEnv({ paths, folder, sandboxes: [{ name: 'portable-app', workspaces: [folder] }] });
  assert.equal(env.sandbox, 'portable-app');
});

test('resolveEnv returns the saved environment, and keeps --name ones separate', (t) => {
  const { paths, ws } = setup(t);
  const folder = path.join(ws, 'app');
  saveEnv(paths, { id: 'app', path: folder, named: false, sandbox: 'portable-app', overrides: { awsProfile: 'x' }, ports: {} });
  assert.equal(resolveEnv({ paths, folder, sandboxes: [] }).overrides.awsProfile, 'x');
  const named = resolveEnv({ paths, folder, name: 'api', sandboxes: [] });
  assert.equal(named.sandbox, 'portable-api');
  assert.equal(named.named, true);
  saveEnv(paths, named);
  assert.throws(() => resolveEnv({ paths, folder: ws, name: 'api', sandboxes: [] }), /environment of/);
});
