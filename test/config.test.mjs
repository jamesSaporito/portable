import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULTS, effectiveSettings, fromLegacy, initGlobal, loadEnv, loadGlobal, parseEnvFile, saveEnv, updateEnv, validateOverrides,
} from '../lib/config.mjs';
import { tempHome } from './support/helpers.mjs';

test('parseEnvFile reads KEY=VALUE lines and skips comments and junk', () => {
  const values = parseEnvFile('# comment\nWORKSPACE_DIR=~/Projects/x\n\nBAD KEY=1\nPORTABLE_ALLOW_DOMAINS=a.org b.org\n=nokey\n');
  assert.deepEqual(values, { WORKSPACE_DIR: '~/Projects/x', PORTABLE_ALLOW_DOMAINS: 'a.org b.org' });
});

test('fromLegacy maps the old names and splits lists', () => {
  assert.deepEqual(fromLegacy({ PORTABLE_ALLOW_DOMAINS: 'a.org  b.org', PORTABLE_CLAUDE_CONFIG_REPO: 'r', OTHER: 'x' }), {
    allowDomains: ['a.org', 'b.org'],
    claudeConfigRepo: 'r',
  });
});

test('loadGlobal reads an older portable\'s .env without touching it; initGlobal writes config.json from it', (t) => {
  const { paths } = tempHome(t);
  fs.mkdirSync(paths.config, { recursive: true });
  const env = 'WORKSPACE_DIR=~/Projects/sandboxed\nPORTABLE_CLAUDE_CONFIG_REPO=https://github.com/me/config.git\n';
  fs.writeFileSync(paths.legacyEnvFile, env);
  const global = loadGlobal(paths, {});
  assert.equal(global.claudeConfigRepo, 'https://github.com/me/config.git');
  assert.equal(global.cpus, DEFAULTS.cpus);
  assert.ok(!fs.existsSync(paths.configFile), 'reading must not write config.json');
  assert.equal(fs.readFileSync(paths.legacyEnvFile, 'utf8'), env, 'the .env stays for the older portable');

  initGlobal(paths);
  assert.equal(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).claudeConfigRepo, 'https://github.com/me/config.git');
  assert.ok(fs.existsSync(paths.legacyEnvFile));
  // A second init keeps what's there.
  fs.writeFileSync(paths.configFile, JSON.stringify({ awsProfile: 'kept' }));
  assert.equal(initGlobal(paths).awsProfile, 'kept');
});

test('loadGlobal lets shell variables win over config.json', (t) => {
  const { paths } = tempHome(t);
  fs.mkdirSync(paths.config, { recursive: true });
  fs.writeFileSync(paths.configFile, JSON.stringify({ claudeConfigRepo: 'stored' }));
  assert.equal(loadGlobal(paths, { PORTABLE_CLAUDE_CONFIG_REPO: 'shell' }).claudeConfigRepo, 'shell');
  assert.equal(loadGlobal(paths, {}).claudeConfigRepo, 'stored');
});

test('effectiveSettings adds allowed domains and replaces the rest', () => {
  const global = { ...DEFAULTS, allowDomains: ['a.org'] };
  const settings = effectiveSettings(global, { overrides: { allowDomains: ['b.org', 'a.org'], awsProfile: 'e', cpus: null } });
  assert.deepEqual(settings.allowDomains, ['a.org', 'b.org']);
  assert.equal(settings.awsProfile, 'e');
  assert.equal(settings.cpus, DEFAULTS.cpus);
});

test('AWS is off unless the environment turned it on; an old global awsProfile is ignored', () => {
  const global = { ...DEFAULTS, awsProfile: 'leftover-from-config.json' };
  assert.equal(effectiveSettings(global, { overrides: {} }).awsProfile, '');
  assert.equal(effectiveSettings(global, { overrides: { awsProfile: 'tf' } }).awsProfile, 'tf');
  assert.equal(fromLegacy({ PORTABLE_AWS_PROFILE: 'x' }).awsProfile, undefined);
});

test('validateOverrides accepts good values and rejects bad ones', () => {
  assert.deepEqual(validateOverrides({ allowDomains: ['pypi.org', '*.example.com', 'pypi.org'], memory: '4G', cpus: 2, awsProfile: null }), {
    allowDomains: ['pypi.org', '*.example.com'],
    memory: '4g',
    cpus: 2,
    awsProfile: null,
  });
  assert.throws(() => validateOverrides({ allowDomains: ['bad host; rm -rf'] }), /allowDomains/);
  assert.throws(() => validateOverrides({ claudeConfigDisable: ['../etc'] }), /claudeConfigDisable/);
  assert.throws(() => validateOverrides({ cpus: 0 }), /cpus/);
  assert.throws(() => validateOverrides({ memory: 'lots' }), /memory/);
  assert.throws(() => validateOverrides({ workspaceDir: '/' }), /unknown setting/);
});

test('updateEnv re-reads before writing, so concurrent writers keep each other\'s changes', (t) => {
  const { paths } = tempHome(t);
  saveEnv(paths, { id: 'app', path: '/w/app', sandbox: 'portable-app', overrides: {}, ports: {} });
  updateEnv(paths, 'app', (e) => { e.ports[3000] = 3001; });
  updateEnv(paths, 'app', (e) => { e.overrides.awsProfile = 'x'; });
  const env = loadEnv(paths, 'app');
  assert.deepEqual(env.ports, { 3000: 3001 });
  assert.equal(env.overrides.awsProfile, 'x');
});
