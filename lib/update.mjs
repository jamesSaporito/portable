// `portable update`: moves the installed copy forward to its GitHub branch. Only GitHub's commits
// reach it, so changes made in a session arrive after they're merged.
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './env.mjs';

export async function updatePortable(runner, dir, out = (line) => process.stdout.write(`${line}\n`)) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    throw new UserError(`no installed copy in ${dir}; run install.sh from a clone of portable`);
  }
  const git = (...args) => runner.run('git', ['-C', dir, ...args]);
  const status = await git('status', '--porcelain');
  if (status.stdout.trim()) {
    throw new UserError(`${dir} has local changes; make changes in a clone of portable and merge them on GitHub instead\n${status.stdout}`);
  }
  if ((await git('fetch', '--quiet')).code !== 0) throw new UserError(`couldn't fetch ${dir} from GitHub`);
  const incoming = (await git('log', '--oneline', 'HEAD..@{u}')).stdout.trim();
  if (!incoming) {
    out(`portable is up to date (${(await git('log', '-1', '--format=%h')).stdout.trim()})`);
    return;
  }
  out('Updating portable with:');
  out(incoming.split('\n').map((l) => `  ${l}`).join('\n'));
  if ((await git('merge', '--quiet', '--ff-only', '@{u}')).code !== 0) {
    throw new UserError(`couldn't fast-forward ${dir} (its history differs from GitHub's)`);
  }
  out("Updated. If kit/ changed, the next 'portable' in each environment offers to update its sandbox in place, keeping its Docker data. Running pages pick up the change when their sandbox next starts.");
}
