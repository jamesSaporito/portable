// `portable doctor`: checks the setup on this computer, then runs kit/files/portable-doctor in a
// throwaway sandbox and checks that port forwarding and the environment page work. Prints one line
// per check; returns non-zero if any failed.
import fs from 'node:fs';
import path from 'node:path';
import { deleteEnv, listEnvs, saveEnv } from './config.mjs';
import { KIT, ROOT, agentDir, agentToken, createSandbox, ensureAgent, refreshAws, applyDomains, settingsFor, stopAgent } from './environment.mjs';
import { UserError, sessionFolder, workspaceFolder } from './env.mjs';
import { SBX_MIN, versionAtLeast } from './sbx.mjs';
import { SECRETS } from './secrets.mjs';

// The Node line install.sh installs for portable (NODE_MAJOR there).
const NODE_MAJOR = '26';
import { syncPorts } from './ports.mjs';

export async function runDoctor(ctx, { sandbox = true } = {}, write = (line) => process.stdout.write(`${line}\n`)) {
  let failed = false;
  const ok = (m) => write(`  ok    ${m}`);
  const warn = (m) => write(`  warn  ${m}`);
  const skip = (m) => write(`  skip  ${m}`);
  const fail = (m) => { write(`  FAIL  ${m}`); failed = true; };
  const { runner, sbx } = ctx;

  write('This computer');
  // Without these no sandbox can start, so the doctor stops at the first one that fails.
  const version = await sbx.version();
  if (!version) {
    fail("Docker Sandboxes (sbx) isn't installed; run install.sh");
    return 1;
  }
  if (!versionAtLeast(version, SBX_MIN)) {
    fail(`sbx ${version} is too old; portable needs ${SBX_MIN} or later`);
    return 1;
  }
  ok(`Docker Sandboxes (sbx ${version}) is installed`);
  if ((await runner.run('sbx', ['ls'])).code !== 0) {
    fail("sbx isn't signed in to Docker; run: sbx login");
    return 1;
  }
  ok('sbx is signed in');
  if (fs.existsSync(ctx.paths.configFile)) ok(`settings file ${ctx.paths.configFile} found`);
  else warn(`no settings file ${ctx.paths.configFile}, so defaults are used (run install.sh to create it)`);
  let ws;
  try {
    ws = workspaceFolder(ctx.global.workspaceDir, ctx.paths.home, ctx.folders);
    fs.mkdirSync(ws, { recursive: true });
    ok(`workspace folder is ${ws}`);
  } catch (error) {
    fail(error.message);
    return 1;
  }

  const nodeDir = path.join(ctx.paths.home, '.local', 'share', 'portable-node');
  const ownNode = process.execPath.startsWith(`${process.env.PORTABLE_NODE_DIR || nodeDir}/`);
  if (ownNode && process.versions.node.startsWith(`${NODE_MAJOR}.`)) ok(`running on portable's own Node ${process.version}`);
  else if (ownNode) warn(`portable's own Node is ${process.version}, not ${NODE_MAJOR}.x; run install.sh again`);
  else warn(`running on Node ${process.version} from ${process.execPath}, not portable's own Node ${NODE_MAJOR}; run install.sh to install it (fine for a clone you're testing)`);
  if ((await runner.run('sh', ['-c', 'command -v portable'])).code === 0) ok('portable is on your PATH');
  else warn("portable isn't on your PATH; run install.sh and open a new terminal");
  const installed = (() => {
    try {
      return fs.realpathSync(ctx.paths.installDir);
    } catch {
      return undefined;
    }
  })();
  if (ROOT !== installed) {
    warn(`running the working copy in ${ROOT}, not the installed one; fine for testing changes`);
  } else if ((await runner.run('git', ['-C', ROOT, '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=10', 'fetch', '--quiet'])).code !== 0) {
    warn("couldn't check GitHub for portable updates (offline?)");
  } else {
    const behind = Number((await runner.run('git', ['-C', ROOT, 'rev-list', '--count', 'HEAD..@{u}'])).stdout.trim());
    if (behind > 0) warn(`portable is ${behind} commit(s) behind GitHub; run 'portable update'`);
    else ok(`portable is installed in ${ROOT} and up to date`);
  }
  if (fs.existsSync(path.join(KIT, 'portable.yaml')) && fs.existsSync(path.join(KIT, 'portable.dockerfile'))) ok(`portable's kit is in place (${KIT})`);
  else fail(`portable's kit is missing from ${KIT}`);

  const bound = await sbx.secrets();
  for (const [name, info] of Object.entries(SECRETS)) {
    const stored = await ctx.secrets.has(name);
    const registered = bound.some((s) => s.name === info.service);
    if (stored && registered) ok(`${info.label} is stored (${ctx.secrets.backend}) and sbx reads it`);
    else if (!stored && !info.required) warn(`no ${info.label} stored, so ${info.service} won't work in sandboxes; run: portable configure`);
    else if (!stored) fail(`no ${info.label} stored; run: portable configure`);
    else fail(`sbx has no '${info.service}' secret source; run: portable configure`);
  }
  const name = (await runner.run('git', ['config', '--global', 'user.name'])).stdout.trim();
  const email = (await runner.run('git', ['config', '--global', 'user.email'])).stdout.trim();
  if (name && email) ok('git identity found in your git config (used for commits in the sandbox)');
  else warn('no user.name/user.email in your git config; commits in the sandbox will have none');

  // AWS is per environment; check the profiles environments have turned on.
  const awsEnvs = listEnvs(ctx.paths).filter((e) => e.overrides?.awsProfile);
  if (!awsEnvs.length) {
    skip('AWS: no environment has it turned on (each page has an AWS section)');
  } else if ((await runner.run('aws', ['--version'])).code === 127) {
    fail(`AWS: ${awsEnvs.map((e) => e.id).join(', ')} use it, but the aws CLI isn't installed (brew install awscli)`);
  } else {
    const profiles = (await runner.run('aws', ['configure', 'list-profiles'])).stdout.split('\n');
    for (const e of awsEnvs) {
      const profile = e.overrides.awsProfile;
      if (!profiles.includes(profile)) fail(`AWS: ${e.id} uses profile '${profile}', which isn't on this Mac`);
      else if ((await runner.run('aws', ['configure', 'export-credentials', '--profile', profile])).code === 0) ok(`AWS: ${e.id} uses profile '${profile}', signed in`);
      else warn(`AWS: ${e.id} uses profile '${profile}', signed out; sign in on its page or run: aws sso login --profile ${profile}`);
    }
  }

  write('');
  if (sandbox) {
    if (!(await doctorSandbox(ctx, ws, { ok, fail, write }))) failed = true;
  } else {
    skip('sandbox checks (--no-sandbox); run portable doctor without it to create a test sandbox');
  }
  write('');
  write(failed ? 'Some checks failed; see FAIL above.' : 'All checks passed.');
  return failed ? 1 : 0;
}

