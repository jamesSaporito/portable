// Secrets sbx puts on requests through its proxy, so the values never enter a sandbox. They're
// kept in the macOS login Keychain (service "portable"), and sbx reads them from there through a
// command source (register). Never printed, never on a command line.
// https://docs.docker.com/ai/sandboxes/configuration/credentials/

export const KEYCHAIN_SERVICE = process.env.PORTABLE_KEYCHAIN_SERVICE || 'portable';

// Secret name → the sbx service the kit's credential capability reads.
export const SECRETS = {
  GH_TOKEN: { service: 'github', label: 'GitHub token', required: true },
  INFRACOST_CLI_AUTHENTICATION_TOKEN: { service: 'infracost', label: 'Infracost token', required: false },
};

export function keychainCommand(name) {
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
