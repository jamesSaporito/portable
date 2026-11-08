// Secrets sbx puts on requests through its proxy, so the values never enter a sandbox. They're
// kept in the macOS login Keychain (service "portable"), and sbx reads them from there through a
// command source (register). Never printed, never on a command line.
// https://docs.docker.com/ai/sandboxes/configuration/credentials/
import { PREFIX } from './env.mjs';

const KEYCHAIN_SERVICE = process.env.PORTABLE_KEYCHAIN_SERVICE || 'portable';

// Secret name → the sbx service the kit's credential capability reads, and where to make it (shown
// by `portable configure`). Optional: without the GitHub token, public repos still clone, but
// pushes and gh need it.
export const SECRETS = {
  GH_TOKEN: {
    service: 'github',
    label: 'GitHub token',
    help: [
      'A fine-grained token: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.',
      'Repository access: your Claude configuration repo and the repos Claude works on. Permissions: Contents and Pull requests, read and write.',
      'Without it, public repos still clone, but git pushes and gh in the sandbox need it.',
    ],
  },
};

// What a replaced secret means for sandboxes that already exist: they read it through the same
// source (https://docs.docker.com/ai/sandboxes/configuration/credentials/). A source sbx didn't
// have before is only bound by sandboxes created after it, so those need recreating.
const SECRET_REPLACED = 'Existing sandboxes use the new value without a restart, though sbx may keep the old one for up to 55 minutes.';

function keychainCommand(name) {
  return `security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${name} -w`;
}

export function createSecrets(runner) {
  return {
    backend: 'Keychain',

    // Whether the secret is stored (never its value).
    async has(name) {
      return (await runner.run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name])).code === 0;
    },

    // Prompts for the value in the Keychain's own hidden prompt (twice), then tells sbx to read it.
    async set(name) {
      const secret = SECRETS[name];
      if (!secret) throw new Error(`unknown secret ${name}; one of ${Object.keys(SECRETS).join(', ')}`);
      process.stderr.write(`Enter ${name} (input hidden; you'll be asked twice):\n`);
      const code = await runner.runInteractive('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', name, '-w']);
      if (code !== 0) return code;
      return this.register(name);
    },

    // Tells sbx to read a Keychain secret whenever its proxy needs it. Must exist before a sandbox
    // is created: https://docs.docker.com/ai/sandboxes/workflows/authentication/
    async register(name) {
      const result = await runner.run('sbx', ['secret', 'set', SECRETS[name].service, '--command', keychainCommand(name)]);
      return result.code;
    },

    async remove(name) {
      const secret = SECRETS[name];
      if (!secret) throw new Error(`unknown secret ${name}`);
      await runner.run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name]);
      return (await runner.run('sbx', ['secret', 'rm', '--force', secret.service])).code;
    },
  };
}

// Each secret: whether it's stored and whether sbx reads it; and whether Claude is signed in
// (sbx holds an `anthropic` secret after /login). Shared by configure, doctor and the page.
export async function secretStatus(secrets, sbx) {
  const bound = new Set((await sbx.secrets()).map((s) => s.name));
  const list = [];
  for (const [name, info] of Object.entries(SECRETS)) {
    list.push({ name, ...info, stored: await secrets.has(name), registered: bound.has(info.service) });
  }
  return { secrets: list, claudeSignedIn: bound.has('anthropic') };
}

// `portable configure`: walks through the secrets portable can use, says which are stored, and
// offers to store the missing ones (every answer defaults to no). A secret that's stored but that
// sbx isn't reading yet is registered without asking. Values are typed into the Keychain's own
// hidden prompt, never echoed or passed on a command line. `ask(question)` resolves true/false;
// `write` prints a line. Returns an exit code.
export async function configure({ secrets, sbx, ask, write, interactive }) {
  if (!interactive) {
    write('portable configure asks for secrets, so run it in a terminal.');
    return 1;
  }
  write(`Secrets are kept in the ${secrets.backend}; sbx puts them on requests, so sandboxes only see placeholders. All of them are optional.`);
  const status = await secretStatus(secrets, sbx);
  let added = false;
  let replaced = false;

  for (const { name, label, help, stored, registered } of status.secrets) {
    write('');
    if (stored && !registered) {
      const code = await secrets.register(name);
      write(code === 0 ? `${label} (${name}): stored; sbx reads it now` : `${label} (${name}): stored, but sbx couldn't be told to read it`);
      added ||= code === 0;
      continue;
    }
    write(`${label} (${name}): ${stored ? 'stored' : 'not stored'}`);
    if (!(await ask(stored ? 'Replace it?' : 'Store it now?'))) continue;
    for (const line of help ?? []) write(`  ${line}`);
    const code = await secrets.set(name);
    if (code === 0) {
      if (registered) replaced = true;
      else added = true;
      write(`Stored ${name}.`);
    } else {
      write(`Didn't store ${name}.`);
    }
  }

  write('');
  if (added) {
    const existing = (await sbx.ours() ?? []).map((s) => s.name.slice(PREFIX.length));
    write(existing.length
      ? `Sandboxes bind a new secret when they're created, so recreate the ones that should use it: ${existing.map((n) => `portable rm ${n}`).join(', ')}.`
      : 'New sandboxes will use them.');
  } else if (replaced) {
    write(SECRET_REPLACED);
  }
  write(status.claudeSignedIn
    ? 'Claude: signed in.'
    : 'Claude signs in separately: run portable claude and type /login, once per computer.');
  return 0;
}