// A fresh sandbox with its own environment, so the checks see exactly what a normal start gives,
// removed afterwards.
async function doctorSandbox(ctx, ws, { ok, fail, write }) {
  let folder;
  try {
    folder = sessionFolder(process.cwd(), ws, ctx.folders);
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    folder = ws;
  }
  const id = `doctor-${Math.random().toString(16).slice(2, 6)}`;
  const env = { id, path: folder, named: true, sandbox: `portable-${id}`, overrides: {}, ports: {} };
  saveEnv(ctx.paths, env);
  const cleanup = async () => {
    stopAgent(ctx, id);
    await ctx.sbx.remove(env.sandbox, { force: true });
    deleteEnv(ctx.paths, id);
    fs.rmSync(agentDir(ctx, id), { recursive: true, force: true });
  };
  // Ctrl-C (or a kill) mid-run still removes the test sandbox and its settings.
  const onSignal = async () => {
    write('\nportable: interrupted; removing the test sandbox...');
    await cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const settings = settingsFor(ctx, env);
    if (!(await createSandbox(ctx, env, settings, ws))) {
      fail("couldn't create a test sandbox (see sbx's output above)");
      return false;
    }
    await ctx.sbx.wake(env.sandbox);
    for (const problem of [...await applyDomains(ctx, env, settings), ...await refreshAws(ctx, env, settings)]) {
      fail(problem);
    }
    let passed = (await ctx.runner.runInteractive('sbx', ['exec', env.sandbox, 'portable-doctor'])) === 0;
    write('');
    write('Ports and the environment page');
    if (!(await doctorForwarding(ctx, env, { ok, fail }))) passed = false;
    if (!(await doctorPage(ctx, env, { ok, fail }))) passed = false;
    return passed;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

// A container in the sandbox publishes a port; it should come out on this computer.
async function doctorForwarding(ctx, env, { ok, fail }) {
  const server = 'while true; do printf "HTTP/1.0 200 OK\\r\\n\\r\\nportable" | nc -l -p 8080; done';
  const started = await ctx.sbx.exec(env.sandbox, ['docker', 'run', '-d', '-p', '18080:8080', 'alpine:3', 'sh', '-c', server], { timeout: 180000 });
  const container = started.stdout.trim();
  if (started.code !== 0 || !container) {
    fail(`couldn't start a test container in the sandbox: ${started.stderr.trim()}`);
    return false;
  }
  const sync = () => syncPorts({ sbx: ctx.sbx, runner: ctx.runner, paths: ctx.paths, env, log: () => {} });
  const host = (await sync())?.forwards.find((f) => f.sandbox === 18080)?.host;
  let reply = '';
  if (host) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    reply = await fetch(`http://localhost:${host}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text(), () => '');
  }
  await ctx.sbx.exec(env.sandbox, ['docker', 'rm', '-f', container]);
  const closed = !(await sync())?.forwards.some((f) => f.sandbox === 18080);
  if (reply.trim() === 'portable' && closed) {
    ok(`a port published by a test container was reachable at http://localhost:${host}, and was closed again`);
    return true;
  }
  if (!host) fail("a port published by a test container wasn't forwarded (portable ports)");
  else if (reply.trim() !== 'portable') fail(`port 18080 of a test container was forwarded to ${host} but didn't answer there`);
  else fail(`the forward to ${host} stayed after the container was removed`);
  return false;
}

// The page answers with the token and refuses without it.
async function doctorPage(ctx, env, { ok, fail }) {
  const agent = await ensureAgent(ctx, env);
  if (!agent) {
    fail(`the environment page didn't start; see ${agentDir(ctx, env.id)}/agent.log`);
    return false;
  }
  const status = (headers) => fetch(`http://127.0.0.1:${agent.port}/api/status`, { headers, signal: AbortSignal.timeout(10000) }).then((r) => r.status, () => 0);
  const withToken = await status({ 'x-portable-token': agentToken(ctx, env.id) });
  const without = await status({});
  if (withToken === 200 && without === 401) {
    ok(`the environment page answered at http://127.0.0.1:${agent.port}/ and refused a request without its token`);
    return true;
  }
  fail(`the environment page answered ${withToken} with its token and ${without} without (expected 200 and 401)`);
  return false;
}
