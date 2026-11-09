// Which folder a session may use, and which environment (sandbox + settings) a folder maps to.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './paths.mjs';
import { listEnvs } from './config.mjs';

export const PREFIX = 'portable-';

// A message for the user rather than a crash; the CLI prints it without a stack trace.
export class UserError extends Error {}

// A status line for the user on stderr, and a result line on stdout.
export const say = (message) => process.stderr.write(`portable: ${message}\n`);
export const out = (text) => process.stdout.write(`${text}\n`);

function realpath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export function inside(dir, parent) {
  return `${dir}/`.startsWith(`${parent}/`);
}

// The git repo a file lives in (the first parent with a .git), or its folder when there's none.
function repoOf(file) {
  let dir = path.dirname(file);
  for (let at = dir; at !== path.dirname(at); at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
  }
  return dir;
}

// Folders a session may not start in, even inside the workspace: the copy of portable that's
// running (a session could rewrite its own launcher and widen its access at the next launch) and
// the Claude configuration repo the host's ~/.claude links into (it could change what the host's
// Claude runs). A session started above them can still see them, as the README says.
export function protectedFolders(home, portableRoot) {
  const folders = { self: realpath(portableRoot), config: null };
  try {
    const link = fs.readlinkSync(path.join(home, '.claude', 'CLAUDE.md'));
    folders.config = realpath(repoOf(path.resolve(path.join(home, '.claude'), link)));
  } catch {
    // ~/.claude/CLAUDE.md isn't a link, so no configuration repo to protect.
  }
  return folders;
}

function isProtected(dir, folders) {
  return inside(dir, folders.self) || (folders.config !== null && inside(dir, folders.config));
}

// Why a folder can't be shared with a sandbox, or null when it can: one holding your home folder
// (so ~/.ssh and ~/.aws too), your computer's settings (~/.config, ~/Library and other dot folders
// in your home), or one that would cover a system folder in the sandbox. `dir` is a real path.
function refusal(dir, home) {
  if (dir === '/' || inside(home, dir) || dir === '/Users' || dir === '/home') {
    return 'is too broad: it holds your home folder';
  }
  const top = inside(dir, home) ? path.relative(home, dir).split(path.sep)[0] : '';
  if (top.startsWith('.') || top === 'Library') return "holds your computer's settings or secrets";
  // A host path never overlaps the sandbox's own folders on macOS, but a custom one could hide them.
  if (/^\/(bin|boot|dev|etc|lib[^/]*|proc|root|run|sbin|srv|sys|usr|var)(\/|$)/.test(dir)) {
    return 'would cover a system folder in the sandbox';
  }
  return null;
}

// The workspace folder from the settings, expanded and checked, or null when workspaceDir isn't
// set (then any folder that passes sessionFolder's checks works). Doesn't create it.
export function workspaceFolder(setting, home, folders) {
  if (!setting) return null;
  const ws = realpath(expandHome(setting, home).replace(/\/+$/, '') || '/');
  const why = refusal(ws, home);
  if (why) throw new UserError(`the workspace folder (${setting}) ${why}; point workspaceDir in config.json at a dedicated folder`);
  if (isProtected(ws, folders)) {
    throw new UserError(`the workspace folder (${setting}) is inside portable or your Claude configuration repo; point it at another folder`);
  }
  return ws;
}

// The folder a session shares and starts in: the current one, inside the workspace folder when one
// is set. Starting further in narrows what Claude can see.
export function sessionFolder(cwd, ws, folders, home) {
  const here = realpath(cwd);
  if (ws && !inside(here, ws)) {
    throw new UserError(`run it from the workspace folder (${ws}) or a folder in it (workspaceDir in config.json); the session can see only the folder it starts in`);
  }
  const why = refusal(here, home);
  if (why) throw new UserError(`${here} ${why}, so it can't be shared with a sandbox; cd into a project folder first`);
  if (inside(here, folders.self)) {
    throw new UserError(`${here} is the copy of portable that's running, which a session may not change; to work on it in portable, run the installed 'portable' instead`);
  }
  if (folders.config !== null && inside(here, folders.config)) {
    throw new UserError([
      `${here} is your Claude configuration repo: your host's ~/.claude links into it, so a session could change what your host's Claude runs.`,
      '  To work on it in portable, run its installer, which links ~/.claude to a copy outside the workspace instead:',
      `    '${folders.config}/install.sh'`,
      "  then push changes from here, and run './install.sh update' on the host once they're merged.",
    ].join('\n'));
  }
  return here;
}

// sbx names: letters, digits, hyphens and periods, starting with a letter or digit.
export function cleanName(name) {
  const clean = name.replace(/[^A-Za-z0-9.-]/g, '-').replace(/-+$/, '').replace(/^[-.]+/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(clean)) {
    throw new UserError(`'${name}' isn't a valid name (letters, digits, '.', '-')`);
  }
  return clean;
}

function shortHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 6);
}

// Finds or makes up the environment for a folder. `name` (from --name) gives a separate sandbox
// on the same folder. Without one, a folder has one environment; the first time, a sandbox an
// older portable made for the folder is adopted so its Docker data and history carry on.
// Returns the environment's settings; the caller saves them.
export function resolveEnv({ paths, folder, name, sandboxes }) {
  const envs = listEnvs(paths);
  if (name) {
    const id = cleanName(name);
    const existing = envs.find((e) => e.id === id);
    if (existing && existing.path !== folder) {
      throw new UserError(`'${id}' is the environment of ${existing.path}; pick another --name, or run it there`);
    }
    return existing ?? { id, path: folder, named: true, sandbox: PREFIX + id, overrides: {}, ports: {} };
  }

  const existing = envs.find((e) => e.path === folder && !e.named);
  if (existing) return existing;

  const base = cleanName(path.basename(folder) || 'root');
  const claimed = new Set([...envs.map((e) => e.sandbox), ...sandboxes.map((s) => s.name)]);
  const adopt = sandboxes.find((s) => s.name === PREFIX + base && s.workspaces?.[0] === folder)
    ?? sandboxes.find((s) => s.name.startsWith(PREFIX) && s.workspaces?.[0] === folder && !envs.some((e) => e.sandbox === s.name));
  let id;
  if (adopt) {
    id = adopt.name.slice(PREFIX.length);
  } else if (!claimed.has(PREFIX + base) && !envs.some((e) => e.id === base)) {
    id = base;
  } else {
    id = `${base}-${shortHash(folder)}`;
  }
  return { id, path: folder, named: false, sandbox: PREFIX + id, overrides: {}, ports: {} };
}

// The environment a name on the command line refers to (`portable stop api`).
export function envByName(paths, name) {
  const id = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
  return listEnvs(paths).find((e) => e.id === id);
}
