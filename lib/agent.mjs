// The host agent of one environment: `node lib/agent.mjs <id>`, started detached by
// environment.mjs (ensureAgent). It lives as long as the environment's sandbox runs and:
//   - keeps the sandbox's port forwards in line with what its containers publish (ports.mjs)
//   - serves the environment's page on 127.0.0.1 at a sticky port (api.mjs, ui/)
// It writes agent.json (pid, port, URL) to the environment's state folder and removes it on exit.
//
// Each tick asks sbx once (`sbx ls`) and keeps what it learned in `state`, which the page's status
// call reads, so open tabs don't add sbx calls of their own.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadEnv, loadGlobal, updateEnv, writeJson } from './config.mjs';
import { agentDir, agentToken, alive, applyOffline, createContext, readAgent } from './environment.mjs';
import { createApi } from './api.mjs';
import { syncPorts } from './ports.mjs';

const INTERVAL = Number(process.env.PORTABLE_AGENT_INTERVAL_MS) || 5000;
// The sandbox has to be seen stopped (or gone) this many ticks in a row before the agent leaves.
// A tick where sbx didn't answer at all doesn't count: the daemon may be restarting.
const STOPPED_CHECKS = 2;

const id = process.argv[2];
const ctx = createContext();
const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

function fail(message) {
  log(message);
  process.exit(1);
}

if (!id || !loadEnv(ctx.paths, id)) fail(`no environment '${id}'`);
const other = readAgent(ctx, id);
if (other && other.pid !== process.pid && alive(other.pid)) fail(`an agent is already running for ${id} (pid ${other.pid})`);

const token = agentToken(ctx, id);
const state = {
  // What the last tick learned: the sandbox's `sbx ls` entry (null: none, undefined: sbx didn't
  // answer), the forwards, and the hosts the proxy is holding for a decision.
  sandbox: undefined,
  sbxAnswered: true,
  forwards: [],
  blocked: [],
  events: [],
  event(message) {
    state.events.push({ at: new Date().toISOString(), message });
    if (state.events.length > 200) state.events.shift();
    log(message);
  },
  // One sync at a time; callers during a sync share its result. `sandboxes` is a fresh `sbx ls`
  // when the caller has one.
  running: null,
  sync(sandboxes) {
    state.running ??= (async () => {
      try {
        const env = loadEnv(ctx.paths, id);
        if (!env) return undefined;
        const result = await syncPorts({ sbx: ctx.sbx, runner: ctx.runner, paths: ctx.paths, env, log: state.event, sandboxes });
        if (result) state.forwards = result.forwards;
        return result?.forwards;
      } catch (error) {
        state.event(`port sync failed: ${error.message}`);
        return undefined;
      } finally {
        state.running = null;
      }
    })();
    return state.running;
  },
  // Re-reads the blocked hosts now (after the page answered one).
  async refreshBlocked() {
    const env = loadEnv(ctx.paths, id);
    if (env) state.blocked = await ctx.sbx.approvals(env.sandbox);
    return state.blocked;
  },
};

let port;
const server = http.createServer(createApi({ ctx, id, token, getPort: () => port, state }));

function listen(wanted) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

// The page's port sticks too: the saved one if it's free, else any free one, which is then saved.
const saved = loadEnv(ctx.paths, id).uiPort;
try {
  port = await listen(saved ?? 0);
} catch {
  port = await listen(0);
}
if (port !== saved) updateEnv(ctx.paths, id, (e) => { e.uiPort = port; });

const infoFile = path.join(agentDir(ctx, id), 'agent.json');
const url = `http://127.0.0.1:${port}/?t=${token}`;
writeJson(infoFile, { pid: process.pid, port, url, startedAt: new Date().toISOString() }, 0o600);
state.event(`page at http://127.0.0.1:${port}/`);

// The page's address, without its token, in /etc/portable/page for the sandbox's /ui skill. A browser
// that opened the page once (portable opens it when it creates the sandbox) remembers the token, so
// the plain link works there; the sandbox never sees the token.
ctx.sbx.exec(loadEnv(ctx.paths, id).sandbox, ['sh', '-c', 'mkdir -p /etc/portable && cat > /etc/portable/page && chmod 644 /etc/portable/page'], {
  input: `http://127.0.0.1:${port}/\n`,
  user: 'root',
}).then((result) => { if (result.code !== 0) log("couldn't write the page's address into the sandbox"); }, (error) => log(`couldn't write the page's address into the sandbox: ${error.message}`));

function shutdown(reason) {
  state.event(`stopping: ${reason}`);
  try {
    if (readAgent(ctx, id)?.pid === process.pid) fs.rmSync(infoFile);
  } catch {
    // Already gone.
  }
  server.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('asked to stop'));
process.on('SIGINT', () => shutdown('interrupted'));

let stopped = 0;
let offlineProblems = '';
async function tick() {
  try {
    // config.json can change under a running page (another environment's page, or an edit).
    ctx.global = loadGlobal(ctx.paths);
    const env = loadEnv(ctx.paths, id);
    if (!env) return shutdown('environment removed');
    const sandboxes = await ctx.sbx.list();
    if (sandboxes === undefined) {
      // Don't tear anything down on a hiccup; say so once until it answers again.
      if (state.sbxAnswered) state.event("sbx didn't answer (sbx ls); keeping the page up and trying again");
      state.sbxAnswered = false;
    } else {
      if (!state.sbxAnswered) state.event('sbx answers again');
      state.sbxAnswered = true;
      state.sandbox = sandboxes.find((s) => s.name === env.sandbox) ?? null;
      if (state.sandbox?.status !== 'running') {
        if (++stopped >= STOPPED_CHECKS) return shutdown(`sandbox is ${state.sandbox?.status ?? 'gone'}`);
      } else {
        stopped = 0;
        await state.sync(sandboxes);
        state.blocked = await ctx.sbx.approvals(env.sandbox);
        // Hosts allowed from elsewhere meanwhile (config.json, a kit refresh) are denied too.
        // Said once until it changes, not every tick.
        const problems = (await applyOffline(ctx, env)).join('; ');
        if (problems && problems !== offlineProblems) state.event(problems);
        offlineProblems = problems;
      }
    }
  } catch (error) {
    // A broken settings file, or anything else unexpected: log it and keep going rather than die
    // with nothing in agent.log.
    state.event(`tick failed: ${error.message}`);
  }
  setTimeout(tick, INTERVAL);
}
tick();
