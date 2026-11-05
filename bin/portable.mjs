#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadEnv, listEnvs, saveEnv, updateEnv } from '../lib/config.mjs';
import {
  ROOT, agentSync, alive, applyClaudeConfig, applyClaudeRepo, applyDomains, createContext, createSandbox, ensureAgent,
  kitOutdated, readAgent, refreshAws, refreshKit, settingsFor, stopAgent,
} from '../lib/environment.mjs';
import { PREFIX, UserError, envByName, resolveEnv, sessionFolder, workspaceFolder } from '../lib/env.mjs';
import { portsTable, syncPorts } from '../lib/ports.mjs';
import { tcpForwards } from '../lib/sbx.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { configure } from '../lib/configure.mjs';
import { updatePortable } from '../lib/update.mjs';

const USAGE = `Runs a command in the sandbox for the current folder, or a shell when given none.
  portable [--name NAME] [command]    -> bash (or the command) in the folder's sandbox
  portable claude [args]               -> Claude Code in the sandbox
  portable ui [NAME]                   -> open the environment's page (ports, services, settings)
  portable ps                          -> list portable's sandboxes
  portable ports [NAME]                -> sync and list the ports forwarded to this computer
  portable stop NAME                   -> stop one (keeps its data)
  portable rm NAME                     -> delete one, with its Docker data and Claude history
  portable prune                       -> delete every stopped one
  portable doctor                      -> check the setup, on this computer and in a sandbox
  portable update                      -> update the installed copy from GitHub
  portable configure                   -> store the secrets portable needs, prompting for each
  portable -v                          -> show portable's version and the commit it runs from
  portable secret set|rm NAME          -> store or remove one secret (GH_TOKEN)
  portable doctor --no-sandbox         -> the checks on this computer only`;

const say = (message) => process.stderr.write(`portable: ${message}\n`);
const out = (text) => process.stdout.write(`${text}\n`);

function usage(text) {
  throw new UserError(`usage: ${text}`);
}

// The workspace folder, checked and created, or null when workspaceDir isn't set.
function workspace(ctx) {
  const ws = workspaceFolder(ctx.global.workspaceDir, ctx.paths.home, ctx.folders);
  if (ws) fs.mkdirSync(ws, { recursive: true });
  return ws;
}

// The environment for the current folder (or --name), saved on first use.
async function currentEnv(ctx, name) {
  const ws = workspace(ctx);
  const folder = sessionFolder(process.cwd(), ws, ctx.folders, ctx.paths.home);
  const sandboxes = await ctx.sbx.list();
  if (!sandboxes) throw new UserError("sbx didn't answer (sbx ls failed); is its daemon running? Try: sbx ls");
  const env = resolveEnv({ paths: ctx.paths, folder, name, sandboxes });
  if (!loadEnv(ctx.paths, env.id)) saveEnv(ctx.paths, env);
  return { env: loadEnv(ctx.paths, env.id), ws };
}

