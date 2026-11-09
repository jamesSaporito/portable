// Turns a host AWS profile (SSO or assumed role) into short-lived STS credentials for a sandbox.
// The SSO token and ~/.aws stay on the host; only the temporary keys go in, through stdin.
// https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html

const AWS_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CREDENTIAL_EXPIRATION'];

// Only the names we expect are taken, so the output can't set anything else.
export function parseExport(text) {
  const creds = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    const name = line.slice(0, eq);
    if (eq > 0 && AWS_VARS.includes(name)) creds[name] = line.slice(eq + 1).trim();
  }
  return creds;
}

// Prints a profile's credentials as NAME=value lines; exits non-zero when it's signed out.
const exportArgs = (profile) => ['configure', 'export-credentials', '--profile', profile, '--format', 'env-no-export'];

// Credentials for a profile as {NAME: value}; {} when there's no profile or they can't be had.
// Signs in through SSO in the browser when the session has expired and `interactive` is set.
export async function awsCredentials(runner, profile, { interactive = true, log = () => {} } = {}) {
  if (!profile) return {};
  let result = await runner.run('aws', exportArgs(profile));
  if (result.code === 127) {
    log('the aws CLI is not on this host; skipping AWS credentials');
    return {};
  }
  if (result.code !== 0 && interactive) {
    log(`AWS session for profile '${profile}' has expired; signing in...`);
    if ((await runner.runInteractive('aws', ['sso', 'login', '--profile', profile])) === 0) {
      result = await runner.run('aws', exportArgs(profile));
    }
  }
  if (result.code !== 0) {
    log(`couldn't get AWS credentials for profile '${profile}' (signed out?); sign in on the environment's page, or run: aws sso login --profile ${profile}`);
    return {};
  }
  const creds = parseExport(result.stdout);
  const region = (await runner.run('aws', ['configure', 'get', 'region', '--profile', profile])).stdout.trim();
  if (region) Object.assign(creds, { AWS_REGION: region, AWS_DEFAULT_REGION: region });
  return creds;
}

// What the page shows: the profiles on this Mac and whether the chosen one has a live session.
export async function awsStatus(runner, profile) {
  const version = await runner.run('aws', ['--version']);
  if (version.code === 127) return { cliInstalled: false, profiles: [], profile, profileExists: false, signedIn: false, expiresAt: null };
  const profiles = (await runner.run('aws', ['configure', 'list-profiles'])).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const status = { cliInstalled: true, profiles, profile, profileExists: profiles.includes(profile), signedIn: false, expiresAt: null };
  if (status.profileExists) {
    const result = await runner.run('aws', exportArgs(profile));
    if (result.code === 0) {
      status.signedIn = true;
      status.expiresAt = parseExport(result.stdout).AWS_CREDENTIAL_EXPIRATION ?? null;
    }
  }
  return status;
}

// Writes credentials into the sandbox for new sessions (portable-setup aws), or clears them.
export async function pushAws(sbx, sandbox, creds) {
  const input = Object.entries(creds).map(([k, v]) => `export ${k}=${v}`).join('\n');
  const result = await sbx.exec(sandbox, ['portable-setup', 'aws'], { input: `${input}\n`, user: 'root' });
  return result.code === 0;
}
