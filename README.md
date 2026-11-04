# portable

Claude Code in a microVM on your computer, so it can work on projects without running anything on the computer itself. One command sets it up on any Apple silicon Mac. Each project folder is an environment with its own local page to see its ports and services and change its settings. The sandbox has Claude Code, git, the GitHub CLI (`gh`), the AWS CLI, Terraform, pnpm and its own Docker engine with Compose.

portable is a thin layer over [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`): each project folder gets its own VM with its own kernel and Docker engine, and a proxy on the host decides what it may reach and adds your credentials to requests, so the tokens never enter the VM. portable adds what sbx doesn't have: the tools, your Claude configuration repo, Keychain-backed secrets, the AWS SSO handoff, ports that keep their number, a page per environment, `/start` and `/stop`, and `portable doctor`.

There's nothing to add to a project: an environment is just a folder. Its settings live on the host (`~/.config/portable/envs/`), and one command (`portable` or `portable claude`) creates or joins it.

## What the sandbox can and can't reach

| | Inside the sandbox |
|---|---|
| Your files | Only the folder you run `portable` in, any project folder (see [Choosing what Claude can see](#choosing-what-claude-can-see)). It's mounted at the same path it has on your computer, so paths match on both sides. Nothing else on your computer: no home folder, `~/.ssh`, `~/.aws` or Docker socket. Containers Claude starts see the same folder and nothing else |
| Docker | The sandbox's own engine, inside the VM. Images, containers and volumes stay in the sandbox until you delete it |
| Claude | Signed in once per computer with `/login`; sbx keeps the token on the host and puts it on requests to Anthropic. The sandbox sees a placeholder |
| GitHub | A fine-grained token from your Keychain, limited to the repos you choose, added by the proxy to requests to GitHub. `gh` and `git` over HTTPS work; the sandbox sees a placeholder |
| AWS | Off unless you turn it on for the environment, on its page. Then temporary credentials (about 1 hour) made from an AWS profile on your computer are written into the sandbox at each start and when you refresh. Your SSO login stays on the host |
| Claude settings | Your skills, rules and `CLAUDE.md` from your configuration repo, with any you turned off on the environment's page left out. portable adds `/start` and `/stop`, which boot and stop a project's `docker compose` stack, and `/ui`, which gives the link to the environment's page |
| The internet | Only the hosts in `kit/portable.yaml` and the environment's allowed hosts (its page, plus `allowDomains` in `config.json` for every environment), by name. Everything else is refused, for Claude and for the containers it starts |

### Limits

Honest list of what the sandbox doesn't protect:

- **AWS credentials are in the VM** for their hour, because signing requests needs the keys. Use a profile with only the permissions the project needs, not an admin one.
- **An allowed service can still receive data**: a push to any GitHub repo, a package publish, an upload to any S3 bucket (`*.amazonaws.com` is allowed by name). The network policy stops accidents and unknown hosts, not a deliberate attempt through an allowed one.
- **The workspace is a two-way channel.** Anything a session writes in the project runs on your computer later if you run it there: `.git/hooks`, `.git/config`, `node_modules/.bin`, package.json scripts, Makefiles, editor tasks. Start sessions in the narrowest folder that works, and after an unattended run look at those paths the way you'd read a pull request. Git hooks don't show in `git diff`.
- **Your GitHub token decides what a session can change.** It should not be able to push to the default branch of this repo or your Claude configuration repo without review, since `portable update` and `./install.sh update` run what's on those branches on your computer. Protect both with a GitHub ruleset that blocks direct pushes and allows no bypass.
- The VM is the boundary; nested Docker inside it runs privileged, which is fine there. See Docker's [security model](https://docs.docker.com/ai/sandboxes/security/) for what sbx itself guarantees.

### Network

sbx proxies every outbound TCP connection through the host and refuses destinations that no rule allows; UDP and ICMP are blocked ([Docker docs](https://docs.docker.com/ai/sandboxes/security/)). portable's kit allows, by host name:

- **GitHub:** web, API, git over HTTPS and release downloads.
- **npm, Terraform's registry and HashiCorp releases, Docker Hub, the Alpine and Debian package mirrors.**
- **AWS:** `*.amazonaws.com`, so every AWS API works, Lambda and Secrets Manager included.

Add a project's hosts on its environment page (**Sandbox settings → Extra allowed hosts**, e.g. `pypi.org` and `files.pythonhosted.org`), or for every environment with `allowDomains` in `config.json`. portable adds them as rules scoped to that one sandbox (`sbx policy allow network --sandbox`), so one project's hosts don't open up the others; `sbx policy ls <sandbox>` shows the result. Docker's Claude workload adds Anthropic's hosts itself. A blocked host fails fast with "connection refused" or a TLS error; the sandbox's `CLAUDE.md` tells Claude to report the host rather than work around it.

### Docker

Each sandbox has its own Docker engine. Claude can `docker compose up` a project and run its tests; the containers see the session's folder at its host path, so bind mounts in a compose file work unchanged.

- **Ports:** a port a container publishes is on `localhost` inside the sandbox, and portable forwards it to your computer's `127.0.0.1` within a few seconds. The first time, it gets the same number when the host has it free, so the project's usual `localhost` URLs work in your browser and TablePlus, otherwise the next free number (another sandbox or a host process had it). Then it **sticks**: the environment remembers the host port and uses it again every time, and other environments leave it alone. Change it on the environment page if you want another one. The forwarding runs in the environment's host agent, which also serves its page, for as long as the sandbox runs, and forwards are dropped when the container goes. If sbx stops answering for a moment (its daemon restarting, say), the agent keeps everything as it is and tries again rather than tearing forwards down. `portable ports` lists them for the folder's sandbox (`portable ports NAME` for another, or every running one from outside the workspace); `portable ps` and the page show them too, and inside the sandbox `/etc/portable/ports` holds the mapping, so Claude reports the host URL after `/start`. Only TCP ports published on all interfaces count (`-p 3000:80`, the usual form); one bound to `127.0.0.1` inside the sandbox stays there.
- **Data:** images, containers and volumes (databases, for example) live in the sandbox and survive stops and restarts. `portable rm NAME` deletes them with the sandbox.
- **Lifetime:** a sandbox keeps running after your session ends, with whatever Claude started, and stops when nothing uses it. `portable ps` lists them, `portable stop NAME` pauses one.
- **Node projects:** the workspace's `node_modules` holds your computer's install, with native binaries built for it. Installing over it from the sandbox would swap in the sandbox's and break the project on your computer until you reinstall there. Run installs and checks through the project's compose services instead, with `node_modules` in a volume. The sandbox's `CLAUDE.md` (`kit/files/claude-instructions.md`) tells Claude this.

## Requirements

- An Apple silicon Mac on macOS 14 or later ([sbx install docs](https://docs.docker.com/ai/sandboxes/install/)). Intel Macs aren't supported, and portable is macOS-only on purpose: its secrets live in the Keychain.
- Homebrew, for installing sbx; `install.sh` offers to install it. portable brings its own Node 26 (see [Node](#node)) and has no other dependencies.
- A Docker account. sbx signs in with it once (`sbx login`); local sandboxes are free. Docker Desktop is not needed.
- The AWS CLI on your computer, only if you want AWS access (`brew install awscli`).
- A Claude Pro or Max subscription, or an Anthropic API key.

## Setup

### 1. Clone and install

```sh
git clone <this repo>
cd ~/path/to/this/repo
./install.sh
```

`install.sh` is safe to re-run. It:

1. Installs portable in `~/.local/share/portable`, a clone of the same GitHub repo, or updates that copy from GitHub if it's already there, and continues with that copy. That's the copy `portable` runs, kept outside any workspace, so the clone you started from can be worked on in portable like any other project (see [Changing portable itself](#changing-portable-itself)).
2. Checks that this is an Apple silicon Mac, then offers to install whatever's missing, asking before each one:
   - **Homebrew**, when sbx or the AWS CLI needs installing, with its official installer from [brew.sh](https://brew.sh/). It explains what it will do and asks for your password.
   - **Node 26**, portable's own copy, downloaded from nodejs.org into `~/.local/share/portable-node` (see [Node](#node)). No sudo, and any other Node on the computer is left alone.
   - **Docker Sandboxes**: `brew trust docker/tap && brew install docker/tap/sbx`. Then it signs you in to Docker.

   Say no to any of them and it stops, telling you what to install yourself. Run without a terminal (e.g. from a script), it installs nothing and stops at the first thing that's missing.
3. Links the `portable` command (`bin/portable`, which starts portable on its own Node) into `~/.local/bin` and adds that folder to your PATH in your shell's rc file.
4. Creates `~/.config/portable/config.json` from the defaults, or clones your settings repo when you pass `--settings URL` (see [Carrying settings to another Mac](#carrying-settings-to-another-mac)), and asks for your Claude configuration repo if none is set. If an AWS profile is set and the AWS CLI is missing, offers `brew install awscli` on macOS.
5. Runs `portable configure`, which offers to store the GitHub token (step 3 below; optional). They go in the Keychain, and sbx is told to read them from there.

Open a **new terminal** afterwards so `portable` is on your PATH.

### 2. Claude sign-in

The first time you run `portable claude` on a computer, type `/login` and sign in with your Claude account in the browser. sbx stores the token on the host and the sandbox only ever sees a placeholder ([Docker docs](https://docs.docker.com/ai/sandboxes/configuration/credentials/)).

To use an API key instead (billed per use in the [Claude Console](https://platform.claude.com)), store it with sbx: `sbx secret set anthropic`. It's handled the same way.

### 3. Tokens (optional)

Every token is optional. Without the GitHub one, public repos (your configuration repo included, if it's public) still clone, but `git push` and `gh` in the sandbox need it. Store or replace them any time with `portable configure`.

1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
2. **Resource owner:** your account. **Expiration:** pick a limit, for example 90 days.
3. **Repository access:** *Only select repositories*. Include your Claude configuration repo (`claude-configuration`) and every repo Claude should work on.
4. **Permissions:** *Contents* read and write, *Pull requests* read and write.
5. Generate it and store it:

   ```sh
   portable configure
   ```

   It goes through each secret portable uses and says whether it's stored. For a missing one it asks "Store it now? [y/N]", prints where to make it, and opens the Keychain's hidden prompt, which asks for the value twice. Stored ones can be replaced; one that's stored but that sbx isn't reading yet is fixed without asking. It also says whether Claude is signed in. Run it again any time, e.g. when a token expires; `portable secret set GH_TOKEN` stores a single one directly.

A fine-grained token can reach one owner only (your account or one organization). It can't push to repos where you're an outside collaborator. See [Limits](#limits) for why the default branches of this repo and the configuration repo should be protected.

Sandboxes bind the token when they're created; after storing a new one, `portable rm` the sandboxes that should use it.

### 4. Settings (`config.json`)

`~/.config/portable/config.json` holds the defaults for every environment. Each environment can override some of them on its page; those overrides are kept in `~/.config/portable/envs/<name>.json`, next to its sticky ports.

| Setting | What it does | Per environment |
|---|---|---|
| `workspaceDir` | Optional. Empty (the default) lets `portable` run in any project folder. Set it, e.g. to `~/Projects`, to only allow that folder and the ones inside it (see [Choosing what Claude can see](#choosing-what-claude-can-see)). `portable` refuses a value that holds your home folder, is inside your home's settings (`~/.config`, `~/Library` and other dot folders), this project or your Claude configuration repo, or would cover a system folder in the sandbox | No |
| `claudeConfigRepo` | Your Claude configuration repo. Cloned when a sandbox is created, installed with its own `install.sh`, updated at every boot | No |
| `claudeConfigDisable` | Skills or rules to turn off in sandboxes, e.g. `["docker-ports"]`. Lines naming them are removed from the sandbox's `CLAUDE.md` and rules | Yes, as checkboxes on the page |
| `allowDomains` | Extra hosts sandboxes may reach, e.g. `["pypi.org"]` | Yes, added to these |
| `awsProfile` | The AWS profile on your computer to use, e.g. `default` or `Terraform`. No global default: AWS is off until an environment's page turns it on | Per environment only |
| `cpus`, `memory` | The size of each microVM (default 4 and `8g`). Fixed when a sandbox is created | Yes; applies when the sandbox is recreated |

`WORKSPACE_DIR`, `PORTABLE_CLAUDE_CONFIG_REPO`, `PORTABLE_CLAUDE_CONFIG_DISABLE` and `PORTABLE_ALLOW_DOMAINS` set in your shell take precedence over `config.json`. There's no `.env` file anymore; an older portable's isn't read.

Commits use the `user.name` and `user.email` from your computer's git config; sbx passes them in.

### 5. AWS (optional, per environment)

AWS is off until you turn it on for an environment, on its page (`portable ui`), in the **AWS** section:

1. Pick one of the AWS profiles on your computer and click **Turn on**. The AWS CLI has to be installed (`brew install awscli`) and the profile set up (`aws configure sso`).
2. If the profile is signed out, click **Sign in**: `aws sso login` runs on your computer and opens the browser. The page then writes the credentials into the sandbox.

From then on, each `portable` start writes fresh credentials in (about an hour's worth) for new sessions. When they expire, **Refresh credentials** on the page, or exit and run `portable` again; a signed-out profile is reported at start, not signed in for you. **Turn off** clears the sandbox's credentials. If your Terraform code sets `profile = "..."` in the AWS provider, remove it or make it a variable; the sandbox has no AWS profiles, only the credentials passed in.

## Daily use

```sh
portable            # shell in the folder's sandbox
portable claude     # Claude Code in it
portable <command>  # any command, e.g. portable terraform plan
portable ports      # which ports of the folder's sandbox are open on the host, and where
portable ui         # bring the folder's environment up (no shell or Claude) and open its page
portable configure  # store or replace the secrets portable uses
portable -v         # portable's version and the commit it runs from, e.g. portable 3.0.0 (e05a730)
```

Each `portable` prints the environment's page address (`page: http://127.0.0.1:<port>/?t=...`).

### The environment page

Every running environment has its own page on `127.0.0.1`, served by a small host agent that starts with the sandbox and stops with it. `portable ui` is the page-first way in: it creates or starts the environment like `portable` does, without opening a shell or Claude, and opens the page; `portable claude` later joins the same sandbox. Its port sticks like the forwarded ones, so a bookmark keeps working.

From inside Claude, type `/ui`: it replies with the page's link, which you Cmd-click to open. The sandbox only knows the address, not the token; the browser remembers the token from the first time the page was opened with it. `portable claude` and `portable` open the page in your browser by themselves when they create the sandbox, so that's usually already done. If the page says the browser doesn't have its token yet, run `portable ui` once in the project's folder.

The page has:

- **Ports:** each forward, a link to open it, and its sticky host port, which you can change (the forward moves there right away, or as soon as the port is free) or forget. A host port another of the environment's ports, or another environment, already sticks to is refused.
- **Services:** the compose files in the folder and the two levels below it, with their containers. Start (`docker compose up --build --detach`), restart and stop them, and follow their logs, all in the sandbox's own Docker.
- **Sandbox settings:** extra allowed hosts, and CPUs and memory. Hosts apply at once; CPUs and memory say what to run to recreate the sandbox.
- **AWS:** off by default. Turn it on with one of this computer's profiles, sign in through SSO from the page, refresh the credentials, or turn it off again.
- **Claude configuration:** the configuration repo's commit, a button to update it from GitHub, and a checkbox for each skill and rule. Turning one off applies to new Claude sessions and survives restarts.
- **Secrets:** whether each token is stored and whether sbx reads it, and whether Claude is signed in. Never the values.
- **Activity:** what the agent did (forwards opened and closed, settings saved, hosts allowed).

The status pill at the top is what the agent last learned from sbx; `unknown` means sbx didn't answer on its last check. Toggling a skill or rule is applied from the configuration repo's copy already in the sandbox, so it doesn't wait on GitHub; the copy itself is updated when the sandbox boots or with the page's update button.

Only this computer can reach it, and every request needs the page's token, which is in the URL `portable ui` prints and stays in that browser afterwards. Requests with another host name are refused, so other sites open in the browser can't use it either.

The first `portable` in a folder creates its sandbox, which takes a few minutes the very first time (portable's kit is built then). Later starts reattach to it.

### Choosing what Claude can see

A session sees only the folder you run `portable` in. Change folders to change how much Claude can reach:

```sh
cd ~/Projects && portable claude          # every project, one sandbox for all of them
cd ~/Projects/my-app && portable claude   # only my-app, in its own sandbox
```

`portable` refuses to start in a folder that holds your home folder (your home itself, `/Users`, `/`), in your home's settings (`~/.ssh`, `~/.aws`, `~/.config`, `~/Library` and other dot folders), and outside `workspaceDir` when you've set one. It also refuses to start inside the copy of portable that's running, or inside the configuration repo your computer's `~/.claude` links into, since a session there could change what your computer runs; the installed copies of both live outside any workspace, so that only matters when you run a clone directly.

Claude Code asks whether you trust a folder the first time it opens one. That prompt is left on purpose. Claude also asks before running commands and editing files, since a sandbox limits what Claude can reach but not what it spends (a background process can keep calling paid APIs). Docker's Claude workload would start it with `--dangerously-skip-permissions`, and flags given to `sbx run` are only added after that one, so `portable claude` starts Claude with `sbx exec` and its own flags instead. Pass a permission flag yourself to choose another mode, e.g. `portable claude --permission-mode acceptEdits`, or `portable claude --dangerously-skip-permissions` for no prompts.

### Running a command without leaving Claude

- **One-off command:** type it after `!` in Claude, e.g. `! docker compose ps`. It runs in the sandbox and the output lands in the conversation.
- **A shell:** run `portable` in another terminal in the same folder; it opens a shell in the same sandbox.

### Running several agents

Each folder has one sandbox; `portable` in the same folder joins it, from as many terminals as you like. Agents in one sandbox share its Docker engine, so the `docker-ports` skill in there sees each other's containers and keeps their stacks on different ports, and `portable` forwards each one to the host.

**Same repo, separate work:** give each agent its own git worktree. The repo needs at least one commit.

```sh
cd ~/Projects/my-app
portable claude --worktree feat-auth  # terminal 1
portable claude --worktree fix-login  # terminal 2
```

Each one works on its own branch (`worktree-feat-auth`, …) in `my-app/.claude/worktrees/<name>`, in the folder's sandbox. Because the repo has the same path inside the sandbox, git on your computer works in those worktree folders too. Add `.claude/worktrees/` to the project's `.gitignore`: the work is on the worktree's branch, and the folder itself shouldn't be committed.

**Different repos:** start each agent from a different folder; each gets its own sandbox. Two sandboxes can publish the same port inside; on the host the second one gets the next free number, which `portable ports` and `/start` report.

**Naming, listing, stopping, deleting:**

```sh
portable --name api claude   # a separate sandbox on the same folder, named api (its own VM and engine)
portable ps                  # sandboxes: name, status, ports (sandbox→host), page, folder
portable ports [api]         # forward and list the ports of the folder's sandbox, or of api
portable stop api            # pause one; its data stays
portable rm api              # delete one: its Docker images, containers, volumes and Claude history (its settings and ports stay)
portable prune               # delete every stopped one, after asking
```

Each sandbox is a VM with 4 CPUs and 8 GiB of memory unless its settings say otherwise; `sbx` with no arguments shows their live usage.

### What happens automatically

Each time you run `portable`:

- **Network policy:** the environment's allowed hosts are set as rules for its sandbox.
- **AWS:** if the environment has it turned on, fresh credentials are written into the sandbox for new sessions (a signed-out profile is reported; sign in on the page).
- **Claude configuration:** if the skills and rules to turn off changed in `config.json`, the sandbox is told.
- **Page and ports:** the environment's host agent is started if it isn't running. It forwards ports containers publish (checking every 5 seconds) and serves the page until the sandbox stops. A one-off command, e.g. `portable docker compose up -d`, forwards what it started when it returns.

When a sandbox boots:

- **Claude configuration repo:** it's fetched, and when GitHub has new commits the clone is reset to them and relinked. This runs alongside Claude, so an update lands for the next session. If GitHub can't be reached, the existing copy is used. The copy is read-only inside the sandbox.

### Changing your Claude configuration

Your computer's `~/.claude` links into the configuration repo's installed copy in `~/.local/share/claude-configuration`, outside any workspace, so changes go through GitHub:

1. Work in a clone, e.g. `~/Projects/claude-configuration` (or let Claude clone it in the sandbox), make the change, and push a branch or open a PR. The sandbox's `CLAUDE.md` tells Claude to do this.
2. Merge it.
3. On your computer, run `./install.sh update` in your clone, then start new Claude sessions.
4. The next sandbox boot picks it up in the sandbox (`portable stop NAME` then `portable` forces one).

If `~/.claude` still links into a clone in your projects (installed before the configuration repo had an installed copy), `portable` refuses to start in it; run its `install.sh` once to switch to the installed copy.

### Node

portable runs on its own Node, pinned to the **26** line (an LTS release) so every Mac runs it the same way. `install.sh` downloads the newest 26.x (Apple silicon build) from [nodejs.org/dist/latest-v26.x](https://nodejs.org/dist/latest-v26.x/), checks it against the SHA-256 sums published there (`SHASUMS256.txt`), and unpacks it into `~/.local/share/portable-node`. On 2026-11-03 that was v26.13.0.

- **Only portable uses it.** `~/.local/bin/portable` starts `bin/portable.mjs` with it, and the environment pages run on it too. It isn't put on your `PATH`, so `node` in your terminal is whatever it was before, and a Node from Homebrew or nvm stays as it is.
- **Patch updates:** run `install.sh` again. It moves to the newest 26.x when there is one and deletes the old copy; otherwise it changes nothing. `portable update` doesn't touch Node.
- **Changing the line:** `NODE_MAJOR` at the top of `install.sh`. Keep `package.json`'s `engines` and the check in `lib/doctor.mjs` in step.
- **Running a clone without installing:** `bin/portable` falls back to the `node` on your `PATH` when portable's own isn't there, and `portable doctor` warns that it's not the pinned one.

`./uninstall.sh` deletes `~/.local/share/portable-node`.

### Carrying settings to another Mac

An environment's settings (allowed hosts, skills and rules turned off, AWS profile, size) and its sticky ports live on this Mac in `~/.config/portable`: `config.json` for the defaults and `envs/<name>.json` per environment. Nothing in there is secret or machine-specific, so the folder can be a git repo that your Macs share:

```sh
cd ~/.config/portable && git init && git add . && git commit -m "portable settings" && git remote add origin <your-settings-repo> && git push -u origin main
```

On another Mac, install with it:

```sh
./install.sh --settings <your-settings-repo>
```

`install.sh` clones it into `~/.config/portable` when there's nothing there yet (and pulls it when it's already that clone and has no local changes). Environments are keyed by folder path, so they match when your projects live at the same paths on both Macs (the default `~/Projects/...` does, as long as your user name is the same). Commit and push after changing settings on a page; `install.sh` doesn't push for you. The page tokens and agent state are in `~/.local/state/portable`, which stays per Mac.

## Updating portable

```sh
portable update
```

Lists the new commits on GitHub and moves the installed copy forward to them. It refuses if the installed copy has changes of its own; make changes in a clone instead. A changed kit (`kit/`) rebuilds when the next sandbox is created; existing sandboxes keep the kit they were made with, so `portable rm` them to pick it up. `portable doctor` warns when an update is waiting.

### Changing portable itself

The version is `version` in `package.json`; bump it when a change is worth telling apart (`portable -v` shows the commit as well, so it isn't needed for every merge). `npm test` runs the tests (Node's built-in runner, no dependencies) and `npm run lint` checks the syntax of every script. They need a Node on your `PATH`; portable's own is at `~/.local/share/portable-node/current/bin`.

Work in a clone (e.g. `~/Projects/portable`), in portable like any other project, and merge the change on GitHub. Then `portable update` brings it to the installed copy. Nothing a session writes reaches the launcher you run until you've merged it; see [Limits](#limits) for protecting the branch.

To try a change before merging, run the clone directly on your computer, e.g. `~/Projects/portable/bin/portable.mjs doctor` (`portable doctor` warns that it's not the installed copy). That runs outside the sandbox, so read what a session changed first, as you would a pull request.

## Updating tool versions

The base images are pinned by digest in `kit/portable.dockerfile` (`debian:trixie-slim`) and `lib/sbx.mjs` (Docker's Claude workload), so two Macs build the same image weeks apart; `docker buildx imagetools inspect <image:tag>` gives the digest of a newer tag. The tool versions are pinned in `kit/portable.dockerfile` (`TERRAFORM_VERSION`, `GH_VERSION`, `PNPM_VERSION`, `AWS_CLI_VERSION`) with the SHA-256 of each download next to them; change both. Claude Code's version comes from Docker's workload, pinned in `lib/sbx.mjs` (`WORKLOAD`): pick a newer tag from [Docker Hub](https://hub.docker.com/r/docker/sbx-kit-claude/tags). New sandboxes get the new versions; `portable rm` existing ones to rebuild them.

## Verify the setup

Open a new terminal, then run:

```sh
portable doctor
```

It creates a throwaway sandbox for the second half, which takes a while; `portable doctor --no-sandbox` runs only the checks on this computer. Ctrl-C mid-run still removes the test sandbox.

It checks your computer first: sbx and its sign-in, that portable runs on its own Node 26, `config.json`, the workspace folder, the kit, the Keychain tokens and whether sbx reads them, your git identity, the AWS profiles of environments that turned AWS on, and whether portable is current. Then it creates a throwaway sandbox and checks, before deleting it:

- **Sandbox:** runs as an ordinary user, sees only the folder it started in and nothing else on your computer.
- **Credentials:** no real Claude or GitHub token is readable in the sandbox, and git is set to use the proxy-managed one.
- **Tools:** the versions of Claude Code, git, gh, the AWS CLI, Terraform, pnpm, Docker and Compose.
- **Claude configuration:** your skills, rules and `CLAUDE.md` are installed, read-only and current, portable's `/start`, `/stop` and `/ui` and managed `CLAUDE.md` are there, and the settings carry no macOS-only paths.
- **Access:** Claude answers a one-line prompt, GitHub accepts the token, and AWS answers `sts get-caller-identity` when a profile is set.
- **Docker:** the sandbox's engine pulls from Docker Hub, containers it starts see the workspace folder and nothing else, and their ports are on `localhost`.
- **Ports and the page:** a port a test container publishes is forwarded to the host, answers there and is closed again when the container goes; the environment page starts, answers with its token and refuses a request without it.
- **Network:** allowed hosts (npm, the Terraform registry) are reachable and other sites are blocked, from the sandbox and from containers Docker starts.

Each line says `ok`, `warn`, `skip` or `FAIL`, and the command exits non-zero if anything failed. The Claude check sends a tiny prompt, so it uses a few tokens, and it needs the `/login` from step 2 to have happened once.

One thing it can't check without changing a repo: pushing. Push a branch to a repo your token covers, and check that a push to one it doesn't cover is refused.

## Troubleshooting

| Message | Fix |
|---|---|
| `Docker Sandboxes (sbx) isn't installed` | Run `install.sh`, or `brew trust docker/tap && brew install docker/tap/sbx` |
| `sbx ... is too old` | `brew upgrade sbx` |
| `signing in to Docker (sbx login)` | Finish the sign-in in the browser; sbx needs a Docker account |
| `no GitHub token stored (optional)` in `portable doctor` | Fine without one for public repos; to push or use `gh`, `portable configure`, then `portable rm` the sandbox so it binds the token |
| GitHub answers 401 or "Invalid username or token" | The token expired or was revoked: make a new one, `portable configure` and replace it, then `portable rm` the sandbox |
| Claude asks to sign in, or doctor says it didn't answer | Run `portable claude` and `/login` once on this computer (step 2) |
| `couldn't clone ... (is a GitHub token stored, and does it include this repo?)` | Add the configuration repo to your token's repository access, then `portable rm` the sandbox |
| `the workspace folder (...) is inside portable ...`, `is too broad` or `would cover a system folder` | Point `workspaceDir` in `config.json` at a dedicated folder, or set it to `""` |
| `... is too broad` or `... holds your computer's settings or secrets` | `cd` into a project folder first. `portable doctor` works from anywhere |
| `run it from the workspace folder (...) or a folder in it` | `cd` into a project in the `workspaceDir` folder, or set `workspaceDir` to `""` in `config.json` to allow any folder |
| `... is the copy of portable that's running` | You ran a clone of portable directly from inside itself. Use the installed `portable` to work on the clone |
| `... is your Claude configuration repo` | Run its `install.sh` to switch to its installed copy, as the message shows |
| `couldn't get AWS credentials for profile ...` | The profile is signed out: click **Sign in** in the page's AWS section, or run `aws sso login --profile <name>` |
| `couldn't forward port ... to the host` | That port and the next free numbers above it couldn't be published; `sbx ls` shows what sbx holds, `lsof -nP -iTCP -sTCP:LISTEN` what the Mac does |
| `couldn't start the page` | The host agent's log is in `~/.local/state/portable/<name>/agent.log` |
| `sbx didn't answer (sbx ls failed)` | sbx's daemon isn't running or is restarting; `sbx ls` shows the error. Running pages keep working and retry on their own |
| The page says `missing or wrong token` | Open it with `portable ui`, which prints the URL with its token |
| A tool fails with "Could not connect to server" or "connection refused" | The network policy blocked it. Add the host on the environment page (`portable ui`) |
| A sandbox misbehaves | `portable rm NAME` and start again; the next `portable` creates a fresh one |

## Removing it

```sh
./uninstall.sh
```

It's safe to re-run. It:

1. Lists portable's sandboxes and asks before deleting them, since their Docker data and Claude history go with them.
2. Asks whether to remove the GitHub token source from sbx (and the Infracost one earlier versions added).
3. If Docker Desktop is still installed, asks whether to delete the leftovers of the Docker-based portable (its engine container, volumes and images).
4. Asks whether to delete your secrets from the Keychain (macOS).
5. Stops any environment page still running, and deletes portable's own Node.
6. Removes the `portable` command and the PATH lines `install.sh` added to `~/.zshrc` (a backup is saved as `~/.zshrc.portable-backup`). The PATH line stays if other programs are in `~/.local/bin`.
7. Asks whether to delete the installed copy (`~/.local/share/portable`) and your settings (`~/.config/portable`: `config.json` and every environment's settings and sticky ports, plus `~/.local/state/portable`). Every question defaults to no; anything you keep is named at the end of that step, e.g. "Kept your settings in ~/.config/portable", and a reinstall picks your settings up again.

`./uninstall.sh --yes` answers yes to everything. It never touches your project folders, clones of portable in them, other sandboxes or sbx itself (`brew uninstall sbx`).
