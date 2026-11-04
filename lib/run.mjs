// Runs host commands. Everything that shells out goes through here, so tests can swap in a fake runner.
import { spawn } from 'node:child_process';

// Runs a command to completion and collects its output. Never rejects for a non-zero exit: callers
// read `code`. A missing executable gives code 127, like a shell would.
export function run(cmd, args = [], { input, timeout = 0, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env, timeout });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: String(error.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr + error.message }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// Runs a command attached to this terminal (Claude, a shell) and resolves with its exit code.
export function runInteractive(cmd, args = [], { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: env ?? process.env });
    child.on('error', () => resolve(127));
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

// Starts a long-running command (e.g. `docker compose logs -f`) and hands back the child process.
export function stream(cmd, args = []) {
  return spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export const defaultRunner = { run, runInteractive, stream };
