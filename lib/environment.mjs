// What the CLI and the host agent both do to an environment: create its sandbox, apply its
// settings, start its host agent.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveSettings, loadGlobal, updateEnv } from './config.mjs';
import { portablePaths } from './paths.mjs';
import { protectedFolders } from './env.mjs';
import { defaultRunner } from './run.mjs';
import { createSbx } from './sbx.mjs';
import { createSecrets } from './secrets.mjs';
import { awsCredentials, pushAws } from './aws.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KIT = path.join(ROOT, 'kit');
const AGENT = path.join(ROOT, 'lib', 'agent.mjs');

// Everything a command needs, built once. Tests pass their own runner and environment variables.
export function createContext({ runner = defaultRunner, env = process.env } = {}) {
  const paths = portablePaths(env);
  return {
    runner,
    paths,
    global: loadGlobal(paths, env),
    folders: protectedFolders(paths.home, ROOT),
    sbx: createSbx(runner),
    secrets: createSecrets(runner),
  };
}

export function settingsFor(ctx, env) {
  return effectiveSettings(ctx.global, env);
}

// Environment variables a sandbox is created with. No secrets: those stay with sbx's proxy, and
// AWS credentials go in through stdin (refreshAws).
export function sandboxEnv(env, settings, workspace) {
  return {
    WORKSPACE_DIR: env.path,
    PORTABLE_WORKSPACE_ROOT: workspace ?? '',
    PORTABLE_ENV: env.id,
    PORTABLE_CLAUDE_CONFIG_REPO: settings.claudeConfigRepo,
    PORTABLE_CLAUDE_CONFIG_DISABLE: settings.claudeConfigDisable.join(' '),
    TERM: process.env.TERM,
    COLORTERM: process.env.COLORTERM,
  };
}

// Creates the sandbox: Docker's Claude workload plus portable's kit, the folder mounted at its
// host path, sized from the settings (fixed from then on, so recorded in `createdWith`).
export async function createSandbox(ctx, env, settings, workspace) {
  process.stderr.write(`portable: creating the sandbox ${env.sandbox} for ${env.path} (the first one builds portable's kit; a few minutes)...\n`);
  const code = await ctx.sbx.create(env.sandbox, env.path, {
    env: sandboxEnv(env, settings, workspace),
    kit: KIT,
    cpus: settings.cpus,
    memory: settings.memory,
  });
  if (code !== 0) return false;
  updateEnv(ctx.paths, env.id, (stored) => {
    stored.createdWith = { cpus: settings.cpus, memory: settings.memory };
    stored.appliedRepo = settings.claudeConfigRepo;
  });
  return true;
}

// Makes the sandbox's own network allow list match the settings (sbx policy, scoped to it), on
// top of the kit's list. Returns messages for what failed.
export async function applyDomains(ctx, env, settings) {
  const problems = [];
  const current = new Set(await ctx.sbx.sandboxDomains(env.sandbox));
  const wanted = new Set(settings.allowDomains);
  for (const host of wanted) {
    if (!current.has(host) && !(await ctx.sbx.allowDomain(env.sandbox, host))) {
      problems.push(`couldn't allow ${host} (sbx policy allow network --sandbox ${env.sandbox} ${host})`);
    }
  }
  for (const host of current) {
    if (!wanted.has(host) && !(await ctx.sbx.removeDomain(env.sandbox, host))) {
      problems.push(`couldn't remove ${host} from the allow list`);
    }
  }
  return problems;
}

// Tells the sandbox which skills and rules to leave off and relinks the config repo. The list is
// kept in the sandbox (/etc/portable/claude-config-disable), so later boots keep it.
export async function applyClaudeConfig(ctx, env, settings) {
  const result = await ctx.sbx.exec(env.sandbox, [
    'env', `PORTABLE_CLAUDE_CONFIG_REPO=${settings.claudeConfigRepo}`, 'portable-setup', 'config',
  ], { input: `${settings.claudeConfigDisable.join('\n')}\n`, user: 'root', timeout: 120000 });
  return result.code === 0 ? [] : [`couldn't update the Claude configuration in ${env.id}: ${result.stderr.trim()}`];
}

// Points the sandbox at the configuration repo in the settings: re-cloned and relinked when it
// changed, removed when it's blank. Recorded in the sandbox, so later boots keep it, and in the
// environment (appliedRepo), so `portable` knows when another environment's page changed it.
export async function applyClaudeRepo(ctx, env, settings) {
  const result = await ctx.sbx.exec(env.sandbox, ['portable-setup', 'repo'], {
    input: `${settings.claudeConfigRepo}\n`, user: 'root', timeout: 180000,
  });
  if (result.code !== 0) {
    const why = result.stderr.trim() || result.stdout.trim();
    return [/usage: portable-setup/.test(why)
      ? `the sandbox ${env.sandbox} predates changing the configuration repo; run portable rm ${env.id} and start it again`
      : `couldn't switch ${env.id} to the configuration repo: ${why}`];
  }
  updateEnv(ctx.paths, env.id, (stored) => { stored.appliedRepo = settings.claudeConfigRepo; });
  return [];
}

// Writes fresh STS credentials for the environment's AWS profile into the sandbox, or clears them.
export async function refreshAws(ctx, env, settings, { interactive = false } = {}) {
  const problems = [];
  const creds = await awsCredentials(ctx.runner, settings.awsProfile, { interactive, log: (m) => problems.push(m) });
  if (!(await pushAws(ctx.sbx, env.sandbox, creds))) problems.push("couldn't pass AWS credentials to the sandbox");
  return problems;
}

// --- host agent ------------------------------------------------------------------------------------

export function agentDir(ctx, id) {
  return path.join(ctx.paths.state, id);
}

export function readAgent(ctx, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentDir(ctx, id), 'agent.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The environment's page token: random, kept with the agent's state (0600) so a bookmarked URL
// keeps working across restarts.
export function agentToken(ctx, id) {
  const file = path.join(agentDir(ctx, id), 'token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const token = crypto.randomUUID().replaceAll('-', '');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

async function healthy(info) {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).pid === info.pid;
  } catch {
    return false;
  }
}

// Starts the environment's host agent (page + port forwarding) unless it's already running, and
// returns its details ({pid, port, url}). It runs detached and stops itself with the sandbox.
export async function ensureAgent(ctx, env) {
  const running = readAgent(ctx, env.id);
  if (running && alive(running.pid) && (await healthy(running))) return running;

  const dir = agentDir(ctx, env.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(dir, 'agent.log'), 'a');
  const child = spawn(process.execPath, [AGENT, env.id], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  fs.closeSync(log);

  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const info = readAgent(ctx, env.id);
    if (info?.pid === child.pid) return info;
    if (child.exitCode !== null) break;
  }
  return undefined;
}

export function stopAgent(ctx, id) {
  const info = readAgent(ctx, id);
  if (info && alive(info.pid)) {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

// Asks a running agent to sync ports now (after a one-off command) and returns the forwards.
export async function agentSync(ctx, id) {
  const info = readAgent(ctx, id);
  if (!info) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/ports/sync`, {
      method: 'POST',
      headers: { 'x-portable-token': agentToken(ctx, id) },
      signal: AbortSignal.timeout(60000),
    });
    return response.ok ? (await response.json()).forwards : undefined;
  } catch {
    return undefined;
  }
}
