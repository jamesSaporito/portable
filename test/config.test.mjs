import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULTS, effectiveSettings, fromEnvVars, initGlobal, loadEnv, loadGlobal, updateEnv, validateOverrides, validateRepo,
} from '../lib/config.mjs';
import { saveAppEnv, tempHome } from './support/helpers.mjs';

test('fromEnvVars maps the shell variable names and splits lists', () => {
  assert.deepEqual(fromEnvVars({ PORTABLE_ALLOW_DOMAINS: 'a.org  b.org', PORTABLE_CLAUDE_CONFIG_REPO: 'r', OTHER: 'x' }), {
    allowDomains: ['a.org', 'b.org'],
    claudeConfigRepo: 'r',
  });
});

test('initGlobal writes config.json from the defaults once and keeps what is there', (t) => {
  const { paths } = tempHome(t);
  assert.equal(initGlobal(paths).cpus, DEFAULTS.cpus);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(paths.configFile, 'utf8'))).sort(), Object.keys(DEFAULTS).sort());
  fs.writeFileSync(paths.configFile, JSON.stringify({ claudeConfigRepo: 'kept' }));
  assert.equal(initGlobal(paths).claudeConfigRepo, 'kept');
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
  assert.equal(fromEnvVars({ PORTABLE_AWS_PROFILE: 'x' }).awsProfile, undefined);
});

test('the hosts kept while offline are the environment\'s own, empty unless it saved some', () => {
  assert.deepEqual(effectiveSettings(DEFAULTS, { overrides: {} }).offlineAllow, []);
  assert.deepEqual(effectiveSettings(DEFAULTS, { overrides: { offlineAllow: ['**.github.com'] } }).offlineAllow, ['**.github.com']);
  assert.deepEqual(validateOverrides({ offlineAllow: ['github.com', '**.github.com', 'github.com'] }), { offlineAllow: ['github.com', '**.github.com'] });
  assert.deepEqual(validateOverrides({ offlineAllow: null }), { offlineAllow: null });
  assert.throws(() => validateOverrides({ offlineAllow: ['$(reboot)'] }), /offlineAllow/);
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
  saveAppEnv(paths);
  updateEnv(paths, 'app', (e) => { e.ports[3000] = 3001; });
  updateEnv(paths, 'app', (e) => { e.overrides.awsProfile = 'x'; });
  const env = loadEnv(paths, 'app');
  assert.deepEqual(env.ports, { 3000: 3001 });
  assert.equal(env.overrides.awsProfile, 'x');
});

test('validateRepo takes blank or an HTTPS git URL, nothing a shell would read', () => {
  assert.equal(validateRepo(''), '');
  assert.equal(validateRepo('  https://github.com/me/claude-configuration.git '), 'https://github.com/me/claude-configuration.git');
  for (const bad of ['git@github.com:me/x.git', 'http://github.com/me/x', 'https://github.com/me/x $(reboot)', 'https://x/`id`', 42]) {
    assert.throws(() => validateRepo(bad), /HTTPS git URL|must be a URL/, String(bad));
  }
});
