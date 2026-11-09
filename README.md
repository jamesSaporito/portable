# portable

Claude Code in a microVM on your Mac. Each project folder gets its own sandbox with Claude Code, git, the GitHub CLI, the AWS CLI, Terraform, pnpm and its own Docker engine. Claude works on the folder you start it in and sees nothing else on the Mac.

portable is a thin layer over [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/). A proxy on the Mac decides which hosts a sandbox may reach and adds your credentials to requests, so tokens never enter the VM. portable adds the tools, your Claude configuration repo, Keychain-backed secrets, AWS SSO credentials, ports that keep their number, a page for each environment, the `/start`, `/stop` and `/ui` skills, and `portable doctor`. A project needs no files added to it.

This is a work in progress, built for convenience.

## Contents

- [Setup](#setup)
- [Daily use](#daily-use)
- [The environment page](#the-environment-page)
- [AWS](#aws)
- [What the sandbox can reach](#what-the-sandbox-can-reach)
- [Settings](#settings)
- [Updating](#updating)
- [Working on portable](#working-on-portable)
- [Removing it](#removing-it)

## Setup

You need an Apple silicon Mac on macOS 14 or later, a Docker account and a Claude subscription or API key. Docker Desktop is not needed. The AWS CLI is only needed if you turn AWS on later.

### 1. Install

```sh
cd ~/Projects
git clone https://github.com/jamesSaporito/portable.git
cd portable
./install.sh
```

The script asks before each step. It:

1. Clones portable's installed copy into `~/.local/share/portable`. Your clone in `~/Projects` stays yours to work on.
2. Installs portable's own Node 26 into `~/.local/share/portable-node`, then Docker Sandboxes with `brew install docker/tap/sbx`, installing Homebrew first if needed. Then it signs you in to Docker.
3. Links the `portable` command into `~/.local/bin` and adds that folder to your PATH.
4. Creates `~/.config/portable/config.json` and asks for your Claude configuration repo, for example `https://github.com/jamesSaporito/claude-configuration.git`. Leave it blank to skip.
5. Runs `portable configure`, which asks for a GitHub token. See step 3 below.

Open a new terminal and run `portable -v` to confirm the command is on your PATH.

### 2. Sign in to Claude

```sh
cd ~/Projects/my-app
portable claude
```

The first `portable` in a folder creates its sandbox, which takes a few minutes the very first time. When Claude starts, type `/login` and sign in with your Claude account in the browser. This is once per Mac. sbx keeps the token on the Mac and the sandbox only sees a placeholder.

To use an API key instead, run `sbx secret set anthropic`.

### 3. Add a GitHub token

Public repos clone without a token. Pushing and `gh` need one.

1. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens** and generate a new token.
2. **Resource owner:** your account. **Expiration:** 90 days works well.
3. **Repository access:** only select repositories. Pick your Claude configuration repo and every repo Claude should work on.
4. **Permissions:** Contents read and write, Pull requests read and write.
5. Run `portable configure`. Answer yes to "Store it now?" and paste the token into the Keychain prompt, twice.

The token goes in your Keychain and sbx reads it from there. A fine-grained token covers one owner, so a token for your account can't reach an organization's repos.

To replace the token later, run `portable configure` again. Existing sandboxes use the new one without a restart, though sbx may keep the old one for up to 55 minutes ([Docker docs](https://docs.docker.com/ai/sandboxes/configuration/credentials/)).

### 4. Check the setup

```sh
portable doctor
```

It checks the Mac first, then creates a throwaway sandbox and checks it: what it can see, that no real token is readable, the tools, your Claude configuration, that Claude, GitHub and AWS answer, Docker, port forwarding, the page and the network policy. Each line says `ok`, `warn`, `skip` or `FAIL`. The sandbox half takes a while. `portable doctor --no-sandbox` runs only the Mac checks.

## Daily use

```sh
portable                 # Shell in the folder's sandbox
portable claude          # Claude Code in it
portable exec <command>  # One command in it, e.g. portable exec terraform plan
portable ports           # Which ports of the sandbox are open on the Mac, and where
portable ui              # Start the environment without a shell and open its page
portable ps              # Every sandbox: name, status, ports, page, folder
portable stop NAME       # Pause a sandbox. Its data stays
portable rm NAME         # Delete a sandbox with its Docker data and Claude history
portable prune           # Delete every stopped sandbox, after asking
portable configure       # Store or replace secrets
portable update          # Update portable from GitHub
portable help            # Every command
```

Claude asks before running commands and editing files. That holds for `portable claude` and for `claude` typed in a `portable` shell. Bypass mode is one Shift+Tab away but never on at the start. To start in another mode, pass a flag: `portable claude --permission-mode acceptEdits`, or `portable claude --dangerously-skip-permissions` for no prompts.

### What Claude can see

A session sees only the folder you run `portable` in:

```sh
cd ~/Projects && portable claude          # every project, in one sandbox
cd ~/Projects/my-app && portable claude   # only my-app, in its own sandbox
```

`portable` refuses to start in your home folder, in `/Users` or `/`, in dot folders like `~/.ssh` or `~/.config`, inside its own installed copy, or inside your Claude configuration repo.

### Several agents

Each folder has one sandbox, and `portable` in the same folder joins it from as many terminals as you like. For agents on separate branches, give each a git worktree and add `.claude/worktrees/` to the project's `.gitignore`:

```sh
portable claude --worktree feature-1   # terminal 1
portable claude --worktree feature-2   # terminal 2
```

For a second sandbox on the same folder, name it:

```sh
portable --name api claude
portable ports api
portable stop api
```

Each sandbox has 4 CPUs and 8 GiB of memory unless its settings say otherwise.

## The environment page

Every running environment has a page on `127.0.0.1`. `portable ui` opens it, `portable` and `portable claude` print its address each time, and `/ui` in Claude gives the link. Only this Mac can reach it, and every request needs the token in the URL, which your browser remembers.

- **Ports:** each forward, a link to open it, and the Mac port it sticks to, which you can change or forget.
- **Services:** the compose files in the folder and two levels below, with their containers. Start, restart, stop and follow logs.
- **Network:** this environment's extra allowed hosts, every host the sandbox can reach, and every host it tried that was refused. Search a host or URL to see which rule applies, and allow or dismiss a blocked host.
- **Sandbox settings:** CPUs and memory. They apply when the sandbox is recreated.
- **AWS:** see [AWS](#aws).
- **Claude configuration:** the configuration repo, its commit, an update button, a checkbox for each skill and rule, and whether each token is stored and Claude is signed in.
- **Activity:** what portable did for this environment.

## AWS

AWS is off until you turn it on for an environment, in the **AWS** section of its page:

1. Install the AWS CLI with `brew install awscli` and set up a profile with `aws configure sso`.
2. Pick the profile on the page and click **Turn on**.
3. If the profile is signed out, click **Sign in**. `aws sso login` runs on your Mac and opens the browser.

Each `portable` start then writes about an hour of temporary credentials into the sandbox. Your SSO login stays on the Mac. When the credentials expire, click **Refresh credentials** or run `portable` again. **Turn off** clears them.

The sandbox has credentials but no profiles, so if your Terraform sets `profile = "..."` in the AWS provider, remove it or make it a variable.

## What the sandbox can reach

| | Inside the sandbox |
|---|---|
| Your files | Only the folder you run `portable` in, at the same path as on the Mac. Containers Claude starts see the same folder and nothing else |
| Docker | The sandbox's own engine. Images, containers and volumes stay until you delete the sandbox |
| Claude | Signed in once per Mac. The sandbox sees a placeholder |
| GitHub | Your token, added by the proxy to requests to GitHub. The sandbox sees a placeholder |
| AWS | Off unless turned on for the environment, then about an hour of temporary credentials |
| Claude settings | Your skills, rules and `CLAUDE.md` from your configuration repo, minus any turned off on the page, plus portable's `/start`, `/stop` and `/ui` |
| The internet | Only the allowed hosts below. Everything else is refused, for Claude and for the containers it starts |

### Network

sbx sends every outbound TCP connection through the Mac and refuses destinations no rule allows. UDP and ICMP are blocked. Allowed:

- **sbx's own defaults:** about 200 hosts for AI services, package managers, code hosting, cloud providers and OS packages.
- **portable's kit** in `kit/portable.yaml`: GitHub, npm, Terraform's registry and HashiCorp releases, Docker Hub, the Alpine and Debian mirrors, `*.amazonaws.com`, and the MCP servers for Atlassian, GitHub and AWS documentation. MCP servers still have to be added to Claude with `claude mcp add`.
- **Your extra hosts:** per environment on its page under **Network**, or for every environment with `allowDomains` in `config.json`.

A rule covers one port, so a host allowed for HTTPS is still refused over `http://`. A blocked host fails fast and shows on the page. The sandbox's `CLAUDE.md` tells Claude to report a blocked host rather than work around it.

### Docker

Each sandbox has its own Docker engine, so Claude can `docker compose up` a project and run its tests. Bind mounts work unchanged since the folder has the same path.

- **Ports:** a port a container publishes on all interfaces, like `-p 3000:80`, is forwarded to the Mac's `127.0.0.1` within a few seconds, at the same number when it's free and otherwise the next free one. It then sticks, so the environment uses that Mac port every time. `portable ports`, `portable ps`, the page and `/start` list them.
- **Lifetime:** a sandbox keeps running after your session ends, with whatever Claude started. `portable stop NAME` pauses it.
- **Node projects:** the folder's `node_modules` holds your Mac's install, with native binaries built for it. The sandbox's `CLAUDE.md` tells Claude to run installs and tests through the project's compose services, never against the shared folder.

### Limits

- AWS credentials are in the VM for their hour. Use a profile with only the permissions the project needs.
- An allowed service can still receive data: a push to any GitHub repo your token covers, a package publish, an upload to any S3 bucket.
- The workspace is a two-way channel. Anything a session writes in the project runs on your Mac if you run it there: `.git/hooks`, `.git/config`, `node_modules/.bin`, package scripts, Makefiles. After an unattended run, read those paths the way you'd read a pull request.
- Your GitHub token decides what a session can change. `portable update` and your configuration repo's `./install.sh update` run what's on those repos' default branches, so protect both with a GitHub ruleset that blocks direct pushes.
- The VM is the boundary. See Docker's [security model](https://docs.docker.com/ai/sandboxes/security/) for what sbx guarantees.

## Settings

`~/.config/portable/config.json` holds the defaults for every environment. An environment's page can override some of them, and those overrides live in `~/.config/portable/envs/`, one file per environment, next to its sticky ports.

| Setting | What it does | Per environment |
|---|---|---|
| `workspaceDir` | Empty, the default, lets `portable` run in any project folder. Set it to `~/Projects` to allow only that folder and the ones inside it | No |
| `claudeConfigRepo` | Your Claude configuration repo as an HTTPS URL. Cloned into each sandbox and updated at every boot. Also settable on any page | No, one for all |
| `claudeConfigDisable` | Skills or rules to turn off in sandboxes, like `["docker-ports"]` | Yes, as checkboxes |
| `allowDomains` | Extra hosts sandboxes may reach, like `["pypi.org"]` | Yes, added to these |
| `awsProfile` | The Mac's AWS profile to use. AWS is off until a page turns it on | Per environment only |
| `cpus`, `memory` | The size of each VM, default 4 and `8g`. Fixed when a sandbox is created | Yes |

The shell variables `WORKSPACE_DIR`, `PORTABLE_CLAUDE_CONFIG_REPO`, `PORTABLE_CLAUDE_CONFIG_DISABLE` and `PORTABLE_ALLOW_DOMAINS` override `config.json`. Commits use the `user.name` and `user.email` from your Mac's git config.

### Carrying settings to another Mac

Nothing in `~/.config/portable` is secret or Mac-specific, so it can live in a private git repo. Create an empty private repo on GitHub, then:

```sh
cd ~/.config/portable
git init && git add . && git commit -m "portable settings"
git remote add origin https://github.com/you/portable-settings.git
git push -u origin main
```

On the other Mac, install with it:

```sh
./install.sh --settings https://github.com/you/portable-settings.git
```

Environments are keyed by folder path, so they match when your projects live at the same paths on both Macs. Push after changing settings on a page.

### Changing your Claude configuration

The configuration repo is cloned read-only into each sandbox, so changes go through GitHub:

1. Make the change in a clone of the repo and open a pull request. Claude can do this from a sandbox.
2. Merge it.
3. On your Mac, run `./install.sh update` in that repo's clone.
4. Sandboxes pick it up at their next boot. `portable stop NAME` followed by `portable` forces one.

## Updating

```sh
portable update
```

It lists the new commits on GitHub and moves the installed copy to them. When the kit changed, the next `portable` in each environment offers to update its sandbox in place, keeping its Docker data and Claude history. `portable doctor` warns when an update is waiting.

Run `./install.sh` again to move portable's Node to the newest patch release.

## Working on portable

Work in your clone, for example `~/Projects/portable`, and merge changes on GitHub. `portable update` then brings them to the installed copy. To try a change first, run the clone directly: `~/Projects/portable/bin/portable doctor`.

```sh
npm test            # Unit and API tests
npm run lint        # Syntax check of every script
npm run test:ui     # Browser tests for the page, with Playwright and your Google Chrome. Run npm install first
```

These need a Node on your PATH. portable's own is at `~/.local/share/portable-node/current/bin`.

Tool versions and the base image digest are pinned in `kit/portable.dockerfile`, each with its SHA-256. Change both together. `engines.node` in `package.json` sets the Node line for `install.sh` and `portable doctor`. Claude Code comes from sbx's built-in `claude` agent, so its version follows sbx.

## Removing it

```sh
cd ~/Projects/portable
./uninstall.sh
```

It asks before each step and is safe to re-run. It can delete portable's sandboxes with their Docker data and Claude history, the GitHub token source in sbx, your Keychain secrets, portable's Node, the `portable` command and its PATH line, the installed copy and your settings. `./uninstall.sh --yes` answers yes to everything. It never touches your project folders, other sandboxes or sbx itself.
