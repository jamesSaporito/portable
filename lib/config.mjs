// Global settings (config.json) and per-environment settings (envs/<id>.json).
//
// An environment is a folder: there's no file in the project. Its settings record which folder and
// sandbox it is, the overrides made on its page, and the Mac ports its forwards stick to.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  // Optional limit on what a sandbox can see: when set, each environment is this folder or one
  // inside it. Empty means any project folder.
  workspaceDir: '',
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

// Shell variables that override config.json, by their names from older versions.
const OVERRIDE_VARS = {
  WORKSPACE_DIR: 'workspaceDir',
  PORTABLE_CLAUDE_CONFIG_REPO: 'claudeConfigRepo',
  PORTABLE_CLAUDE_CONFIG_DISABLE: 'claudeConfigDisable',
  PORTABLE_ALLOW_DOMAINS: 'allowDomains',
};
const LIST_KEYS = new Set(['claudeConfigDisable', 'allowDomains']);

export function fromEnvVars(values) {
  const settings = {};
  for (const [name, key] of Object.entries(OVERRIDE_VARS)) {
    if (values[name] === undefined) continue;
    settings[key] = LIST_KEYS.has(key) ? String(values[name]).split(/[\s,]+/).filter(Boolean) : values[name];
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

// Global settings: config.json, with shell variables on top.
export function loadGlobal(paths, env = process.env) {
  return { ...DEFAULTS, ...(readJson(paths.configFile) ?? {}), ...fromEnvVars(env) };
}

// Writes config.json from the defaults when there isn't one (install.sh does this once).
export function initGlobal(paths) {
  if (readJson(paths.configFile) === undefined) saveGlobal(paths, DEFAULTS);
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

// Checks a configuration repo URL from the page: blank (none) or an HTTPS git URL, since the sandbox
// reaches GitHub over HTTPS only. Returns it trimmed or throws with what's wrong.
export function validateRepo(value) {
  if (typeof value !== 'string') throw new Error('repo must be a URL');
  const repo = value.trim();
  if (repo && !/^https:\/\/[^\s'"`$\\]+$/.test(repo)) {
    throw new Error('the configuration repo must be an HTTPS git URL, like https://github.com/you/claude-configuration.git');
  }
  return repo;
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
