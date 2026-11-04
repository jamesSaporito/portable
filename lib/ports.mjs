// Forwards the ports that containers in a sandbox publish to the host's 127.0.0.1, at sticky ports.
//
// A sandbox port keeps the host port it got the first time: it's saved in the environment's
// settings (`ports`) and reused, so bookmarks and TablePlus connections keep working across
// restarts. A new port gets the same number when the host has it free, otherwise the next free one
// above. Ports that other environments stick to are left for them. The page can change a sticky port.
import { listEnvs, updateEnv } from './config.mjs';

const FALLBACK_TRIES = 50;

// Host ports from `lsof -nP -iTCP -sTCP:LISTEN` (macOS).
export function parseLsof(text) {
  const ports = new Set();
  for (const line of text.split('\n').slice(1)) {
    const name = line.trim().split(/\s+/)[8];
    const port = name?.match(/:(\d+)$/)?.[1];
    if (port) ports.add(Number(port));
  }
  return ports;
}

export async function hostListeners(runner) {
  return parseLsof((await runner.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])).stdout);
}

// Host ports this environment shouldn't take: every other sandbox's forwards (a stopped sandbox's
// come back when it starts), every listener on the host except this sandbox's own forwards, and
// the ports other environments stick to or serve their page on.
export function takenPorts({ sandboxes, listeners, envs, self }) {
  const own = new Set(
    (sandboxes.find((s) => s.name === self.sandbox)?.ports ?? []).map((p) => Number(p.host_port)),
  );
  const taken = new Set();
  for (const port of listeners) if (!own.has(port)) taken.add(port);
  for (const s of sandboxes) {
    if (s.name === self.sandbox) continue;
    for (const p of s.ports ?? []) taken.add(Number(p.host_port));
  }
  for (const e of envs) {
    if (e.id === self.id) continue;
    for (const port of Object.values(e.ports ?? {})) taken.add(Number(port));
    if (e.uiPort) taken.add(Number(e.uiPort));
  }
  if (self.uiPort) taken.add(Number(self.uiPort));
  return taken;
}

// The host ports to try for a sandbox port, best first: its sticky port, else its own number,
// else the next free ones above it.
export function* candidates(port, sticky, taken) {
  if (sticky) {
    if (!taken.has(sticky)) yield sticky;
    // A sticky port someone else holds now: fall back without forgetting it.
  }
  if (!taken.has(port) && port !== sticky) yield port;
  let tries = 0;
  for (let host = port + 1; host <= 65535 && tries < FALLBACK_TRIES; host++) {
    if (taken.has(host) || host === sticky) continue;
    tries++;
    yield host;
  }
}

// Brings a running sandbox's forwards in line with what its containers publish. Returns the
// forwards and what changed, or undefined when the sandbox or sbx couldn't be asked (so nothing is
// torn down on a hiccup). Saves sticky ports to the environment's settings. `sandboxes` is the
// `sbx ls` result when the caller already has one (the agent fetches it once per tick).
export async function syncPorts({ sbx, runner, paths, env, log = () => {}, sandboxes }) {
  const want = await sbx.published(env.sandbox);
  if (want === undefined) return undefined;
  sandboxes ??= await sbx.list();
  const self = sandboxes?.find((s) => s.name === env.sandbox);
  if (!self) return undefined;
  let have = await sbx.forwards(env.sandbox);
  const taken = takenPorts({
    sandboxes,
    listeners: await hostListeners(runner),
    envs: listEnvs(paths),
    self: env,
  });
  const changes = [];
  const sticky = { ...(env.ports ?? {}) };
  // For one sandbox port, the other ports of this environment stick to hosts it mustn't take either.
  const takenFor = (port) => {
    const set = new Set(taken);
    for (const [other, host] of Object.entries(sticky)) if (Number(other) !== port) set.add(Number(host));
    return set;
  };

  // Forwards no container publishes anymore, and ones not on their sticky port while it's free
  // (the page changed it). The sticky entry stays, so the port comes back to the same place.
  for (const f of have) {
    const target = sticky[f.sandbox];
    const moved = target && target !== f.host && !takenFor(f.sandbox).has(target);
    if (want.includes(f.sandbox) && !moved) continue;
    if (await sbx.unpublish(env.sandbox, f.host, f.sandbox)) {
      have = have.filter((h) => h !== f);
      changes.push(`closed ${f.sandbox} → ${f.host}`);
    }
  }

  // New ports: first everything that can have its sticky port or own number, so a port's number
  // isn't given away as a sibling's fallback; then the rest at the next free number.
  const missing = want.filter((port) => !have.some((f) => f.sandbox === port));
  const later = [];
  for (const port of missing) {
    const first = candidates(port, sticky[port], takenFor(port)).next().value;
    if (first !== undefined && (first === sticky[port] || first === port) && await sbx.publish(env.sandbox, first, port)) {
      have.push({ host: first, sandbox: port });
      taken.add(first);
      sticky[port] ??= first;
      changes.push(`opened ${port} → ${first}`);
    } else {
      later.push(port);
    }
  }
  for (const port of later) {
    let done = false;
    for (const host of candidates(port, sticky[port], takenFor(port))) {
      if (await sbx.publish(env.sandbox, host, port)) {
        have.push({ host, sandbox: port });
        taken.add(host);
        // A sticky port another process holds for now is kept, so the forward moves back to it.
        sticky[port] ??= host;
        changes.push(`opened ${port} → ${host}`);
        done = true;
        break;
      }
      taken.add(host);
    }
    if (!done) log(`couldn't forward port ${port} of ${env.id} to the host (tried it and the next free ones)`);
  }

  if (JSON.stringify(sticky) !== JSON.stringify(env.ports ?? {})) {
    env.ports = sticky;
    updateEnv(paths, env.id, (stored) => { stored.ports = sticky; });
  }
  if (changes.length) {
    // `SANDBOX HOST` lines in /etc/portable/ports, so sessions can give the user host URLs.
    const lines = have.map((f) => `${f.sandbox} ${f.host}`).sort((a, b) => parseInt(a) - parseInt(b)).join('\n');
    const result = await sbx.exec(env.sandbox, ['portable-setup', 'ports'], { input: `${lines}\n`, user: 'root' });
    if (result.code !== 0) log(`couldn't write the port mapping into ${env.id}`);
    for (const change of changes) log(change);
  }
  return { forwards: have.sort((a, b) => a.sandbox - b.sandbox), changes };
}

export function portsTable(forwards) {
  if (!forwards.length) return 'no ports forwarded (nothing in the sandbox publishes one)';
  const rows = [['SANDBOX PORT', 'ON THE HOST'], ...forwards.map((f) => [String(f.sandbox), `http://localhost:${f.host}`])];
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([a, b]) => `${a.padEnd(width)}  ${b}`).join('\n');
}
