# portable

Note: This is still a work in progress. Its usefulness is purely for convenience.

Claude Code in a microVM on your Mac, so it can work on projects without running anything on the Mac itself. Each project folder gets its own sandbox with Claude Code, git, the GitHub CLI (`gh`), the AWS CLI, Terraform, pnpm and its own Docker engine with Compose, plus a local page to see its ports and services and change its settings.

portable is a thin layer over [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/). Each folder gets its own VM, and a proxy on the Mac decides what it may reach and adds your credentials to requests, so tokens never enter the VM. portable adds the tools, your Claude configuration repo, Keychain-backed secrets, the AWS SSO handoff, ports that keep their number, the page, `/start` and `/stop`, and `portable doctor`. There's nothing to add to a project: an environment is just a folder.

## Contents

- [Getting started](#getting-started)
  - [Requirements](#requirements)
  - [1. Install](#1-install)
  - [2. Sign in to Claude](#2-sign-in-to-claude)
  - [3. GitHub token (optional)](#3-github-token-optional)
  - [4. Check the setup](#4-check-the-setup)
- [Daily use](#daily-use)
  - [Choosing what Claude can see](#choosing-what-claude-can-see)
  - [Running several agents](#running-several-agents)
- [The environment page](#the-environment-page)
- [AWS (optional)](#aws-optional)
- [What the sandbox can and can't reach](#what-the-sandbox-can-and-cant-reach)
  - [Limits](#limits)
  - [Network](#network)
  - [Docker](#docker)
- [Settings](#settings)
  - [Carrying settings to another Mac](#carrying-settings-to-another-mac)
  - [Changing your Claude configuration](#changing-your-claude-configuration)
- [Updating](#updating)
  - [Changing portable itself](#changing-portable-itself)
  - [Node](#node)
- [Removing it](#removing-it)

## Getting started

### Requirements

- An Apple silicon Mac on macOS 14 or later ([sbx install docs](https://docs.docker.com/ai/sandboxes/install/)).
- A Docker account. Docker Desktop is not needed.
- A Claude subscription, or an Anthropic API key. This has only been tested with Claude Code.


#### Optional
- AWS CLI, only if you want AWS access.

`install.sh` offers to install anything else (Homebrew, sbx, portable's own Node 26).

### 1. Install

```sh
cd ~/Projects
git clone https://github.com/jamesSaporito/portable.git
cd portable
./install.sh
```

`install.sh` asks before installing each piece. This does the following:

1. Installs portable in `~/.local/share/portable` (a clone of the same GitHub repo; the one you just made can then be worked on like any other project, see [Changing portable itself](#changing-portable-itself)).
2. Offers to install [Homebrew](https://brew.sh/) if sbx or the AWS CLI needs it, Node 26 used for portable only (in `~/.local/share/portable-node`, and Docker Sandboxes (`brew trust docker/tap && brew install docker/tap/sbx`), then signs you in to Docker. Say no to any of them and it stops, telling you what to install yourself.
3. Links the `portable` command into `~/.local/bin` and adds that folder to your PATH.
4. Creates `~/.config/portable/config.json` and asks for your Claude configuration repo, e.g. `https://github.com/jamesSaporito/claude-configuration.git`.
5. Runs `portable configure` to store the GitHub token.

Open a new terminal afterwards so `portable` and confirm portable is on your path by running `portable -v`.

### 2. Sign in to Claude

```sh
cd ~/Projects/sandbox # sandbox can be replaced with any project you want to work on
portable claude
```

The first time, type `/login` and sign in with your Claude account in the browser. You only do this once per Mac: sbx keeps the token on the Mac and the sandbox only sees a placeholder ([Docker docs](https://docs.docker.com/ai/sandboxes/configuration/credentials/)). To use an API key instead (billed per use in the [Claude Console](https://platform.claude.com)), run `sbx secret set anthropic`.

The first `portable` in a folder creates its sandbox, which takes a few minutes the very first time. When running this again in the same directory, it reattaches to the existing sandbox.

### 3. GitHub token (optional)

Without a token, public repos still clone, but `git push` and `gh` in the sandbox need one.

1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
2. **Resource owner:** your account. **Expiration:** e.g. 90 days.
3. **Repository access:** *Only select repositories*: `claude-configuration` and every repo Claude should work on.
4. **Permissions:** *Contents* read and write, *Pull requests* read and write.
5. Generate it, then run `portable configure`. It asks "Store it now? [y/N]" and opens the Keychain's hidden prompt, which asks for the value twice.

To replace the token, run `portable configure` again. Existing sandboxes use the new one without a restart, though sbx caches the old one for up to 55 minutes ([Docker docs](https://docs.docker.com/ai/sandboxes/configuration/credentials/)). If cloning your configuration repo failed for lack of a token, the next start of the sandbox clones it. A fine-grained token reaches one owner only (your account or one organization). See [Limits](#limits) for why the default branches of portable and your configuration repo should be protected.

### 4. Check the setup

```sh
portable doctor
```

It checks this Mac (sbx and its sign-in, portable's Node, `config.json`, the kit, the Keychain tokens, your git identity, AWS profiles, whether portable is current), then creates a throwaway sandbox and checks it: what it can see, that no real token is readable, the tool versions, your Claude configuration, that Claude, GitHub and AWS answer, Docker, port forwarding, the page, and the network policy. Each line says `ok`, `warn`, `skip` or `FAIL`. The sandbox half takes a while; `portable doctor --no-sandbox` runs only the Mac checks. The Claude check sends a tiny prompt and needs the `/login` from step 2.

It can't check pushing without changing a repo: push a branch to a repo your token covers, and check a push to one it doesn't cover is refused.

## Daily use

```sh
portable                 # Shell in the folder's sandbox
portable claude          # Claude Code in it
portable exec <command>  # e.g. portable exec terraform plan
portable ports           # Which ports of the folder's sandbox are open on the Mac, and where
portable ui              # Bring the folder's environment up (no shell or Claude) and open its page
portable configure       # Store or replace the secrets portable uses
portable -v              # portable's version and commit, e.g. portable x.x.x (abc123)
portable help            # Every command
```

Claude asks before running commands and editing files, since a sandbox limits what Claude can reach but not what it spends. That holds both for `portable claude` and for `claude` typed in a `portable` shell. Bypass mode stays one Shift+Tab away but is never on at the start. Pass a permission flag to start in another mode, e.g. `portable claude --permission-mode acceptEdits`, or `portable claude --dangerously-skip-permissions` for no prompts.

### Choosing what Claude can see

A session sees only the folder you run `portable` in:

```sh
cd ~/Projects && portable claude          # every project, one sandbox for all of them
cd ~/Projects/my-app && portable claude   # only my-app, in its own sandbox
```

`portable` refuses to start in a folder that holds your home folder (`~`, `/Users`, `/`), in your home's settings (`~/.ssh`, `~/.aws`, `~/.config`, `~/Library` and other dot folders), outside `workspaceDir` when you've set one, inside the copy of portable that's running, or inside the configuration repo your Mac's `~/.claude` links into.

### Running several agents

Each folder has one sandbox. `portable` in the same folder joins it from as many terminals as you like. Agents in one sandbox share its Docker engine, so the `docker-ports` skill keeps their stacks on different ports.

#### Worktrees
Give each agent its own git worktree (the repo needs at least one commit), and add `.claude/worktrees/` to the project's `.gitignore`:

```sh
cd ~/Projects/my-app
portable claude --worktree feature-1  # terminal 1
portable claude --worktree feature-2  # terminal 2
```

Each works on its own branch in its own folder.

**Different repos:** start each agent from a different folder; each gets its own sandbox. If two publish the same port, the second gets the next free number on the Mac, which `portable ports` and `/start` report.

**Naming, listing, stopping, deleting:**

```sh
portable --name api claude   # a separate sandbox on the same folder, named api
portable ps                  # sandboxes: name, status, ports (sandbox→Mac), page, folder
portable ports api           # forward and list the ports of api
portable stop api            # pause it; its data stays
portable rm api              # delete it with its Docker data and Claude history (its settings and ports stay)
portable prune               # delete every stopped one, after asking
```

Each sandbox has 4 CPUs and 8 GiB of memory unless its settings say otherwise; `sbx` with no arguments shows live usage.

## The environment page

Every running environment has its own page on `127.0.0.1`. `portable ui` opens it (creating or starting the environment if needed, without a shell or Claude); `portable` and `portable claude` open it by themselves when they create a sandbox, and print its address each time. Inside Claude, `/ui` gives the link. Only this Mac can reach the page, and every request needs the token in the URL `portable ui` prints, which the browser remembers.

- **Ports:** each forward, a link to open it, and its sticky host port, which you can change or forget.
- **Services:** the compose files in the folder (and two levels below), with their containers. Start, restart, stop and follow logs, in the sandbox's own Docker.
- **Network:** this environment's extra allowed hosts, then every host the sandbox can reach and every host it tried that was refused, with each rule's port, where it comes from (sbx's defaults, the kit, this environment) and whether it's allowed or blocked. Type a host, URL or `host:port` in the search to see whether it would be allowed and by which rule. Allow or dismiss a blocked host from the list.
- **Sandbox settings:** CPUs and memory (they apply when the sandbox is recreated; the page says how).
- **AWS:** see [AWS](#aws-optional).
- **Claude configuration:** the configuration repo's URL (the same for every environment), its commit, an update button, and a checkbox for each skill and rule.
- **Secrets:** whether each token is stored and read by sbx, and whether Claude is signed in. Never the values.
- **Activity:** what the agent did (forwards, settings saved, hosts allowed).

## AWS (optional)

AWS is off until you turn it on for an environment, in the **AWS** section of its page (`portable ui`):

1. Pick one of your Mac's AWS profiles and click **Turn on**. The AWS CLI has to be installed (`brew install awscli`) and the profile set up (`aws configure sso`).
2. If the profile is signed out, click **Sign in**: `aws sso login` runs on your Mac and opens the browser.

Each `portable` start then writes about an hour of temporary credentials into the sandbox; your SSO login stays on the Mac. When they expire, click **Refresh credentials**, or exit and run `portable` again. **Turn off** clears them. If your Terraform sets `profile = "..."` in the AWS provider, remove it or make it a variable: the sandbox has no profiles, only the credentials.

## What the sandbox can and can't reach

| | Inside the sandbox |
|---|---|
| Your files | Only the folder you run `portable` in, at the same path as on your Mac. No home folder, `~/.ssh`, `~/.aws` or Docker socket. Containers Claude starts see the same folder and nothing else |
| Docker | The sandbox's own engine. Images, containers and volumes stay until you delete the sandbox |
| Claude | Signed in once per Mac with `/login`; the sandbox sees a placeholder |
| GitHub | Your fine-grained token, added by the proxy to requests to GitHub; the sandbox sees a placeholder |
| AWS | Off unless turned on for the environment; then about an hour of temporary credentials |
| Claude settings | Your skills, rules and `CLAUDE.md` from your configuration repo (minus any turned off on the page), plus portable's `/start`, `/stop` and `/ui` |
| The internet | Only the allowed hosts (see [Network](#network)). Everything else is refused, for Claude and the containers it starts |

### Limits

What the sandbox doesn't protect:

- **AWS credentials are in the VM** for their hour. Use a profile with only the permissions the project needs.
- **An allowed service can still receive data:** a push to any GitHub repo, a package publish, an upload to any S3 bucket. The network policy stops accidents and unknown hosts, not a deliberate attempt through an allowed one.
- **The workspace is a two-way channel.** Anything a session writes in the project runs on your Mac if you run it there: `.git/hooks`, `.git/config`, `node_modules/.bin`, package.json scripts, Makefiles, editor tasks. After an unattended run, look at those paths the way you'd read a pull request. Git hooks don't show in `git diff`.
- **Your GitHub token decides what a session can change.** It shouldn't be able to push to the default branch of `jamesSaporito/portable` or `jamesSaporito/claude-configuration` without review, since `portable update` and `./install.sh update` run what's on those branches. Protect both with a GitHub ruleset that blocks direct pushes and allows no bypass.
- The VM is the boundary; see Docker's [security model](https://docs.docker.com/ai/sandboxes/security/) for what sbx guarantees.

### Network

sbx sends every outbound TCP connection through the Mac and refuses destinations no rule allows; UDP and ICMP are blocked ([Docker docs](https://docs.docker.com/ai/sandboxes/security/)). Allowed:

- **sbx's own defaults:** about 200 hosts for AI services, package managers, code hosting, cloud providers and OS packages, mostly HTTPS only.
- **portable's kit** (`kit/portable.yaml`): GitHub; npm; Terraform's registry and HashiCorp releases; Docker Hub; the Alpine and Debian mirrors; AWS (`*.amazonaws.com`, so every AWS API works); and the MCP servers for Atlassian (`mcp.atlassian.com`), GitHub (`api.githubcopilot.com`) and AWS docs (`knowledge-mcp.global.api.aws`, plus `docs.aws.amazon.com`, `proxy.search.docs.aws.com` and `api.contentrecs.docs.aws.com` for the local AWS Documentation server). MCP servers still have to be added to Claude with `claude mcp add`.
- **Your extra hosts:** per environment on its page (**Network → Extra allowed hosts**, e.g. `pypi.org` and `files.pythonhosted.org`), or for every environment with `allowDomains` in `config.json`. They're added to that one sandbox only.

A rule covers only its port: a host allowed for HTTPS (443) is still refused over `http://`. A blocked host fails with "connection refused" or a TLS error and shows on the page; the sandbox's `CLAUDE.md` tells Claude to report it rather than work around it.

### Docker

Each sandbox has its own Docker engine. Claude can `docker compose up` a project and run its tests, and bind mounts work unchanged since the folder has the same path.

- **Ports:** a port a container publishes (TCP, on all interfaces, e.g. `-p 3000:80`) is forwarded to your Mac's `127.0.0.1` within a few seconds, at the same number when it's free, otherwise the next free one. Then it **sticks**: the environment uses that host port every time. `portable ports`, `portable ps` and the page list them, and `/start` reports the URLs.
- **Data:** images, containers and volumes survive stops and restarts; `portable rm` deletes them with the sandbox.
- **Lifetime:** a sandbox keeps running after your session ends, with whatever Claude started. `portable ps` lists them, `portable stop api` pauses one.
- **Node projects:** the folder's `node_modules` holds your Mac's install, with native binaries built for it. Run installs and checks through the project's compose services, with `node_modules` in a volume, rather than over it from the sandbox. The sandbox's `CLAUDE.md` tells Claude this.

## Settings

`~/.config/portable/config.json` holds the defaults for every environment. An environment's page can override some of them; those overrides live in `~/.config/portable/envs/`, one file per environment (e.g. `my-app.json`), next to its sticky ports.

| Setting | What it does | Per environment |
|---|---|---|
| `workspaceDir` | Empty (the default) lets `portable` run in any project folder. Set it, e.g. to `~/Projects`, to only allow that folder and the ones inside it | No |
| `claudeConfigRepo` | Your Claude configuration repo as an HTTPS URL, e.g. `https://github.com/jamesSaporito/claude-configuration.git`. Cloned into each sandbox and updated at every boot. Also settable on any page | No, one for all |
| `claudeConfigDisable` | Skills or rules to turn off in sandboxes, e.g. `["docker-ports"]` | Yes, as checkboxes on the page |
| `allowDomains` | Extra hosts sandboxes may reach, e.g. `["pypi.org"]` | Yes, added to these |
| `awsProfile` | The Mac's AWS profile to use, e.g. `default`. AWS is off until a page turns it on | Per environment only |
| `cpus`, `memory` | The size of each VM (default 4 and `8g`), fixed when a sandbox is created | Yes |

`WORKSPACE_DIR`, `PORTABLE_CLAUDE_CONFIG_REPO`, `PORTABLE_CLAUDE_CONFIG_DISABLE` and `PORTABLE_ALLOW_DOMAINS` in your shell override `config.json`. Commits use the `user.name` and `user.email` from your Mac's git config.

Each time you run `portable`, it applies the environment's allowed hosts, writes fresh AWS credentials if AWS is on, tells the sandbox about changed skills and rules, and starts the environment's page and port forwarding if they aren't running. Each time a sandbox boots, it updates your Claude configuration repo from GitHub (for the next session; the existing copy is used if GitHub can't be reached).

### Carrying settings to another Mac

Nothing in `~/.config/portable` is secret or Mac-specific, so it can be a private git repo your Macs share. Create an empty private repo on GitHub, e.g. `portable-settings`, then:

```sh
cd ~/.config/portable
git init && git add . && git commit -m "portable settings"
git remote add origin https://github.com/jamesSaporito/portable-settings.git
git push -u origin main
```

On the other Mac, install with it:

```sh
./install.sh --settings https://github.com/jamesSaporito/portable-settings.git
```

Environments are keyed by folder path, so they match when your projects live at the same paths on both Macs. Commit and push after changing settings on a page; `install.sh` doesn't push for you.

### Changing your Claude configuration

Your Mac's `~/.claude` links into the configuration repo's installed copy in `~/.local/share/claude-configuration`, so changes go through GitHub:

1. Make the change in a clone (e.g. `~/Projects/claude-configuration`, or let Claude do it in the sandbox) and open a PR.
2. Merge it.
3. On your Mac, run `./install.sh update` in your clone, then start new Claude sessions.
4. Sandboxes pick it up at their next boot (`portable stop api`, then `portable`, forces one).

## Updating

```sh
portable update
```

It lists the new commits on GitHub and moves the installed copy to them. When the kit changed, the next `portable` in each environment offers to update its sandbox in place, keeping its Docker data and Claude history. `portable doctor` warns when an update is waiting.

Tool versions (`TERRAFORM_VERSION`, `GH_VERSION`, `PNPM_VERSION`, `AWS_CLI_VERSION`) and the base image digest are pinned in `kit/portable.dockerfile`, each with its SHA-256; change both together. Claude Code comes from sbx's built-in `claude` agent, so its version follows the installed sbx.

### Changing portable itself

Work in your clone (`~/Projects/portable`), in portable like any other project, and merge the change on GitHub; then `portable update` brings it to the installed copy. To try a change before merging, run the clone directly, e.g. `~/Projects/portable/bin/portable doctor`; that runs outside the sandbox, so read what a session changed first.

- `npm test`: unit and API tests (Node's built-in runner).
- `npm run lint`: syntax check of every script (`npm run lint -- js` or `-- sh` for one kind).
- `npm run test:ui`: browser tests for the page (`test/ui/`), with Playwright and your installed Google Chrome. Run `npm install` once first.

They need a Node on your PATH; portable's own is at `~/.local/share/portable-node/current/bin`. Bump `version` in `package.json` when a change is worth telling apart.

### Node

portable runs on its own Node in `~/.local/share/portable-node`. `install.sh` downloads the newest 26.x from [nodejs.org/dist/latest-v26.x](https://nodejs.org/dist/latest-v26.x/). It isn't put on your PATH, so any other Node stays as it is. Run `install.sh` again for patch updates. `engines.node` in `package.json` sets the line, for `install.sh` and `portable doctor` both.

## Removing it

```sh
cd ~/Projects/portable
./uninstall.sh
```

It asks before each step and is safe to re-run. It can delete portable's sandboxes along with their Docker data and Claude history, the GitHub token source in sbx, your Keychain secrets, the leftovers of the old Docker Desktop–based portable, portable's Node, the `portable` command and its PATH lines (backing up `~/.zshrc` to `~/.zshrc.portable-backup`), the installed copy and your settings. `./uninstall.sh --yes` answers yes to everything. It never touches your project folders, other sandboxes or sbx itself (`brew uninstall sbx`).
