# portable

Claude Code in a Docker container, so it can work on projects without running anything on your Mac. One command sets it up on any computer. The image includes Claude Code, git, the GitHub CLI (`gh`), the AWS CLI, Terraform, pnpm and Docker with Compose.

Docker inside the container talks to portable's own Docker engine, not the one on your Mac, so Claude can boot a project with `docker compose up` and run its tests.

Secrets never go into the image. They stay in your Mac's Keychain and are passed to the container each time it starts.

## What the container can and can't reach

| | Inside the container |
|---|---|
| Your files | Only the folder you run `portable` in, which must be your workspace folder (`WORKSPACE_DIR`, default `~/Projects/sandboxed`) or a folder inside it (see [Choosing what Claude can see](#choosing-what-claude-can-see)). It's mounted at the same path it has on your Mac (e.g. `/Users/you/Projects/sandboxed/my-app`), so paths match on both sides. Nothing else on your Mac: no home folder, `~/.ssh`, `~/.aws` or Docker socket. The folders above it exist only as empty folders. Your Claude configuration repo stays hidden even when it's inside it |
| Docker | portable's own engine (see [Docker](#docker)). Containers it starts see the whole workspace folder (minus the hidden folders) and nothing else on your Mac. Their published ports are on `localhost` |
| Claude | Your subscription token or API key, from the Keychain |
| GitHub | A fine-grained token from the Keychain, limited to the repos you choose. git uses it over HTTPS |
| AWS | Temporary credentials (about 1 hour) made from an AWS profile on your Mac. Your SSO login stays on the Mac |
| Claude settings | Your skills, rules and `CLAUDE.md` from your configuration repo, plus your Mac's `~/.claude/settings.json` (without hooks). portable adds its own `/start` and `/stop` skills, which boot and stop a workspace project's `docker compose` stack in the engine |
| The internet | Only what's listed below. Everything else is refused |

Anything the container has can still be read by code running inside it, so keep tokens narrow and short-lived.

### Outbound firewall

The Docker engine sets up an nftables firewall before it starts. The container shares the engine's network, so the same rules cover the container, the engine (pulling images) and every container Docker starts. The container switches to the `dev` user with every capability dropped, so nothing in it can change the rules. It allows:

- **Claude Code, npm, Terraform, Docker Hub and the Alpine and Debian package mirrors:** the hosts in `image/allowed-domains`. They're looked up again every 5 minutes, since their addresses change.
- **GitHub:** the web, API and git ranges GitHub publishes.
- **AWS:** the ranges AWS publishes for your region (`AWS_REGION`, default `us-east-1`) and its global services such as IAM and STS. Ranges for servers and sites anyone can rent (EC2, CloudFront, API Gateway, Global Accelerator) are left out, so code can't send data to an arbitrary server hosted on AWS.

Some AWS APIs share addresses with EC2 and are blocked by that last rule. Lambda and Secrets Manager are two of them. Add the ones you use to `PORTABLE_ALLOW_DOMAINS`, e.g. `lambda.us-east-1.amazonaws.com`.

Its limits:
- The engine is privileged, so code that can use Docker can also undo the rules, for example by starting a privileged container on the engine's network. The firewall stops accidents and ordinary traffic, not a deliberate attempt. See [Docker](#docker).
- DNS isn't filtered, so data could still leave through DNS lookups.
- An allowed service can still receive data, for example a push to a GitHub repo your token covers, or an upload to an S3 bucket.
- IPv6 is refused entirely.

### Docker

Claude runs Docker against portable's own engine, a second container (`portable-engine`) that runs `docker:dind`, the official Docker-in-Docker image. Every session shares it, the way several terminals share Docker on your Mac. It starts with the first `portable` and keeps running, with whatever Claude started, after sessions end.

- **Files:** the engine mounts the whole workspace folder at its Mac path, so bind mounts in a project's compose file (`./src:/app`) work unchanged, whichever folder a session started in. That also means Claude can reach the whole workspace folder through Docker, even from a session started further in; `image/claude-instructions.md` tells it to stay in its own folder unless you ask.
- **Ports:** the container shares the engine's network, so a port a project publishes is on `localhost`, as on your Mac. To open them on your Mac too, list them in `PORTABLE_PORTS`: the engine publishes each one on your Mac's `127.0.0.1` with the same number, so built-in `localhost` URLs work in your browser and TablePlus. It holds them while it runs, so the Mac can't use them for anything else, such as the same project run on the Mac, and the engine won't start if one is already taken. A changed list applies when no session is running.
- **Data:** images, containers and their volumes (databases, for example) are kept in the `portable_docker-data` volume, so they survive restarts.
- **Updates:** when the engine's image or settings change, it's recreated at the next `portable` with no other session running, since recreating it cuts running sessions off the network. Containers it was running stop then; those with a restart policy (e.g. `restart: unless-stopped`) come back. Until then `portable` says an update is waiting.

- **Node projects:** the workspace's `node_modules` holds your Mac's install, with macOS-only native binaries. Installing over it from the container would swap in Linux ones and break the project on your Mac until you reinstall there. Run installs and checks through the project's compose services instead, with `node_modules` in a volume. `image/claude-instructions.md` tells Claude this, and about the firewall and the separate engine; it's installed as the container's managed `CLAUDE.md`.

The engine has to run **privileged**, since nested containers need it. That's a weaker boundary than the rest of portable: code with Docker access could use a privileged container to break out into Docker Desktop's Linux VM, which can see your Mac's shared folders. The engine keeps projects away from your Mac's Docker and limits what they see, but it doesn't stop code that's deliberately trying to escape.

## Requirements

- macOS. Secrets use the macOS Keychain.
- Docker Desktop, installed and running.
- The AWS CLI on your Mac, only if you want AWS access (`brew install awscli`).
- A Claude Pro or Max subscription, or an Anthropic API key.

## Setup

### 1. Clone and install

```sh
git clone <this repo>
cd ~/path/to/this/repo
./install.sh
```

`install.sh` is safe to re-run. It:

1. Installs portable in `~/.local/share/portable`, a clone of the same GitHub repo, and continues with that copy. That's the copy `portable` runs, kept outside any workspace, so the clone you started from can be worked on in portable like any other project (see [Changing portable itself](#changing-portable-itself)). Settings left in the clone's `.env` move to `~/.config/portable/.env`.
2. Checks that Docker is installed and running.
3. Links the `portable` command into `~/.local/bin` and adds that folder to your PATH in `~/.zshrc`.
4. Creates `~/.config/portable/.env` from `.env.example` if there isn't one.
5. Builds the images. The first build takes a few minutes.
6. Asks for any missing secrets (steps 2 and 3 below). You can skip them and add them later.

Open a **new terminal** afterwards so `portable` is on your PATH.

### 2. Claude credential

Pick one.

**Subscription (Pro or Max).** Run this on your Mac. It opens the browser and prints a token valid for one year ([docs](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)):

This does imply that we need claude set up on the host machine too, but this is

```sh
claude setup-token
# If you don't want to install Claude on your host machine, run the following instead:
# npx @anthropic-ai/claude-code setup-token 
portable secret set CLAUDE_CODE_OAUTH_TOKEN   # paste the token when asked
```

**API key.** Create a key in the [Claude Console](https://platform.claude.com). It's billed per use, separately from a subscription.

```sh
portable secret set ANTHROPIC_API_KEY
```

The subscription token can only send prompts; it can't read your account. So in the container, `/usage` shows your session's tokens but not your plan's limit bars (current session, current week). Check those in Claude on your Mac.

If both are stored, Claude Code uses the API key ([precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)). To remove one: `portable secret rm ANTHROPIC_API_KEY`.

### 3. GitHub token

1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
2. **Resource owner:** your account. **Expiration:** pick a limit, for example 90 days.
3. **Repository access:** *Only select repositories*. Include your Claude configuration repo (`claude-configuration`) and every repo Claude should work on.
4. **Permissions:** *Contents* read and write, *Pull requests* read and write.
5. Generate it and store it:

   ```sh
   portable secret set GH_TOKEN
   ```

A fine-grained token can reach one owner only (your account or one organization). It can't push to repos where you're an outside collaborator.

### 4. Settings (`.env`)

Edit `~/.config/portable/.env`. Every copy of portable uses it, the installed one and any clone you run directly. A value set in your shell takes precedence over it.

| Setting | What it does |
|---|---|
| `WORKSPACE_DIR` | The most the container can see: all your projects, e.g. `~/Projects`. Each session sees only the folder it's started in, here or below (see [Choosing what Claude can see](#choosing-what-claude-can-see)). `portable` refuses to start if it's `/`, your home folder, inside this project or your Claude configuration repo, or a path that would cover a system folder in the container (`/usr`, `/etc`, …) |
| `PORTABLE_AWS_PROFILE` | The AWS profile on your Mac to use, e.g. `default` or `Terraform`. Leave unset for no AWS access |
| `PORTABLE_CLAUDE_CONFIG_REPO` | Your Claude configuration repo. Cloned on first start and installed with its own `install.sh` |
| `PORTABLE_CLAUDE_CONFIG_DISABLE` | Skills or rules to turn off in the container, separated by spaces. Lines naming them are removed from the container's `CLAUDE.md` and rules |
| `GIT_NAME`, `GIT_EMAIL` | Commit identity. Defaults to your Mac's `git config --global user.name` and `user.email` |
| `ANTHROPIC_DEFAULT_MODEL` | The model Claude starts with in the container. Default `opus`, the same as a Pro or Max login on your Mac. `/model` still switches it |
| `PORTABLE_ALLOW_DOMAINS` | Extra hosts the firewall allows, separated by spaces, e.g. `pypi.org files.pythonhosted.org`, or `ghcr.io` for images from GitHub's registry |
| `PORTABLE_FIREWALL` | `off` turns the outbound firewall off |
| `PORTABLE_PORTS` | Ports to open on your Mac's `127.0.0.1`, separated by spaces, e.g. `3000 5432` (see [Docker](#docker)) |

### 5. AWS (optional)

1. Set `PORTABLE_AWS_PROFILE` in `.env`.
2. Run `portable`. If your SSO session has expired, it runs `aws sso login` and opens the browser.

The credentials last about an hour. When they expire, exit and run `portable` again.

If your Terraform code sets `profile = "..."` in the AWS provider, remove it or make it a variable. The container has no AWS profiles, only the credentials passed in.

## Daily use

```sh
portable            # shell in the container
portable claude     # Claude Code in the container
portable <command>  # any command, e.g. portable terraform plan
```

### Choosing what Claude can see

A session sees only the folder you run `portable` in, which has to be your workspace folder or a folder inside it. Change folders to change how much Claude can reach:

```sh
cd ~/Projects && portable claude          # every project
cd ~/Projects/my-app && portable claude   # only my-app
```

Run from anywhere else, `portable` refuses to start. The configuration repo your Mac's `~/.claude` links to stays hidden (empty and read-only) even when it's inside the folder you start in, in the session and in the Docker engine, so the sandbox can't change what your Mac's Claude runs. You can't start a session inside it. Its installed copy lives outside any workspace, so that only matters for installs from before it had one (see [Changing your Claude configuration](#changing-your-claude-configuration)). The copy of portable that's running is hidden the same way, so the sandbox can't rewrite its own launcher; the installed copy lives outside any workspace, so that only matters when you run a clone directly.

The Docker engine is shared by every session, so it sees the whole workspace folder. Claude could reach other projects by starting a container with one mounted; it's told not to unless you ask (see [Docker](#docker)).

The first time Claude opens a folder, it asks whether you trust it. That prompt is left on purpose.

### Running a command without leaving Claude

`portable claude` runs Claude as the container's main process, with no shell above it. So Ctrl+Z suspends Claude and drops you back on your Mac, not into the container. To run a command in the container:

- **One-off command:** type it after `!` in Claude, e.g. `! docker compose ps`. It runs in the container and the output lands in the conversation.
- **A shell you can switch to:** start with `portable`, then run `claude` from that shell. Ctrl+Z now drops you to the container's shell, and `fg` brings Claude back. `portable ps` lists the session's command as `bash`.
- **A second terminal:** run `portable` in another tab. It's a separate container, but it has the same Docker engine, and the same folder if you start it in the same one.

### Running several agents

Each `portable` command starts its own container, so you can run as many agents as you like, each in its own terminal. They share Claude's history, settings and trusted folders, just like several Claude sessions on one Mac.

**Same repo:** give each agent its own git worktree so their edits never collide. The repo needs at least one commit.

```sh
cd ~/Projects/testing/my-app          # inside your workspace folder
portable claude --worktree feat-auth  # terminal 1
portable claude --worktree fix-login  # terminal 2
```

Each one works on its own branch (`worktree-feat-auth`, …) in `my-app/.claude/worktrees/<name>`, and the container is named after the worktree. Because the workspace has the same path inside the container, git on your Mac works in those worktree folders too.

**Different repos:** start each agent from a different folder (`cd ~/Projects/testing/api && portable claude`).

**Naming, listing, stopping:**

```sh
portable --name api claude   # name a container (default: <folder>-<random>, or the worktree name)
portable ps                  # running sessions: name, folder, command, start time
portable stop api            # stop one
```

`portable doctor` checks the whole setup; see [Verify the setup](#verify-the-setup).

Each container uses memory from Docker Desktop's VM, so raise its limit (Docker Desktop → Settings → Resources) if you run many at once.

### What happens automatically

Each time you run `portable`:

- **Images:** they're rebuilt only if something in `image/` changed since the last build. When several launches start together, one builds and the others wait.
- **Docker engine:** it's started if it isn't running, and `portable` waits until it's ready.
- **Claude configuration repo:** it's updated when the remote has new commits. If it can't be reached (offline), the existing copy is used. Containers starting at the same time take turns with this setup, so no agent starts with half-updated files. The copy is read-only inside the container, so a session can't edit it and block later updates (see [Changing your Claude configuration](#changing-your-claude-configuration)).
- **Mac settings:** your Mac's `~/.claude/settings.json` is merged in, and the Mac's values win. Mac-only entries are stripped first:
  - Hooks, the status line and credential helpers are dropped entirely, since they run Mac commands.
  - Any other value that mentions a macOS path (`/Users/...`, `/opt/homebrew/...`, `/Applications/...` and similar) is removed. For example, `Read(/Users/you/...)` is dropped from a permissions list while the other rules stay.
- **Claude's first-run screens** (theme, welcome) are skipped.

Claude's history and settings are kept in the `portable_claude-state` Docker volume, the configuration repo in `portable_claude-configuration`, and the engine's data in `portable_docker-data`.

### Changing your Claude configuration

Your Mac's `~/.claude` links into the configuration repo's installed copy in `~/.local/share/claude-configuration`, outside any workspace, so changes go through GitHub:

1. Work in a clone in your workspace folder, e.g. `~/Projects/claude-configuration` (or let Claude clone it in the container), make the change, and push a branch or open a PR. `image/claude-instructions.md` tells Claude to do this.
2. Merge it.
3. On your Mac, run `./install.sh update` in your clone, then start new Claude sessions.
4. The next `portable` start picks it up in the container.

If `~/.claude` still links into a clone inside the workspace folder (installed before the configuration repo had an installed copy), that clone stays hidden and `portable` refuses to start in it. Run its `install.sh` once to switch to the installed copy.

That's on purpose: code in the container could otherwise change the skills and rules your Mac's Claude runs, outside the sandbox.

Copies of the repo from before it was read-only may still have changes made in them. The next update saves those to `~/.claude/backups/claude-configuration-leftovers/` in the container, and says so, before replacing them.

## Updating portable

```sh
portable update
```

Lists the new commits on GitHub and moves the installed copy forward to them. It refuses if the installed copy has changes of its own; make changes in a clone instead. The images rebuild at the next start if `image/` changed. `portable doctor` warns when an update is waiting.

### Changing portable itself

Work in a clone in your workspace folder (e.g. `~/Projects/portable`), in portable like any other project, and merge the change on GitHub. Then `portable update` brings it to the installed copy. Nothing a session writes reaches the launcher you run until you've merged it.

To try a change before merging, run the clone directly on your Mac, e.g. `~/Projects/portable/bin/portable doctor` (`portable doctor` warns that it's not the installed copy). That runs outside the sandbox, so read what a session changed first, as you would a pull request. Both copies build the same image names, so switching between them rebuilds the images.

## Updating tool versions

The versions are pinned at the top of `image/Dockerfile` (`CLAUDE_CODE_VERSION`, `TERRAFORM_VERSION`, `AWS_CLI_VERSION`, `GH_VERSION`, `PNPM_VERSION`, `DOCKER_VERSION`, and the `node` base image). Change them, then run `portable`; the image rebuilds itself. Claude Code can't update itself inside the container.

## Verify the setup

Open a new terminal, then run:

```sh
portable doctor
```

It checks your Mac first: Docker, `.env`, the workspace folder, the Keychain secrets, the AWS profile and whether the image is current. Then it starts a fresh container and checks:

- **Sandbox:** the container runs as an ordinary user without admin rights, can't control Docker on your Mac, can edit files in the folder it started in, and can't see the hidden folders.
- **Tools:** the versions of Claude Code, git, gh, the AWS CLI, Terraform, pnpm, Docker and Compose.
- **Claude configuration:** your skills, rules and `CLAUDE.md` are installed and up to date, their copy is read-only, portable's `/start` and `/stop` skills are there, and your Mac's Claude settings are copied in without the Mac-only parts.
- **Access:** Claude answers a one-line prompt, GitHub accepts the token, and AWS answers `sts get-caller-identity` when a profile is set.
- **Docker:** `docker` reaches portable's engine (not your Mac's), which can pull from Docker Hub. Containers it starts see your workspace folder, without the hidden folders, and nothing else on your Mac, and their ports are on `localhost`.
- **Firewall:** sites on its list (npm, the Terraform registry) are reachable and other sites are blocked, from the container and from containers Docker starts.

Each line says `ok`, `warn`, `skip` or `FAIL`, and the command exits non-zero if anything failed. The Claude check sends a tiny prompt, so it uses a few tokens.

One thing it can't check without changing a repo: pushing. Push a branch to a repo your token covers, and check that a push to one it doesn't cover is refused.

## Troubleshooting

| Message | Fix |
|---|---|
| `no Claude credential in the Keychain` | Step 2 |
| `no GitHub token` | Step 3 |
| `couldn't clone ... (does GH_TOKEN include it?)` | Add the configuration repo to your token's repository access |
| `your Claude configuration is ... behind GitHub` | Run `portable` and read the `portable:` messages at start. `couldn't update ... (offline?)` means GitHub couldn't be reached |
| `WORKSPACE_DIR (...) is inside portable ...`, `is too broad` or `would cover a system folder` | Point `WORKSPACE_DIR` in `.env` at a dedicated folder |
| `run it from WORKSPACE_DIR (...) or a folder in it` | `cd` into a project in your workspace folder first. `portable doctor` works from anywhere |
| `... is the copy of portable that's running` | You ran a clone of portable directly from inside itself. Use the installed `portable` to work on the clone |
| `... is your Claude configuration repo` | It's hidden on purpose. Run its `install.sh` to switch to its installed copy, as the message shows (see [Changing your Claude configuration](#changing-your-claude-configuration)) |
| `couldn't get AWS credentials for profile ...` | Run `aws sso login --profile <name>` on your Mac and check the profile name in `.env` |
| `Docker isn't running` | Start Docker Desktop |
| `container portable-engine exited` or `is unhealthy` | Run `docker logs portable-engine` on your Mac. `couldn't set up the firewall` there usually means you were offline at start (GitHub's and AWS's ranges are fetched then). Retry, or set `PORTABLE_FIREWALL=off` |
| `the Docker engine has an update` | Exit the other sessions (`portable ps`), then run `portable` again |
| A tool fails with "Could not connect to server" or "connection refused" | The firewall blocked it. Add the host to `PORTABLE_ALLOW_DOMAINS` |

## Removing it

```sh
./uninstall.sh
```

It's safe to re-run. It:

1. Stops and removes portable's containers, including the Docker engine. If any session is running, it lists them and asks first, since that ends them.
2. Asks whether to delete Claude's history and settings in the container (Docker volumes).
3. Asks whether to delete everything the Docker engine holds: projects' images, containers and their data.
4. Asks whether to delete the images.
5. Asks whether to delete your secrets from the Keychain. You'd need new tokens to reinstall.
6. Removes the `portable` command and the PATH lines `install.sh` added to `~/.zshrc` (a backup is saved as `~/.zshrc.portable-backup`). The PATH line stays if other programs are in `~/.local/bin`.
7. Asks whether to delete the installed copy (`~/.local/share/portable`) and your settings (`~/.config/portable/.env`).

`./uninstall.sh --yes` answers yes to everything. It never touches your workspace folder, clones of portable in it or other projects' containers; delete the folders yourself if you want.