// Gets the environment's sandbox running with its settings applied and its page up. With
// `openPage`, a sandbox it creates also gets its page opened in the browser, which keeps the token,
// so the plain link /ui gives in the session works there afterwards.
async function prepare(ctx, env, ws, { openPage = false } = {}) {
  const settings = settingsFor(ctx, env);
  const existing = await ctx.sbx.get(env.sandbox);
  if (!existing) {
    if (!(await createSandbox(ctx, env, settings, ws))) throw new UserError(`couldn't create the sandbox ${env.sandbox}`);
  }
  if (!(await ctx.sbx.wake(env.sandbox))) throw new UserError(`the sandbox ${env.sandbox} isn't there anymore, or sbx didn't answer; try again`);
  env = loadEnv(ctx.paths, env.id);

  const problems = [];
  // portable's kit changed since the sandbox was made (`portable update`): offer to apply it in place.
  if (existing && kitOutdated(env)) {
    if (await confirm(`portable's kit changed since ${env.id}'s sandbox was made. Update the sandbox now? Its Docker data and Claude history are kept; sessions running in it end`)) {
      const result = await refreshKit(ctx, env);
      if (result === undefined) say(`couldn't update the sandbox ${env.sandbox}; it keeps its current kit`);
      else problems.push(...result);
      env = loadEnv(ctx.paths, env.id);
    } else {
      say(`${env.id} keeps its current kit; you'll be asked again next time`);
    }
  }

  problems.push(...await applyDomains(ctx, env, settings));
  // AWS only when this environment turned it on; an expired session is reported, not signed in
  // here (the page's Sign in button does that, as does `aws sso login`).
  problems.push(...await refreshAws(ctx, env, settings));
  // The configuration repo is set at creation; switch to it when another environment's page changed it.
  if (existing && env.appliedRepo !== undefined && env.appliedRepo !== settings.claudeConfigRepo) {
    say(`switching ${env.id} to the configuration repo ${settings.claudeConfigRepo || '(none)'}...`);
    problems.push(...await applyClaudeRepo(ctx, env, settings));
  } else if (env.appliedRepo === undefined) {
    env = updateEnv(ctx.paths, env.id, (stored) => { stored.appliedRepo = settings.claudeConfigRepo; });
  }
  // The skills and rules to leave off are set at creation; push them again only when they changed.
  const disable = settings.claudeConfigDisable.join(' ');
  if (existing && env.appliedDisable !== undefined && env.appliedDisable !== disable) {
    problems.push(...await applyClaudeConfig(ctx, env, settings));
  }
  if (env.appliedDisable !== disable) {
    // Through updateEnv, so a sticky port the agent saves meanwhile isn't lost.
    env = updateEnv(ctx.paths, env.id, (stored) => { stored.appliedDisable = disable; });
  }
  for (const problem of problems) say(`${problem}; continuing`);

  const agent = await ensureAgent(ctx, env);
  if (agent) say(`page: ${agent.url} (type /ui in Claude for the link)`);
  else say(`couldn't start the page; see ${ctx.paths.state}/${env.id}/agent.log`);
  if (agent && openPage && !existing) await ctx.runner.run('open', [agent.url]);
  return env;
}

// "portable 3.0.0 (abc1234)": package.json's version and the git commit this copy is at, marked
// when it has changes of its own (a clone being worked on). No commit outside a git checkout.
export function versionLine(version, commit, dirty) {
  if (!commit) return `portable ${version}`;
  return `portable ${version} (${commit}${dirty ? ', with local changes' : ''})`;
}

async function showVersion(ctx) {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const head = await ctx.runner.run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']);
  const commit = head.code === 0 ? head.stdout.trim() : '';
  const dirty = commit && (await ctx.runner.run('git', ['-C', ROOT, 'status', '--porcelain'])).stdout.trim() !== '';
  out(versionLine(version, commit, dirty));
}

// Claude asks before acting unless a permission flag is passed, since a sandbox limits what Claude
// can reach, not what it spends. `sbx run` would start Docker's workload defaults, which include
// --dangerously-skip-permissions, and flags passed to it are added after those, so bypass would
// still win (https://docs.docker.com/ai/sandboxes/agents/claude-code/). portable starts Claude
// with `sbx exec` and exactly these flags instead.
export function claudeArgs(args) {
  const chosen = args.some((a) => a === '--permission-mode' || a.startsWith('--permission-mode=') || a === '--dangerously-skip-permissions');
  return chosen ? args : ['--permission-mode', 'default', ...args];
}

async function runIn(ctx, name, command) {
  await ctx.sbx.ensure();
  const { env: found, ws } = await currentEnv(ctx, name);
  const env = await prepare(ctx, found, ws, { openPage: true });
  const tty = process.stdin.isTTY ? ['-it'] : ['-i'];
  if (command.length === 0) {
    return ctx.runner.runInteractive('sbx', ['exec', ...tty, env.sandbox, 'bash']);
  }
  if (command[0] === 'claude') {
    return ctx.runner.runInteractive('sbx', ['exec', ...tty, '-w', env.path, env.sandbox, 'claude', ...claudeArgs(command.slice(1))]);
  }
  // A one-off command, e.g. `portable docker compose up -d`: forward what it started right away.
  const before = await ctx.sbx.forwards(env.sandbox);
  const code = await ctx.runner.runInteractive('sbx', ['exec', ...tty, env.sandbox, ...command]);
  const after = await agentSync(ctx, env.id);
  if (after && JSON.stringify(after) !== JSON.stringify(before)) process.stderr.write(`${portsTable(after)}\n`);
  return code;
}

