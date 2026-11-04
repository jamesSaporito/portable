// `portable configure`: walks through the secrets portable uses, says which are stored, and
// prompts for the missing ones (required ones default to yes). A secret that's stored but that sbx
// isn't reading yet is registered without asking. Values are typed into the secret store's own
// hidden prompt, never echoed or passed on a command line.
import { SECRETS } from './secrets.mjs';

// Where to make each token, shown before its prompt.
const HELP = {
  GH_TOKEN: [
    'A fine-grained token: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.',
    'Repository access: your Claude configuration repo and the repos Claude works on. Permissions: Contents and Pull requests, read and write.',
  ],
  INFRACOST_CLI_AUTHENTICATION_TOKEN: [
    'A personal access (or service account) token from Infracost Cloud, for cost estimates. Skip it if you don\'t use Infracost.',
  ],
};

// `ask(question, defaultYes)` resolves true/false; `write` prints a line. Returns an exit code.
export async function configure({ secrets, sbx, ask, write, interactive }) {
  if (!interactive) {
    write('portable configure asks for secrets, so run it in a terminal.');
    return 1;
  }
  write(`Secrets are kept in the ${secrets.backend}; sbx puts them on requests, so sandboxes only see placeholders.`);
  const registered = new Set((await sbx.secrets()).map((s) => s.name));
  let changed = false;
  let missingRequired = false;

  for (const [name, info] of Object.entries(SECRETS)) {
    write('');
    const kind = info.required ? 'required' : 'optional';
    const stored = await secrets.has(name);
    if (stored && !registered.has(info.service)) {
      const code = await secrets.register(name);
      write(code === 0 ? `${info.label} (${name}): stored; sbx reads it now` : `${info.label} (${name}): stored, but sbx couldn't be told to read it`);
      changed ||= code === 0;
      continue;
    }
    write(`${info.label} (${name}, ${kind}): ${stored ? 'stored' : 'not stored'}`);
    const question = stored ? 'Replace it?' : 'Store it now?';
    if (!(await ask(question, !stored && info.required))) {
      if (!stored && info.required) missingRequired = true;
      continue;
    }
    for (const line of HELP[name] ?? []) write(`  ${line}`);
    const code = await secrets.set(name);
    if (code === 0) {
      changed = true;
      write(`Stored ${name}.`);
    } else {
      write(`Didn't store ${name}.`);
      if (info.required && !stored) missingRequired = true;
    }
  }

  write('');
  if (changed) {
    const existing = (await sbx.ours() ?? []).map((s) => s.name.replace(/^portable-/, ''));
    write(existing.length
      ? `Sandboxes bind secrets when they're created, so recreate the ones that should use the new values: ${existing.map((n) => `portable rm ${n}`).join(', ')}.`
      : 'New sandboxes will use them.');
  }
  if (missingRequired) {
    write('A required secret is still missing; run portable configure again when you have it.');
    return 1;
  }
  write(registered.has('anthropic')
    ? 'Claude: signed in.'
    : 'Claude signs in separately: run portable claude and type /login, once per computer.');
  return 0;
}
