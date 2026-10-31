# portable

Claude Code in a microVM on your Mac, so it can work on projects without running anything on the Mac itself. One command sets it up on any Apple silicon Mac. The sandbox has Claude Code, git, the GitHub CLI (`gh`), the AWS CLI, Terraform, Infracost, pnpm and its own Docker engine with Compose.

portable is a thin layer over [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`): each project folder gets its own VM with its own kernel and Docker engine, and a proxy on the Mac decides what it may reach and adds your credentials to requests, so the tokens never enter the VM. portable adds what sbx doesn't have: the tools, your Claude configuration repo, Keychain-backed secrets, the AWS SSO handoff, `/start` and `/stop`, and `portable doctor`.

## What the sandbox can and can't reach

| | Inside the sandbox |
|---|---|
| Your files | Only the folder you run `portable` in, which must be your workspace folder (`WORKSPACE_DIR`, default `~/Projects/sandboxed`) or a folder inside it (see [Choosing what Claude can see](#choosing-what-claude-can-see)). It's mounted at the same path it has on your Mac, so paths match on both sides. Nothing else on your Mac: no home folder, `~/.ssh`, `~/.aws` or Docker socket. Containers Claude starts see the same folder and nothing else |
| Docker | The sandbox's own engine, inside the VM. Images, containers and volumes stay in the sandbox until you delete it |
| Claude | Signed in once per Mac with `/login`; sbx keeps the token on the Mac and puts it on requests to Anthropic. The sandbox sees a placeholder |
| GitHub | A fine-grained token from your Keychain, limited to the repos you choose, added by the proxy to requests to GitHub. `gh` and `git` over HTTPS work; the sandbox sees a placeholder |
| Infracost | A token from your Keychain, added by the proxy to requests to Infracost's pricing and dashboard APIs; the sandbox sees a placeholder. Optional. Its Terraform and AWS plugins are built in and pinned, so it downloads nothing at run time |
| AWS | Temporary credentials (about 1 hour) made from an AWS profile on your Mac and written into the sandbox at each start. Your SSO login stays on the Mac |
| Claude settings | Your skills, rules and `CLAUDE.md` from your configuration repo, plus your Mac's `~/.claude/settings.json` (without hooks). portable adds `/start` and `/stop`, which boot and stop a project's `docker compose` stack |
| The internet | Only the hosts in `kit/portable.yaml` and `PORTABLE_ALLOW_DOMAINS`, by name. Everything else is refused, for Claude and for the containers it starts |

### Limits

Honest list of what the sandbox doesn't protect:

- **AWS credentials are in the VM** for their hour, because signing requests needs the keys. Use a profile with only the permissions the project needs, not an admin one.
- **An allowed service can still receive data**: a push to any GitHub repo, a package publish, an upload to any S3 bucket (`*.amazonaws.com` is allowed by name). The network policy stops accidents and unknown hosts, not a deliberate attempt through an allowed one.
- **The workspace is a two-way channel.** Anything a session writes in the project runs on your Mac later if you run it there: `.git/hooks`, `.git/config`, `node_modules/.bin`, package.json scripts, Makefiles, editor tasks. Start sessions in the narrowest folder that works, and after an unattended run look at those paths the way you'd read a pull request. Git hooks don't show in `git diff`.
- **Your GitHub token decides what a session can change.** It should not be able to push to the default branch of this repo or your Claude configuration repo without review, since `portable update` and `./install.sh update` run what's on those branches on your Mac. Protect both with a GitHub ruleset that blocks direct pushes and allows no bypass.
- The VM is the boundary; nested Docker inside it runs privileged, which is fine there. See Docker's [security model](https://docs.docker.com/ai/sandboxes/security/) for what sbx itself guarantees.

### Network

sbx proxies every outbound TCP connection through the Mac and refuses destinations that no rule allows; UDP and ICMP are blocked ([Docker docs](https://docs.docker.com/ai/sandboxes/security/)). portable's kit allows, by host name:

- **GitHub:** web, API, git over HTTPS and release downloads.
- **npm, Terraform's registry and HashiCorp releases, Infracost's pricing and dashboard APIs, Docker Hub, the Alpine and Debian package mirrors.**
- **AWS:** `*.amazonaws.com`, so every AWS API works, Lambda and Secrets Manager included.

Add a project's hosts with `PORTABLE_ALLOW_DOMAINS` in `.env`, e.g. `pypi.org files.pythonhosted.org`; `portable` applies them to this Mac's sbx policy at each start (`sbx policy ls` shows the result). Docker's Claude workload adds Anthropic's hosts itself. A blocked host fails fast with "connection refused" or a TLS error; the sandbox's `CLAUDE.md` tells Claude to report the host rather than work around it.

### Docker

Each sandbox has its own Docker engine. Claude can `docker compose up` a project and run its tests; the containers see the session's folder at its Mac path, so bind mounts in a compose file work unchanged.

- **Ports:** a port a container publishes is on `localhost` inside the sandbox, and `portable` forwards it to your Mac's `127.0.0.1` within a few seconds: at the same number when the Mac has it free, so the project's usual `localhost` URLs work in your browser and TablePlus, otherwise at the next free number (another sandbox or a Mac process had it). Forwards are added when you start `portable`, kept current while a session runs, and dropped when the container goes. `portable ports` lists them for the folder's sandbox (`portable ports NAME` for another, or every running one from outside the workspace); `portable ps` shows them too, and inside the sandbox `/etc/portable/ports` holds the mapping, so Claude reports the Mac URL after `/start`. sbx records the forwards, so there's no list to keep, and nothing else on the Mac is touched. Only TCP ports published on all interfaces count (`-p 3000:80`, the usual form); one bound to `127.0.0.1` inside the sandbox stays there.
- **Data:** images, containers and volumes (databases, for example) live in the sandbox and survive stops and restarts. `portable rm NAME` deletes them with the sandbox.
- **Lifetime:** a sandbox keeps running after your session ends, with whatever Claude started, and stops when nothing uses it. `portable ps` lists them, `portable stop NAME` pauses one.
- **Node projects:** the workspace's `node_modules` holds your Mac's install, with macOS-only native binaries. Installing over it from the sandbox would swap in Linux ones and break the project on your Mac until you reinstall there. Run installs and checks through the project's compose services instead, with `node_modules` in a volume. The sandbox's `CLAUDE.md` (`kit/files/claude-instructions.md`) tells Claude this.

## Requirements

- An Apple silicon Mac on macOS 14 or later, with Homebrew. sbx needs the hardware virtualization; Intel Macs aren't supported ([sbx install docs](https://docs.docker.com/ai/sandboxes/install/)). `portable` reads sbx's listings with `jq`, which macOS 15 and later ship; on 14, `brew install jq`.
- A Docker account. sbx signs in with it once (`sbx login`); local sandboxes are free. Docker Desktop is not needed.
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
2. Installs Docker Sandboxes with Homebrew if it's missing (`brew trust docker/tap && brew install docker/tap/sbx`) and signs you in to Docker.
3. Links the `portable` command into `~/.local/bin` and adds that folder to your PATH in `~/.zshrc`.
4. Creates `~/.config/portable/.env` from `.env.example` if there isn't one.
5. Asks for the GitHub token and the optional Infracost token (step 3 below) and tells sbx to read them from the Keychain.

Open a **new terminal** afterwards so `portable` is on your PATH.

### 2. Claude sign-in

The first time you run `portable claude` on a Mac, type `/login` and sign in with your Claude account in the browser. sbx stores the token on the Mac and the sandbox only ever sees a placeholder ([Docker docs](https://docs.docker.com/ai/sandboxes/configuration/credentials/)).

To use an API key instead (billed per use in the [Claude Console](https://platform.claude.com)), store it with sbx: `sbx secret set anthropic`. It's handled the same way.

### 3. GitHub token

1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
2. **Resource owner:** your account. **Expiration:** pick a limit, for example 90 days.
3. **Repository access:** *Only select repositories*. Include your Claude configuration repo (`claude-configuration`) and every repo Claude should work on.
4. **Permissions:** *Contents* read and write, *Pull requests* read and write.
5. Generate it and store it:

   ```sh
   portable secret set GH_TOKEN
   ```

A fine-grained token can reach one owner only (your account or one organization). It can't push to repos where you're an outside collaborator. See [Limits](#limits) for why the default branches of this repo and the configuration repo should be protected.

Sandboxes bind the token when they're created; after storing a new one, `portable rm` the sandboxes that should use it.

**Infracost (optional).** For `infracost` cost estimates, create a personal access token (or a service account token) in [Infracost Cloud](https://dashboard.infracost.io) and store it the same way:

```sh
portable secret set INFRACOST_CLI_AUTHENTICATION_TOKEN
```

The proxy adds it to requests to Infracost and the sandbox sees a placeholder, so don't run `infracost auth login` in a sandbox; that would cache a real token in it. Like the GitHub token, it's bound when a sandbox is created.

### 4. Settings (`.env`)

Edit `~/.config/portable/.env`. Every copy of portable uses it. A value set in your shell takes precedence over it.

| Setting | What it does |
|---|---|
| `WORKSPACE_DIR` | The most a sandbox can see: all your projects, e.g. `~/Projects`. Each session sees only the folder it's started in, here or below (see [Choosing what Claude can see](#choosing-what-claude-can-see)). `portable` refuses to start if it's `/`, `/Users`, your home folder, inside this project or your Claude configuration repo, or a path that would cover a system folder in the sandbox |
| `PORTABLE_AWS_PROFILE` | The AWS profile on your Mac to use, e.g. `default` or `Terraform`. Leave unset for no AWS access |
| `PORTABLE_CLAUDE_CONFIG_REPO` | Your Claude configuration repo. Cloned when a sandbox is created, installed with its own `install.sh`, updated at every boot |
| `PORTABLE_CLAUDE_CONFIG_DISABLE` | Skills or rules to turn off in the sandbox, separated by spaces. Lines naming them are removed from the sandbox's `CLAUDE.md` and rules |
| `PORTABLE_ALLOW_DOMAINS` | Extra hosts the sandbox may reach, separated by spaces, e.g. `pypi.org files.pythonhosted.org` |

Commits use the `user.name` and `user.email` from your Mac's git config; sbx passes them in.

### 5. AWS (optional)

1. Set `PORTABLE_AWS_PROFILE` in `.env`.
2. Run `portable`. If your SSO session has expired, it runs `aws sso login` and opens the browser.

The credentials last about an hour and are written into the sandbox at each `portable` start. When they expire, exit and run `portable` again. If your Terraform code sets `profile = "..."` in the AWS provider, remove it or make it a variable; the sandbox has no AWS profiles, only the credentials passed in.

## Daily use

```sh
portable            # shell in the folder's sandbox
portable claude     # Claude Code in it
portable <command>  # any command, e.g. portable terraform plan
portable ports      # which ports of the folder's sandbox are open on the Mac, and where
```

The first `portable` in a folder creates its sandbox, which takes a few minutes the very first time (portable's kit is built then). Later starts reattach to it.

### Choosing what Claude can see

A session sees only the folder you run `portable` in, which has to be your workspace folder or a folder inside it. Change folders to change how much Claude can reach:

```sh
cd ~/Projects && portable claude          # every project, one sandbox for all of them
cd ~/Projects/my-app && portable claude   # only my-app, in its own sandbox
```

Run from anywhere else, `portable` refuses to start. It also refuses to start inside the copy of portable that's running, or inside the configuration repo your Mac's `~/.claude` links into, since a session there could change what your Mac runs; the installed copies of both live outside any workspace, so that only matters when you run a clone directly.

Claude Code asks whether you trust a folder the first time it opens one. That prompt is left on purpose. Inside the sandbox Claude runs with `--dangerously-skip-permissions`, which is Docker's default for sandboxed agents and the point of having a VM; pass `--permission-mode default` after `portable claude` to get prompts back.

### Running a command without leaving Claude

- **One-off command:** type it after `!` in Claude, e.g. `! docker compose ps`. It runs in the sandbox and the output lands in the conversation.
- **A shell:** run `portable` in another terminal in the same folder; it opens a shell in the same sandbox.

### Running several agents

Each folder has one sandbox; `portable` in the same folder joins it, from as many terminals as you like. Agents in one sandbox share its Docker engine, so the `docker-ports` skill in there sees each other's containers and keeps their stacks on different ports, and `portable` forwards each one to the Mac.

**Same repo, separate work:** give each agent its own git worktree. The repo needs at least one commit.

```sh
cd ~/Projects/my-app                  # inside your workspace folder
portable claude --worktree feat-auth  # terminal 1
portable claude --worktree fix-login  # terminal 2
```

Each one works on its own branch (`worktree-feat-auth`, …) in `my-app/.claude/worktrees/<name>`, in the folder's sandbox. Because the repo has the same path inside the sandbox, git on your Mac works in those worktree folders too. Add `.claude/worktrees/` to the project's `.gitignore`: the work is on the worktree's branch, and the folder itself shouldn't be committed.

**Different repos:** start each agent from a different folder; each gets its own sandbox. Two sandboxes can publish the same port inside; on the Mac the second one gets the next free number, which `portable ports` and `/start` report.

**Naming, listing, stopping, deleting:**

```sh
portable --name api claude   # a separate sandbox on the same folder, named api (its own VM and engine)
portable ps                  # sandboxes: name, status, ports (sandbox→Mac), folder, created
portable ports [api]         # forward and list the ports of the folder's sandbox, or of api
portable stop api            # pause one; its data stays
portable rm api              # delete one: its Docker images, containers, volumes and Claude history
portable prune               # delete every stopped one, after asking
```

Each sandbox is a VM with 4 CPUs and 8 GiB of memory (`kit/portable.yaml`); `sbx` with no arguments shows their live usage.

### What happens automatically

Each time you run `portable`:

- **Network policy:** hosts in `PORTABLE_ALLOW_DOMAINS` are allowed on this Mac.
- **Ports:** ports that containers in the sandbox publish are forwarded to the Mac, and a watcher keeps them current for as long as your session runs (every 5 seconds; it ends with the session). A one-off command, e.g. `portable docker compose up -d`, forwards what it started when it returns.
- **AWS:** fresh credentials are written into the sandbox for new sessions.
- **Mac settings:** your Mac's `~/.claude/settings.json` is merged into the sandbox's, and the Mac's values win. Mac-only entries are stripped first: hooks, the status line and credential helpers are dropped entirely, since they run Mac commands, and any other value that mentions a macOS path (`/Users/...`, `/opt/homebrew/...`, `/Applications/...` and similar) is removed. The sandbox keeps the hooks and sign-in helper Docker's Claude workload set up.

When a sandbox boots:

- **Claude configuration repo:** it's fetched, and when GitHub has new commits the clone is reset to them and relinked. This runs alongside Claude, so an update lands for the next session. If GitHub can't be reached, the existing copy is used. The copy is read-only inside the sandbox.

### Changing your Claude configuration

Your Mac's `~/.claude` links into the configuration repo's installed copy in `~/.local/share/claude-configuration`, outside any workspace, so changes go through GitHub:

1. Work in a clone in your workspace folder, e.g. `~/Projects/claude-configuration` (or let Claude clone it in the sandbox), make the change, and push a branch or open a PR. The sandbox's `CLAUDE.md` tells Claude to do this.
2. Merge it.
3. On your Mac, run `./install.sh update` in your clone, then start new Claude sessions.
4. The next sandbox boot picks it up in the sandbox (`portable stop NAME` then `portable` forces one).

If `~/.claude` still links into a clone inside the workspace folder (installed before the configuration repo had an installed copy), `portable` refuses to start in it; run its `install.sh` once to switch to the installed copy.

## Updating portable

```sh
portable update
```

Lists the new commits on GitHub and moves the installed copy forward to them. It refuses if the installed copy has changes of its own; make changes in a clone instead. A changed kit (`kit/`) rebuilds when the next sandbox is created; existing sandboxes keep the kit they were made with, so `portable rm` them to pick it up. `portable doctor` warns when an update is waiting.

### Changing portable itself

Work in a clone in your workspace folder (e.g. `~/Projects/portable`), in portable like any other project, and merge the change on GitHub. Then `portable update` brings it to the installed copy. Nothing a session writes reaches the launcher you run until you've merged it; see [Limits](#limits) for protecting the branch.

To try a change before merging, run the clone directly on your Mac, e.g. `~/Projects/portable/bin/portable doctor` (`portable doctor` warns that it's not the installed copy). That runs outside the sandbox, so read what a session changed first, as you would a pull request.

## Updating tool versions

The versions are pinned in `kit/portable.dockerfile` (`TERRAFORM_VERSION`, `INFRACOST_VERSION` and its plugins' `INFRACOST_*_VERSION`, `GH_VERSION`, `PNPM_VERSION`, `AWS_CLI_VERSION`) with the SHA-256 of each download next to them; change both. Claude Code's version comes from Docker's workload, pinned in `lib/launch.sh` (`PORTABLE_WORKLOAD`): pick a newer tag from [Docker Hub](https://hub.docker.com/r/docker/sbx-kit-claude/tags). New sandboxes get the new versions; `portable rm` existing ones to rebuild them.

## Verify the setup

Open a new terminal, then run:

```sh
portable doctor
```

It checks your Mac first: sbx and its sign-in, `.env`, the workspace folder, the kit, the Keychain tokens and whether sbx reads them, your git identity, the AWS profile and whether portable is current. Then it creates a throwaway sandbox and checks, before deleting it:

- **Sandbox:** runs as an ordinary user, sees only the folder it started in and nothing else on your Mac.
- **Credentials:** no real Claude or GitHub token is readable in the sandbox, and git is set to use the proxy-managed one.
- **Tools:** the versions of Claude Code, git, gh, the AWS CLI, Terraform, Infracost, pnpm, Docker and Compose.
- **Claude configuration:** your skills, rules and `CLAUDE.md` are installed, read-only and current, portable's `/start` and `/stop` and managed `CLAUDE.md` are there, and the settings carry no Mac-only paths.
- **Access:** Claude answers a one-line prompt, GitHub accepts the token, AWS answers `sts get-caller-identity` when a profile is set, and Infracost accepts the token and scans a test Terraform file when a token is stored.
- **Docker:** the sandbox's engine pulls from Docker Hub, containers it starts see the workspace folder and nothing else, and their ports are on `localhost`.
- **Ports:** a port a test container publishes is forwarded to the Mac and answers there.
- **Network:** allowed hosts (npm, the Terraform registry) are reachable and other sites are blocked, from the sandbox and from containers Docker starts.

Each line says `ok`, `warn`, `skip` or `FAIL`, and the command exits non-zero if anything failed. The Claude check sends a tiny prompt, so it uses a few tokens, and it needs the `/login` from step 2 to have happened once.

One thing it can't check without changing a repo: pushing. Push a branch to a repo your token covers, and check that a push to one it doesn't cover is refused.

## Troubleshooting

| Message | Fix |
|---|---|
| `Docker Sandboxes (sbx) isn't installed` | Run `install.sh`, or `brew trust docker/tap && brew install docker/tap/sbx` |
| `sbx ... is too old` | `brew upgrade sbx` |
| `signing in to Docker (sbx login)` | Finish the sign-in in the browser; sbx needs a Docker account |
| `no GitHub token in the Keychain` | Step 3, then `portable rm` the sandbox so it binds the token |
| Claude asks to sign in, or doctor says it didn't answer | Run `portable claude` and `/login` once on this Mac (step 2) |
| `couldn't clone ... (is a GitHub token stored, and does it include this repo?)` | Add the configuration repo to your token's repository access, then `portable rm` the sandbox |
| `WORKSPACE_DIR (...) is inside portable ...`, `is too broad` or `would cover a system folder` | Point `WORKSPACE_DIR` in `.env` at a dedicated folder |
| `run it from WORKSPACE_DIR (...) or a folder in it` | `cd` into a project in your workspace folder first. `portable doctor` works from anywhere |
| `... is the copy of portable that's running` | You ran a clone of portable directly from inside itself. Use the installed `portable` to work on the clone |
| `... is your Claude configuration repo` | Run its `install.sh` to switch to its installed copy, as the message shows |
| `couldn't get AWS credentials for profile ...` | Run `aws sso login --profile <name>` on your Mac and check the profile name in `.env` |
| `couldn't forward port ... to the Mac` | That port and the next free numbers above it couldn't be published; `sbx ls` shows what sbx holds, `lsof -nP -iTCP -sTCP:LISTEN` what the Mac does |
| `jq isn't installed` | macOS 15 and later have it; on 14, `brew install jq` |
| A tool fails with "Could not connect to server" or "connection refused" | The network policy blocked it. Add the host to `PORTABLE_ALLOW_DOMAINS` |
| A sandbox misbehaves | `portable rm NAME` and start again; the next `portable` creates a fresh one |

## Removing it

```sh
./uninstall.sh
```

It's safe to re-run. It:

1. Lists portable's sandboxes and asks before deleting them, since their Docker data and Claude history go with them.
2. Asks whether to remove the GitHub token source from sbx.
3. If Docker Desktop is still installed, asks whether to delete the leftovers of the Docker-based portable (its engine container, volumes and images).
4. Asks whether to delete your secrets from the Keychain.
5. Removes the `portable` command and the PATH lines `install.sh` added to `~/.zshrc` (a backup is saved as `~/.zshrc.portable-backup`). The PATH line stays if other programs are in `~/.local/bin`.
6. Asks whether to delete the installed copy (`~/.local/share/portable`) and your settings (`~/.config/portable/.env`).

`./uninstall.sh --yes` answers yes to everything. It never touches your workspace folder, clones of portable in it, other sandboxes or sbx itself (`brew uninstall sbx`).