async function ps(ctx) {
  const sandboxes = await ctx.sbx.ours();
  if (!sandboxes) throw new UserError("sbx didn't answer (sbx ls failed); is its daemon running?");
  const envs = listEnvs(ctx.paths);
  const rows = [['NAME', 'STATUS', 'PORTS (SANDBOX→HOST)', 'PAGE', 'FOLDER']];
  for (const s of sandboxes) {
    const env = envs.find((e) => e.sandbox === s.name);
    const agent = env && readAgent(ctx, env.id);
    const ports = tcpForwards(s.ports).map((f) => `${f.sandbox}→${f.host}`).join(' ') || '-';
    rows.push([s.name.slice(PREFIX.length), s.status, ports, agent && alive(agent.pid) ? `http://127.0.0.1:${agent.port}/` : '-', s.workspaces?.[0] ?? '-']);
  }
  if (rows.length === 1) return out('No sandboxes yet; run portable in a project folder.');
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const row of rows) out(row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  '));
}

// The environment a NAME refers to, or the current folder's when there's none.
async function namedOrCurrent(ctx, name) {
  if (name) {
    const env = envByName(ctx.paths, name);
    if (!env) throw new UserError(`no environment named '${name}'; see 'portable ps'`);
    return env;
  }
  return (await currentEnv(ctx)).env;
}

async function ports(ctx, name) {
  await ctx.sbx.ensure();
  let envs;
  if (name) {
    envs = [await namedOrCurrent(ctx, name)];
  } else {
    try {
      envs = [(await currentEnv(ctx)).env];
    } catch {
      // Outside the workspace: every running one.
      const running = new Set((await ctx.sbx.ours() ?? []).filter((s) => s.status === 'running').map((s) => s.name));
      envs = listEnvs(ctx.paths).filter((e) => running.has(e.sandbox));
      if (!envs.length) return out("No running sandboxes; see 'portable ps'.");
    }
  }
  for (const env of envs) {
    const sandbox = await ctx.sbx.get(env.sandbox);
    if (sandbox?.status !== 'running') {
      say(`${env.id} is ${sandbox ? 'stopped' : 'not created yet'}; its forwards come back when it starts (run 'portable' in ${env.path})`);
      continue;
    }
    if (envs.length > 1) out(`${env.id}:`);
    // The agent does the syncing (one process per sandbox, so two never allocate the same port);
    // start it if it isn't running. Only when it can't start, sync from here.
    const agent = await ensureAgent(ctx, env);
    if (!agent) say(`couldn't start the page and port forwarder; see ${ctx.paths.state}/${env.id}/agent.log`);
    const forwards = (agent && await agentSync(ctx, env.id))
      ?? (await syncPorts({ sbx: ctx.sbx, runner: ctx.runner, paths: ctx.paths, env, log: say }))?.forwards
      ?? [];
    out(portsTable(forwards));
  }
}

// Brings the environment up like `portable` does (creating the sandbox if needed), without a shell
// or Claude, and opens its page.
async function ui(ctx, name) {
  await ctx.sbx.ensure();
  const found = await namedOrCurrent(ctx, name);
  const env = await prepare(ctx, found, workspace(ctx));
  const agent = readAgent(ctx, env.id);
  if (!agent) throw new UserError(`couldn't start the page; see ${ctx.paths.state}/${env.id}/agent.log`);
  out(agent.url);
  await ctx.runner.run('open', [agent.url]);
}

