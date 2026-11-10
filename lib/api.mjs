// The environment page's HTTP server: static files from lib/ui and a JSON API under /api.
//
// It listens on 127.0.0.1 only. Every /api request must carry the environment's token (the page
// reads it from its URL), and the Host header must be the page's own, so another site open in the
// browser can't drive it, through DNS rebinding either.
import fs from 'node:fs';
import path from 'node:path';
import { CREATE_ONLY, listEnvs, loadEnv, loadGlobal, saveGlobal, updateEnv, validateOverrides, validateRepo } from './config.mjs';
import { ROOT, applyClaudeConfig, applyClaudeRepo, applyDomains, applyOffline, refreshAws, setOffline, settingsFor } from './environment.mjs';
import { inside } from './env.mjs';
import { secretStatus } from './secrets.mjs';
import { awsStatus } from './aws.mjs';

const UI = path.join(ROOT, 'lib', 'ui');
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/hosts.mjs': 'hosts.mjs', '/style.css': 'style.css' };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'vendor', 'dist', 'build', '.terraform']);
const CONFIG_DIR = '/home/agent/claude-configuration';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Runs a validator; what it throws becomes a 400 for the page.
function badRequest(validate) {
  try {
    return validate();
  } catch (error) {
    throw new HttpError(400, error.message);
  }
}

// Compose files in the environment's folder and the folders below it (two levels), as the host
// sees them; the sandbox mounts the folder at the same path.
export function findComposeFiles(root, depth = 2) {
  const found = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const file = COMPOSE_NAMES.find((name) => entries.some((e) => e.isFile() && e.name === name));
    if (file) found.push(path.join(dir, file));
    if (level >= depth) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), level + 1);
    }
  };
  walk(root, 0);
  return found;
}

// `docker ps -a --format '{{json .}}'` lines → containers with their compose project and service.
export function parseContainers(text) {
  const containers = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      continue;
    }
    const labels = Object.fromEntries(String(c.Labels ?? '').split(',').map((kv) => {
      const eq = kv.indexOf('=');
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    }));
    containers.push({
      id: c.ID,
      name: c.Names,
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports,
      project: labels['com.docker.compose.project'] ?? null,
      service: labels['com.docker.compose.service'] ?? null,
      workingDir: labels['com.docker.compose.project.working_dir'] ?? null,
    });
  }
  return containers;
}

// Output of the claude-configuration probe (see claudeInfo) → its parts.
export function parseClaudeInfo(text) {
  const [head = '', skills = '', rules = ''] = text.split(/^---$/m);
  const [commit, subject, when] = head.trim().split('\t');
  const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    installed: Boolean(commit),
    commit: commit ? { hash: commit, subject, when } : null,
    skills: lines(skills),
    rules: lines(rules),
  };
}

