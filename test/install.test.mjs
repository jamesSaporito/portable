import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './support/helpers.mjs';

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.sh');
const LINE = 'export PATH="$HOME/.local/bin:$PATH"';

// install.sh's rc_file and link_command, run on their own in a fake home whose PATH already has
// ~/.local/bin (as a terminal that ran uninstall.sh still does). `files` seeds startup files.
function linkCommand(t, files = {}) {
  const { home } = tempHome(t);
  fs.mkdirSync(path.join(home, 'p', 'bin'), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(home, name), `${content}\n`);
  const script = fs.readFileSync(INSTALL, 'utf8');
  const fn = (name) => script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'))[0];
  execFileSync('bash', ['-c', `set -euo pipefail; bin_dir="$HOME/.local/bin"; PORTABLE_ROOT="$HOME/p"\n${fn('rc_file')}${fn('link_command')}link_command`], {
    env: { HOME: home, SHELL: '/bin/zsh', PATH: `${home}/.local/bin:/usr/bin:/bin` },
    stdio: 'pipe',
  });
  const zshrc = path.join(home, '.zshrc');
  return fs.existsSync(zshrc) ? fs.readFileSync(zshrc, 'utf8') : '';
}

const added = (rc) => rc.split('\n').filter((l) => l === LINE).length;

test('install adds the PATH line even when the running shell already has ~/.local/bin', (t) => {
  assert.equal(added(linkCommand(t)), 1);
});

test('install leaves the PATH alone when a startup file the shell reads already adds ~/.local/bin', (t) => {
  assert.equal(added(linkCommand(t, { '.zshrc': LINE })), 1);
  assert.equal(linkCommand(t, { '.zprofile': 'export PATH=~/.local/bin:$PATH' }), '');
  assert.equal(linkCommand(t, { '.zshenv': 'PATH="${HOME}/.local/bin:$PATH"' }), '');
});

test('install adds the PATH line when the only one is commented out or in another shell\'s file', (t) => {
  assert.equal(added(linkCommand(t, { '.zshrc': `# ${LINE}` })), 1);
  assert.equal(added(linkCommand(t, { '.bashrc': LINE })), 1);
});
