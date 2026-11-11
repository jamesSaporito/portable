// A thin wrapper around the sbx CLI (Docker Sandboxes). Listings are read as JSON.
// CLI reference: https://docs.docker.com/reference/cli/sbx/
import { PREFIX, UserError, say } from './env.mjs';

// sbx's built-in Claude Code agent. Not the docker/sbx-kit-claude image by reference: that kit has
// no Anthropic credential rules, so /login's token exchange with platform.claude.com goes out with
// sbx's placeholder (proxy: custom_secret_replacement_skipped, no_target_match) and gets a 401.
// The built-in agent signs in (checked by hand on 2026-11-04, sbx 0.51.0). Its version follows sbx.
const WORKLOAD = process.env.PORTABLE_WORKLOAD || 'claude';
// Oldest sbx the kit's capabilities need (host-mount@1 and git-identity@1 arrived in 0.48 and 0.50):
// https://docs.docker.com/ai/sandboxes/customize/author/capabilities/
export const SBX_MIN = '0.50.0';

export function versionAtLeast(version, min) {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

// TCP ports that containers in a sandbox publish on all interfaces (`-p 3000:80`). sbx's forward
// reaches the VM from outside, so a port bound only to the VM's 127.0.0.1 doesn't answer.
const PUBLISHED_SCRIPT = `ids=$(docker ps -q) || exit 1
[ -n "$ids" ] || exit 0
docker inspect --format '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}} {{.HostPort}} {{$p}}{{"\\n"}}{{end}}{{end}}' $ids`;

export function parsePublished(text) {
  const ports = new Set();
  for (const line of text.split('\n')) {
    const [ip, port, spec] = line.trim().split(/\s+/);
    if (!spec?.endsWith('/tcp') || !(ip === '0.0.0.0' || ip === '::')) continue;
    if (/^\d+$/.test(port)) ports.add(Number(port));
  }
  return [...ports].sort((a, b) => a - b);
}

// A sandbox's TCP forwards from `sbx ls`/`sbx ports` JSON entries.
export function tcpForwards(entries) {
  return (entries ?? [])
    .filter((p) => String(p.protocol ?? 'tcp').startsWith('tcp'))
    .map((p) => ({ host: Number(p.host_port), sandbox: Number(p.sandbox_port) }))
    .filter((p) => p.host && p.sandbox);
}

// Hosts from `sbx policy ls NAME` rules that were added for this sandbox alone.
export function addedDomains(rules, name) {
  return (rules ?? [])
    .filter((r) => r.decision === 'allow' && r.sandbox_id === name && r.editable && r.provenance?.created_via === 'added')
    .flatMap((r) => r.resources ?? []);
}

// Every host a sandbox may reach, grouped by where the rule came from: sbx's own defaults
// (`default-ai-services` and the like), the kit (portable's and the Claude agent's, provisioned at
// create), hosts portable added for this sandbox, and hosts added for every sandbox. Hosts keep
// their port (`:443` covers HTTPS only; none covers every port). Returns [{ source, name, hosts }].
export function allowedHosts(rules, name) {
  return (rules ?? [])
    .filter((r) => r.decision === 'allow' && (!r.sandbox_id || r.sandbox_id === name) && r.resources?.length)
    .map((r) => {
      const via = r.provenance?.created_via;
      const source = via === 'default' ? 'sbx' : via === 'provisioned' ? 'kit' : r.sandbox_id ? 'environment' : 'global';
      const label = source === 'sbx' ? String(r.name ?? r.id).replace(/^default-/, '').replaceAll('-', ' ') : source;
      return { source, name: label, hosts: r.resources.map(String) };
    });
}

// Offline mode keeps these reachable (the domain and its subdomains), so Claude keeps working.
export const CLAUDE_DOMAINS = ['anthropic.com', 'claude.ai', 'claude.com'];

function isClaudeHost(pattern) {
  const host = pattern.replace(/:\d+$/, '').replace(/^\*\*?\./, '').toLowerCase();
  return CLAUDE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// What offline mode denies for a sandbox: every host an allow rule lets it reach, without the port
// (a host deny covers every port), except Claude's. `open` is set when a rule allows every host
// (sbx's Open preset): denying the listed hosts can't stop the rest then.
// A deny beats every allow: https://docs.docker.com/ai/governance/local/
export function offlineTargets(rules, name) {
  const hosts = allowedHosts(rules, name).flatMap((g) => g.hosts);
  const open = hosts.some((h) => /^\*\*?(:\d+)?$/.test(h));
  const targets = [...new Set(hosts.map((h) => h.replace(/:\d+$/, '')))].filter((h) => !isClaudeHost(h)).sort();
  return { open, targets };
}

// Deny rules added for this sandbox alone, as [{ id, host }].
export function deniedRules(rules, name) {
  return (rules ?? [])
    .filter((r) => r.decision === 'deny' && r.sandbox_id === name && r.provenance?.created_via === 'added')
    .flatMap((r) => (r.resources ?? []).map((host) => ({ id: r.id, host: String(host) })));
}

// Pending approvals from `sbx policy approval ls` for one sandbox, as {id, host, at}. The host
// drops the default HTTPS port, the way people write allowed hosts.
export function blockedHosts(approvals, name) {
  return (Array.isArray(approvals) ? approvals : [])
    .filter((a) => a.sandbox_name === name && String(a.id).startsWith('network:'))
    .map((a) => ({ id: a.id, host: String(a.title).replace(/:443$/, ''), at: a.created_at }));
}

// Build kits in sbx's own builder sandbox (sbx-kit-builder), not with the Mac's docker buildx: the
// host build needs an OCI exporter, which Docker's default builder (docker driver) lacks unless the
// containerd image store is on. SBX_KIT_BUILDER isn't in Docker's docs; it was found in sbx 0.51.0
// and checked by hand. Setting it yourself overrides this.
function buildEnv() {
  return { ...process.env, SBX_KIT_BUILDER: process.env.SBX_KIT_BUILDER || 'sandbox' };
}

export function createSbx(runner) {
  const sbx = (args, opts) => runner.run('sbx', args, opts);

  async function json(args) {
    const result = await sbx([...args, '--format', 'json']);
    if (result.code !== 0) return undefined;
    try {
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  }

  const api = {
    async version() {
      const result = await sbx(['version']);
      return result.stdout.match(/\d+\.\d+\.\d+/)?.[0];
    },

    // Checks sbx is installed, new enough and signed in; signs in when it isn't.
    async ensure() {
      const version = await api.version();
      if (!version) {
        throw new UserError("Docker Sandboxes (sbx) isn't installed; run install.sh (https://docs.docker.com/ai/sandboxes/install/)");
      }
      if (!versionAtLeast(version, SBX_MIN)) {
        throw new UserError(`sbx ${version} is too old; portable's kit needs ${SBX_MIN} or later (brew upgrade sbx)`);
      }
      if ((await sbx(['ls'])).code !== 0) {
        say('signing in to Docker (sbx login)...');
        if ((await runner.runInteractive('sbx', ['login'])) !== 0) throw new UserError("couldn't sign in to Docker (sbx login)");
      }
      return version;
    },

    // Every sandbox (name, status, workspaces, ports, ...), or undefined when sbx didn't answer,
    // which callers must tell apart from "no sandboxes" (the daemon may just be restarting).
    async list() {
      const all = await json(['ls']);
      return Array.isArray(all) ? all : undefined;
    },

    async ours() {
      return (await api.list())?.filter((s) => s.name.startsWith(PREFIX));
    },

    // The sandbox's entry, or null when there's none, or undefined when sbx didn't answer.
    async get(name, sandboxes) {
      const all = sandboxes ?? await api.list();
      if (all === undefined) return undefined;
      return all.find((s) => s.name === name) ?? null;
    },

    async create(name, folder, { env = {}, kit, cpus, memory }) {
      // The shared skills store is left out (--skills=off): skills come from the configuration
      // repo, which links into ~/.claude/skills itself.
      const args = ['create', '--name', name, '--skills=off'];
      if (cpus) args.push('--cpus', String(cpus));
      if (memory) args.push('--memory', memory);
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && value !== '') args.push('-e', `${key}=${value}`);
      }
      args.push(WORKLOAD, '--kit', kit, folder);
      return runner.runInteractive('sbx', args, { env: buildEnv() });
    },

    // Adds a mixin to an existing sandbox (`sbx kit add`, experimental in sbx 0.51.0): sbx recreates
    // the sandbox's container with its kits rebuilt from their folders, keeping its Docker data and
    // home. Interactive, since sbx asks before granting permissions a changed kit adds.
    addKit(name, kit) {
      return runner.runInteractive('sbx', ['kit', 'add', name, kit], { env: buildEnv() });
    },

    // Starts a stopped sandbox in the background (detached, so it runs until `sbx stop`).
    async wake(name) {
      const sandbox = await api.get(name);
      if (sandbox && sandbox.status !== 'running') await sbx(['run', '-d', '--name', name]);
      return Boolean(sandbox);
    },

    exec(name, command, { input, user, timeout } = {}) {
      const args = ['exec'];
      if (input !== undefined) args.push('-i');
      if (user) args.push('-u', user);
      return sbx([...args, name, ...command], { input, timeout });
    },

    async published(name) {
      const result = await api.exec(name, ['sh', '-c', PUBLISHED_SCRIPT], { timeout: 20000 });
      if (result.code !== 0) return undefined;
      return parsePublished(result.stdout);
    },

    async forwards(name) {
      return tcpForwards(await json(['ports', name]));
    },

    async publish(name, host, port) {
      return (await sbx(['ports', name, '--publish', `${host}:${port}`])).code === 0;
    },

    async unpublish(name, host, port) {
      return (await sbx(['ports', name, '--unpublish', `${host}:${port}`])).code === 0;
    },

    // Hosts added for this sandbox only (`sbx policy allow network --sandbox`), not the kit's own
    // rules (provisioned, not editable) or global ones.
    async sandboxDomains(name) {
      return addedDomains(await api.policyRules(name), name);
    },

    // The raw network rules that apply to this sandbox; undefined when sbx doesn't answer.
    async policyRules(name) {
      return (await json(['policy', 'ls', name, '--type', 'network']))?.rules;
    },

    // Every allowed host for this sandbox, grouped by rule (see allowedHosts); undefined when sbx
    // doesn't answer.
    async networkPolicy(name) {
      const rules = await api.policyRules(name);
      return rules && allowedHosts(rules, name);
    },

    // Requests the proxy blocked and holds for a decision ("Approval required"), for one sandbox.
    async approvals(name) {
      return blockedHosts(await json(['policy', 'approval', 'ls']), name);
    },

    async respond(id, option) {
      return (await sbx(['policy', 'approval', 'respond', id, '--option', option])).code === 0;
    },

    async allowDomain(name, host) {
      return (await sbx(['policy', 'allow', 'network', '--sandbox', name, host])).code === 0;
    },

    async removeDomain(name, host) {
      return (await sbx(['policy', 'rm', 'network', '--force', '--sandbox', name, '--resource', host])).code === 0;
    },

    // Blocks hosts for this sandbox only, whatever allows them, in one call
    // (https://docs.docker.com/ai/governance/local/network-rules/). Hosts already denied are skipped,
    // but one host sbx refuses (an allow on it in the same scope) fails the call and adds none
    // (checked on sbx 0.51.0).
    async denyDomains(name, hosts) {
      return (await sbx(['policy', 'deny', 'network', '--sandbox', name, hosts.join(',')])).code === 0;
    },

    // Removes this sandbox's rules on these hosts in one call; one host without a rule fails the
    // call and removes none (checked on sbx 0.51.0).
    async removeDomains(name, hosts) {
      return (await sbx(['policy', 'rm', 'network', '--force', '--sandbox', name, '--resource', hosts.join(',')])).code === 0;
    },

    async secrets() {
      const all = await json(['secret', 'ls']);
      return (all?.secrets ?? []).map((s) => ({ name: s.name }));
    },

    stop: (name) => sbx(['stop', name]),
    remove: (name, { force = false } = {}) => (force ? sbx(['rm', '--force', name]) : runner.runInteractive('sbx', ['rm', name])),
  };
  return api;
}