export function createApi({ ctx, id, token, getPort, state }) {
  const env = () => {
    const current = loadEnv(ctx.paths, id);
    if (!current) throw new HttpError(410, 'this environment was removed');
    return current;
  };
  const exec = (command, opts) => ctx.sbx.exec(env().sandbox, command, opts);

  function composeFileFor(e, file) {
    const resolved = path.resolve(file);
    if (!inside(resolved, e.path) || !COMPOSE_NAMES.includes(path.basename(resolved))) {
      throw new HttpError(400, 'not a compose file in this environment');
    }
    return resolved;
  }

  const routes = {
    'GET /api/health': async () => ({ pid: process.pid, id }),

    // Served from what the agent's last tick learned, so a page polling every few seconds costs
    // no sbx calls. 'unknown' means sbx didn't answer that tick.
    'GET /api/status': async () => {
      const e = env();
      const settings = settingsFor(ctx, e);
      const status = !state.sbxAnswered ? 'unknown' : state.sandbox === null ? 'missing' : (state.sandbox?.status ?? 'unknown');
      return {
        id: e.id,
        path: e.path,
        sandbox: e.sandbox,
        status,
        forwards: state.forwards,
        sticky: e.ports,
        settings,
        overrides: e.overrides,
        global: ctx.global,
        createdWith: e.createdWith ?? null,
        recreateNeeded: CREATE_ONLY.filter((k) => e.createdWith && String(e.createdWith[k]) !== String(settings[k])),
        offline: Boolean(e.offline),
        blocked: state.blocked,
        events: state.events.slice(-50),
      };
    },

    // Every host the sandbox may reach, not only this environment's; asked of sbx when the page
    // opens the list, since status polling never calls sbx.
    'GET /api/network': async () => {
      const groups = await ctx.sbx.networkPolicy(env().sandbox);
      if (!groups) throw new HttpError(502, "couldn't read the sandbox's network policy (sbx policy ls)");
      return { groups };
    },

    'POST /api/ports/sync': async () => ({ forwards: (await state.sync()) ?? state.forwards }),

    // { sandboxPort, hostPort }: stick a sandbox port to another host port (null forgets it).
    'PUT /api/ports': async (body) => {
      const sandboxPort = Number(body.sandboxPort);
      const hostPort = body.hostPort === null ? null : Number(body.hostPort);
      if (!Number.isInteger(sandboxPort) || sandboxPort < 1 || sandboxPort > 65535) throw new HttpError(400, 'sandboxPort must be a port number');
      if (hostPort !== null && (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535)) {
        throw new HttpError(400, 'hostPort must be a port number from 1024 to 65535');
      }
      if (hostPort === getPort()) throw new HttpError(409, `${hostPort} is this page's own port`);
      if (hostPort !== null) {
        const e = env();
        const other = Object.entries(e.ports).find(([sp, hp]) => Number(sp) !== sandboxPort && Number(hp) === hostPort);
        if (other) throw new HttpError(409, `${hostPort} is already where this environment's port ${other[0]} sticks`);
        const elsewhere = listEnvs(ctx.paths).find((o) => o.id !== id
          && (Object.values(o.ports ?? {}).some((hp) => Number(hp) === hostPort) || Number(o.uiPort) === hostPort));
        if (elsewhere) throw new HttpError(409, `${hostPort} belongs to the environment '${elsewhere.id}' (${elsewhere.path})`);
      }
      updateEnv(ctx.paths, id, (e) => {
        if (hostPort === null) delete e.ports[sandboxPort];
        else e.ports[sandboxPort] = hostPort;
      });
      const forwards = (await state.sync()) ?? state.forwards;
      const forward = forwards.find((f) => f.sandbox === sandboxPort);
      if (hostPort !== null && forward && forward.host !== hostPort) {
        throw new HttpError(409, `${hostPort} is in use by something else; saved, and the forward moves there once it's free`);
      }
      return { forwards };
    },

    'GET /api/services': async () => {
      const e = env();
      const files = findComposeFiles(e.path);
      const result = await exec(['docker', 'ps', '-a', '--format', '{{json .}}'], { timeout: 20000 });
      if (result.code !== 0) throw new HttpError(502, `couldn't ask the sandbox's Docker: ${result.stderr.trim()}`);
      const containers = parseContainers(result.stdout);
      const projects = files.map((file) => ({ file, dir: path.dirname(file), containers: [] }));
      const loose = [];
      for (const c of containers) {
        const project = projects.find((p) => p.dir === c.workingDir);
        if (project) project.containers.push(c);
        else loose.push(c);
      }
      return { projects, other: loose };
    },

    // { file, action: up|down|restart|ps }: runs docker compose for one of the folder's compose files.
    'POST /api/services': async (body) => {
      const e = env();
      const file = composeFileFor(e, String(body.file ?? ''));
      const commands = {
        up: ['up', '--build', '--detach'],
        down: ['down'],
        restart: ['restart'],
      };
      const command = commands[body.action];
      if (!command) throw new HttpError(400, 'action must be up, down or restart');
      const result = await exec(['docker', 'compose', '-f', file, ...command], { timeout: 600000 });
      state.event(`compose ${body.action} ${path.relative(e.path, file) || file}: ${result.code === 0 ? 'ok' : 'failed'}`);
      if (body.action !== 'restart') state.sync();
      return { ok: result.code === 0, output: (result.stdout + result.stderr).slice(-20000) };
    },

    'PUT /api/settings': async (body) => {
      const overrides = badRequest(() => validateOverrides(body.overrides));
      const before = settingsFor(ctx, env());
      const e = updateEnv(ctx.paths, id, (stored) => {
        for (const [key, value] of Object.entries(overrides)) {
          if (value === null) delete stored.overrides[key];
          else stored.overrides[key] = value;
        }
      });
      const after = settingsFor(ctx, e);
      const problems = [];
      const changed = (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]);
      if (changed('allowDomains')) problems.push(...await applyDomains(ctx, e, after), ...await applyOffline(ctx, e));
      if (changed('claudeConfigDisable')) problems.push(...await applyClaudeConfig(ctx, e, after));
      if (changed('awsProfile')) problems.push(...await refreshAws(ctx, e, after));
      state.event(`settings saved${problems.length ? ` (${problems.length} problem(s))` : ''}`);
      return { problems };
    },

    // { id, action: allow|dismiss }: answers a host the proxy blocked. Allow adds it to this
    // environment's allowed hosts (so it stays allowed and shows on the page), then clears the request.
    'POST /api/blocked': async (body) => {
      const e = env();
      const request = (await ctx.sbx.approvals(e.sandbox)).find((b) => b.id === body.id);
      if (!request) throw new HttpError(404, 'that request was already answered');
      if (body.action !== 'allow' && body.action !== 'dismiss') throw new HttpError(400, 'action must be allow or dismiss');
      const problems = [];
      if (body.action === 'allow') {
        const overrides = badRequest(() => validateOverrides({ allowDomains: [...(e.overrides.allowDomains ?? []), request.host] }));
        const saved = updateEnv(ctx.paths, id, (stored) => { stored.overrides.allowDomains = overrides.allowDomains; });
        problems.push(...await applyDomains(ctx, saved, settingsFor(ctx, saved)), ...await applyOffline(ctx, saved));
      }
      if (!(await ctx.sbx.respond(request.id, 'dismiss'))) problems.push(`couldn't clear the request for ${request.host}`);
      state.event(`${body.action === 'allow' ? 'allowed' : 'dismissed'} ${request.host}`);
      await state.refreshBlocked?.();
      return { problems };
    },

    // { offline }: denies every host but Claude's for this sandbox, or removes those denies again.
    'PUT /api/offline': async (body) => {
      if (typeof body.offline !== 'boolean') throw new HttpError(400, 'offline must be true or false');
      const problems = await setOffline(ctx, env(), body.offline);
      const offline = Boolean(env().offline);
      state.event(`${offline ? 'offline: only Claude\'s hosts are reachable' : 'back online'}${problems.length ? ` (${problems.length} problem(s))` : ''}`);
      return { offline, problems };
    },

    'GET /api/claude': async () => {
      const probe = [
        `d=${CONFIG_DIR}`,
        'if [ -d "$d/.git" ]; then git -C "$d" log -1 --format="%h%x09%s%x09%cr"; fi',
        'echo ---; ls "$d/skills" 2>/dev/null',
        'echo ---; ls "$d/rules" 2>/dev/null | sed "s/\\.md$//"; true',
      ].join('\n');
      const result = await exec(['sh', '-c', probe], { timeout: 20000 });
      if (result.code !== 0) throw new HttpError(502, `couldn't read the sandbox: ${result.stderr.trim()}`);
      const e = env();
      return {
        repo: settingsFor(ctx, e).claudeConfigRepo,
        repoFromShell: process.env.PORTABLE_CLAUDE_CONFIG_REPO !== undefined,
        ...parseClaudeInfo(result.stdout),
      };
    },

    // { repo }: the configuration repo for every environment (config.json), applied to this one now;
    // the others switch the next time `portable` starts them. Blank turns it off.
    'PUT /api/claude/repo': async (body) => {
      const repo = badRequest(() => validateRepo(body.repo));
      if (process.env.PORTABLE_CLAUDE_CONFIG_REPO !== undefined) {
        throw new HttpError(409, 'PORTABLE_CLAUDE_CONFIG_REPO is set in the shell that started portable, and it wins over config.json; unset it there to set the repo here');
      }
      saveGlobal(ctx.paths, { ...loadGlobal(ctx.paths, {}), claudeConfigRepo: repo });
      ctx.global = { ...ctx.global, claudeConfigRepo: repo };
      const problems = await applyClaudeRepo(ctx, env(), settingsFor(ctx, env()));
      state.event(problems.length ? 'configuration repo saved, but this sandbox couldn\'t switch to it' : `configuration repo set to ${repo || '(none)'}`);
      return { problems };
    },

    'POST /api/claude/update': async () => {
      const problems = await applyClaudeConfig(ctx, env(), settingsFor(ctx, env()));
      state.event(problems.length ? 'Claude configuration update failed' : 'Claude configuration updated');
      return { problems };
    },

    'GET /api/secrets': async () => {
      const status = await secretStatus(ctx.secrets, ctx.sbx);
      const secrets = status.secrets.map(({ name, label, stored, registered }) => ({ name, label, stored, registered }));
      return { backend: ctx.secrets.backend, secrets, claudeSignedIn: status.claudeSignedIn };
    },

    // AWS is off unless this environment has a profile; the page turns it on with one of the
    // profiles on this Mac.
    'GET /api/aws': async () => {
      const profile = settingsFor(ctx, env()).awsProfile;
      return { enabled: Boolean(profile), ...await awsStatus(ctx.runner, profile) };
    },

    'POST /api/aws/refresh': async () => {
      const settings = settingsFor(ctx, env());
      if (!settings.awsProfile) throw new HttpError(400, 'AWS is off for this environment');
      const problems = await refreshAws(ctx, env(), settings);
      state.event(problems.length ? 'AWS refresh had problems' : 'AWS credentials refreshed');
      return { problems };
    },

    // Signs the profile in through SSO (the browser opens on this Mac), then writes fresh
    // credentials into the sandbox.
    'POST /api/aws/login': async () => {
      const settings = settingsFor(ctx, env());
      if (!settings.awsProfile) throw new HttpError(400, 'AWS is off for this environment');
      const login = await ctx.runner.run('aws', ['sso', 'login', '--profile', settings.awsProfile], { timeout: 300000 });
      if (login.code !== 0) throw new HttpError(502, `aws sso login didn't finish: ${(login.stderr || login.stdout).trim().split('\n').pop() || 'no output'}`);
      const problems = await refreshAws(ctx, env(), settings);
      state.event(problems.length ? `signed in to AWS profile ${settings.awsProfile}, but couldn't pass the credentials on` : `signed in to AWS profile ${settings.awsProfile}`);
      return { problems };
    },
  };

  // GET /api/logs?file=...&service=...: streams `docker compose logs -f` as server-sent events.
  function streamLogs(req, res, url) {
    const e = env();
    const file = composeFileFor(e, url.searchParams.get('file') ?? '');
    const service = url.searchParams.get('service');
    if (service && !/^[A-Za-z0-9_.-]+$/.test(service)) throw new HttpError(400, 'bad service name');
    const args = ['exec', e.sandbox, 'docker', 'compose', '-f', file, 'logs', '--follow', '--tail', '200', '--no-color'];
    if (service) args.push(service);
    const child = ctx.runner.stream('sbx', args);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = (chunk) => {
      for (const line of String(chunk).split('\n')) if (line) res.write(`data: ${line}\n\n`);
    };
    child.stdout.on('data', send);
    child.stderr.on('data', send);
    child.on('close', () => res.end('event: end\ndata: \n\n'));
    req.on('close', () => child.kill());
  }

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          reject(new HttpError(413, 'request too large'));
          req.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'body must be JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  return async function handle(req, res) {
    const port = getPort();
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      json(res, 421, { error: 'wrong host' });
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    try {
      const file = STATIC[url.pathname];
      if (req.method === 'GET' && file) {
        res.writeHead(200, {
          'content-type': TYPES[path.extname(file)],
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
          'referrer-policy': 'no-referrer',
        });
        res.end(fs.readFileSync(path.join(UI, file)));
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (url.pathname !== '/api/health' && req.headers['x-portable-token'] !== token
        && !(url.pathname === '/api/logs' && url.searchParams.get('t') === token)) {
        throw new HttpError(401, 'missing or wrong token; open the URL portable printed (portable ui)');
      }
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        streamLogs(req, res, url);
        return;
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, 'not found');
      const body = req.method === 'GET' ? {} : await readBody(req);
      json(res, 200, await route(body));
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, error.status ?? 500, { error: error.message });
    }
  };
}
