// Where portable keeps things on the host. Nothing is ever written into a project folder.
//   config.json        global settings (workspace folder, config repo, defaults for every environment)
//   envs/<id>.json     one environment: its folder, sandbox, overrides and sticky ports
//   state/<id>/        the environment's host agent: agent.json (pid, URL), token, agent.log
import os from 'node:os';
import path from 'node:path';

export function portablePaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const config = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'portable');
  const state = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'portable');
  return {
    home,
    config,
    configFile: path.join(config, 'config.json'),
    legacyEnvFile: path.join(config, '.env'),
    envsDir: path.join(config, 'envs'),
    state,
    installDir: env.PORTABLE_INSTALL_DIR || path.join(home, '.local', 'share', 'portable'),
  };
}

export function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}