// Every yes/no question portable asks looks the same and defaults to no, like install.sh's.
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  // Closed after each answer, so a prompt that follows (e.g. the Keychain's) gets the terminal.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim();
  rl.close();
  return /^y/i.test(answer);
}

async function stopOrRemove(ctx, command, name) {
  if (!name) usage(`portable ${command} NAME`);
  await ctx.sbx.ensure();
  const env = envByName(ctx.paths, name);
  const sandbox = env?.sandbox ?? PREFIX + name;
  if (!(await ctx.sbx.get(sandbox))) throw new UserError(`no sandbox named '${name}'; see 'portable ps'`);
  if (command === 'stop') {
    await ctx.sbx.stop(sandbox);
    if (env) stopAgent(ctx, env.id);
    return out(`Stopped ${name}`);
  }
  // sbx asks for confirmation. The environment's settings and sticky ports stay, so a recreate
  // (e.g. for new CPU or memory settings) keeps them.
  const code = await ctx.sbx.remove(sandbox);
  if (code === 0 && !(await ctx.sbx.get(sandbox)) && env) {
    stopAgent(ctx, env.id);
    updateEnv(ctx.paths, env.id, (stored) => {
      delete stored.createdWith;
      delete stored.appliedDisable;
      delete stored.kit;
    });
    out(`Its settings and ports are kept for the next 'portable' in ${env.path}.`);
  }
  return code;
}

async function prune(ctx) {
  await ctx.sbx.ensure();
  const sandboxes = await ctx.sbx.ours();
  if (!sandboxes) throw new UserError("sbx didn't answer (sbx ls failed); is its daemon running?");
  const stopped = sandboxes.filter((s) => s.status !== 'running');
  if (!stopped.length) return out('No stopped sandboxes.');
  out('Stopped sandboxes (their Docker data and Claude history go with them; workspace files stay):');
  for (const s of stopped) out(`  ${s.name.slice(PREFIX.length)}`);
  if (!(await confirm('Delete them?'))) return out('Left them in place.');
  for (const s of stopped) {
    if ((await ctx.sbx.remove(s.name, { force: true })).code === 0) out(`Deleted ${s.name.slice(PREFIX.length)}`);
  }
}

async function secret(ctx, action, name) {
  if (!['set', 'rm'].includes(action) || !name) usage('portable secret set|rm NAME');
  const code = action === 'set' ? await ctx.secrets.set(name) : await ctx.secrets.remove(name);
  if (code === 0 && action === 'set') out(`Stored ${name}. Sandboxes bind it when they're created; 'portable rm' the ones that should use it.`);
  return code;
}

async function main(argv) {
  const ctx = createContext();
  const [command, ...rest] = argv;
  switch (command) {
    case 'secret': return secret(ctx, rest[0], rest[1]);
    case 'configure':
      return configure({ secrets: ctx.secrets, sbx: ctx.sbx, ask: confirm, write: out, interactive: Boolean(process.stdin.isTTY) });
    case 'ps': await ctx.sbx.ensure(); return ps(ctx);
    case 'ports': return ports(ctx, rest[0]);
    case 'ui': return ui(ctx, rest[0]);
    case 'stop':
    case 'rm': return stopOrRemove(ctx, command, rest[0]);
    case 'prune': return prune(ctx);
    case 'doctor': return runDoctor(ctx, { sandbox: !rest.includes('--no-sandbox') });
    case 'update': return updatePortable(ctx.runner, ctx.paths.installDir);
    case '-v':
    case '--version':
    case 'version':
      return showVersion(ctx);
    case '--help':
    case '-h':
    case 'help':
      return out(USAGE);
    case '--name':
      if (!rest[0]) usage('portable --name NAME [command]');
      return runIn(ctx, rest[0], rest.slice(1));
    default:
      return runIn(ctx, undefined, argv);
  }
}

if (import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const code = await main(process.argv.slice(2));
    process.exitCode = typeof code === 'number' ? code : 0;
  } catch (error) {
    if (error instanceof UserError) {
      say(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
