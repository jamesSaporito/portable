// Checks the syntax of every script in the project (`npm run lint`). Each file is checked on its
// own: `bash -n a b` only checks `a` and hands `b` to it as an argument.
//
//   node scripts/lint.mjs        everything
//   node scripts/lint.mjs js     only the JavaScript
//   node scripts/lint.mjs sh     only the shell scripts
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// The command that checks a file, and the files it checks (globs from the project root).
const CHECKS = {
  js: {
    command: ['node', '--check'],
    files: ['bin/*.mjs', 'lib/*.mjs', 'lib/ui/*.js', 'lib/ui/*.mjs', 'scripts/*.mjs', 'ui-tests/*.mjs', '*.config.mjs'],
  },
  sh: {
    command: ['sh', '-n'],
    files: ['bin/portable'],
  },
  bash: {
    command: ['bash', '-n'],
    files: ['install.sh', 'uninstall.sh', 'kit/files/portable-setup', 'kit/files/portable-doctor'],
  },
};
// `sh` on the command line means both kinds of shell script.
const GROUPS = { js: ['js'], sh: ['sh', 'bash'] };

const only = process.argv[2];
if (only && !GROUPS[only]) {
  console.error(`usage: node scripts/lint.mjs [${Object.keys(GROUPS).join('|')}]`);
  process.exit(2);
}

let failed = 0;
for (const name of only ? GROUPS[only] : Object.keys(CHECKS)) {
  const [command, ...args] = CHECKS[name].command;
  for (const file of CHECKS[name].files.flatMap((pattern) => globSync(pattern, { cwd: ROOT }))) {
    const result = spawnSync(command, [...args, file], { cwd: ROOT, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`✖ ${file}`);
      failed++;
    }
  }
}
console.log(failed ? `${failed} file(s) failed the syntax check` : 'All files passed the syntax check');
process.exit(failed ? 1 : 0);
