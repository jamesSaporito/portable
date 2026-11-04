// Global settings (config.json) and per-environment settings (envs/<id>.json).
//
// An environment is a folder: there's no file in the project. Its settings record which folder and
// sandbox it is, the overrides made on its page, and the Mac ports its forwards stick to.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  // The most a sandbox can see. Each environment is this folder or one inside it.
  workspaceDir: '~/Projects/sandboxed',
  // Cloned into every sandbox and linked into ~/.claude with its own install.sh.
  claudeConfigRepo: '',
  // Skills or rules of the config repo to leave off in sandboxes.
  claudeConfigDisable: [],
  // Hosts every sandbox may reach on top of the kit's list.
  allowDomains: [],
  // Size of each microVM, fixed when it's created.
  cpus: 4,
  memory: '8g',
});

// Keys an environment may override on its page. `awsProfile` has no global default: AWS is off
// unless an environment's page turns it on with a profile from this Mac.
export const OVERRIDABLE = ['allowDomains', 'awsProfile', 'claudeConfigDisable', 'cpus', 'memory'];
const ENV_ONLY = { awsProfile: '' };
// Overrides that only take effect when the sandbox is created.
export const CREATE_ONLY = ['cpus', 'memory'];

const LEGACY_KEYS = {
  WORKSPACE_DIR: 'workspaceDir',
  PORTABLE_CLAUDE_CONFIG_REPO: 'claudeConfigRepo',
  PORTABLE_CLAUDE_CONFIG_DISABLE: 'claudeConfigDisable',
  PORTABLE_ALLOW_DOMAINS: 'allowDomains',
};
const LIST_KEYS = new Set(['claudeConfigDisable', 'allowDomains']);

// Reads a .env file as plain KEY=VALUE lines; nothing in it is ever executed.
export function parseEnvFile(text) {
  const values = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = line.slice(eq + 1).trim();
  }
  return values;
}

function words(value) {
  return String(value).split(/[\s,]+/).filter(Boolean);
}

// portable's old .env and shell variables use these names; map them onto config keys.
export function fromLegacy(values) {
  const settings = {};
  for (const [name, key] of Object.entries(LEGACY_KEYS)) {
    if (values[name] === undefined) continue;
    settings[key] = LIST_KEYS.has(key) ? words(values[name]) : values[name];
  }
  return settings;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`${file} isn't valid JSON (${error.message}); fix or delete it`);
  }
}

export function writeJson(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

// Settings an older portable kept in .env, read when there's no config.json yet. Only read: that
// older portable may still be installed and using the file, so nothing here moves or renames it.
function legacySettings(paths) {
  try {
    return fromLegacy(parseEnvFile(fs.readFileSync(paths.legacyEnvFile, 'utf8')));
  } catch {
    return {};
  }
}

// Global settings: config.json, else the old .env's values. Shell variables with the old names
// still win, as they did.
export function loadGlobal(paths, env = process.env) {
  const stored = readJson(paths.configFile) ?? legacySettings(paths);
  return { ...DEFAULTS, ...stored, ...fromLegacy(env) };
}

// Writes config.json from the defaults and the old .env (install.sh does this once). The .env is
// left where it is for the older portable; it stops mattering once config.json exists.
export function initGlobal(paths) {
  if (readJson(paths.configFile) === undefined) saveGlobal(paths, { ...DEFAULTS, ...legacySettings(paths) });
  return loadGlobal(paths, {});
}

export function saveGlobal(paths, settings) {
  const stored = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (settings[key] !== undefined) stored[key] = settings[key];
  }
  writeJson(paths.configFile, stored);
}

// --- environments ---------------------------------------------------------------------------------

export function envFile(paths, id) {
  return path.join(paths.envsDir, `${id}.json`);
}

export function loadEnv(paths, id) {
  const stored = readJson(envFile(paths, id));
  return stored && { overrides: {}, ports: {}, ...stored, id };
}

export function saveEnv(paths, envSettings) {
  writeJson(envFile(paths, envSettings.id), envSettings);
}

// Re-reads the environment, applies `change` and saves it, so writers in different processes (the
// CLI, the page) only touch what they mean to. Returns the saved settings.
export function updateEnv(paths, id, change) {
  const current = loadEnv(paths, id);
  if (!current) throw new Error(`no environment '${id}'`);
  change(current);
  saveEnv(paths, current);
  return current;
}

export function listEnvs(paths) {
  let names;
  try {
    names = fs.readdirSync(paths.envsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadEnv(paths, name.slice(0, -5)))
    .filter(Boolean);
}

export function deleteEnv(paths, id) {
  fs.rmSync(envFile(paths, id), { force: true });
}

// What an environment actually uses: the global settings with its overrides on top. Allowed
// domains add to the global list rather than replace it.
export function effectiveSettings(global, envSettings) {
  const overrides = envSettings?.overrides ?? {};
  const settings = { ...global, ...ENV_ONLY };
  for (const key of OVERRIDABLE) {
    if (overrides[key] === undefined || overrides[key] === null) continue;
    settings[key] = key === 'allowDomains'
      ? [...new Set([...global.allowDomains, ...overrides.allowDomains])]
      : overrides[key];
  }
  return settings;
}

// Checks overrides sent from the page; returns a clean copy or throws with what's wrong.
export function validateOverrides(input) {
  const clean = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!OVERRIDABLE.includes(key)) throw new Error(`unknown setting '${key}'`);
    if (value === null) {
      clean[key] = null;
      continue;
    }
    switch (key) {
      case 'allowDomains':
        if (!Array.isArray(value) || !value.every((d) => /^(\*\*?\.)?[A-Za-z0-9.-]+(:\d+)?$/.test(d))) {
          throw new Error('allowDomains must be host names like pypi.org or *.example.com');
        }
        clean[key] = [...new Set(value)];
        break;
      case 'claudeConfigDisable':
        if (!Array.isArray(value) || !value.every((n) => /^[A-Za-z0-9_.-]+$/.test(n))) {
          throw new Error('claudeConfigDisable must be skill or rule names');
        }
        clean[key] = [...new Set(value)];
        break;
      case 'awsProfile':
        if (typeof value !== 'string' || !/^[A-Za-z0-9_.@+-]*$/.test(value)) throw new Error('awsProfile must be a profile name');
        clean[key] = value;
        break;
      case 'cpus':
        if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error('cpus must be a whole number from 1 to 64');
        clean[key] = value;
        break;
      case 'memory':
        if (typeof value !== 'string' || !/^\d+[mg]$/i.test(value)) throw new Error('memory must look like 8g or 4096m');
        clean[key] = value.toLowerCase();
        break;
    }
  }
  return clean;
}
