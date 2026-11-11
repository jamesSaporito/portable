# To do

## Checks left from the Node rebuild
- Run `portable doctor` end to end once the GitHub token works again (the smoke run on 2026-11-03 got "Invalid username or token" when cloning claude-configuration, so it may have expired)
- Try two `--worktree` agents in one sandbox whose stacks both want 3000, and `/start` + `/stop` on Portfolio2, opening the reported host URLs in the browser and TablePlus (needs a real project)
- `install.sh`'s checksum-mismatch path for the Node download wasn't run (only the download, the no-op rerun and the no-terminal refusal were); fake a bad sum once with a terminal
- Run `install.sh` on a Mac without Homebrew or Node (e.g. a fresh macOS user account or VM) and answer yes to each prompt; only the "missing, no terminal" and "answer no" paths were run, since installing would change this Mac
- On a page, turn AWS on with `default`, click Sign in (the agent runs `aws sso login`, which should open the browser from a detached process) and check `aws sts get-caller-identity` works in `portable claude`; then Turn off and check it fails
- Open a page in the browser once and click through Services (start, logs, stop) and the skill/rule checkboxes; the API is tested, the page's own JavaScript isn't
- Try `install.sh --settings <repo>` on a second Mac (or a fresh user account) and check the environments come up with their hosts and sticky ports
- Global hosts that an older portable added with `sbx policy allow network` (no `--sandbox`) still apply to every sandbox; list them with `sbx policy ls --wide` and remove the ones that should be per environment now

## Later
- Offline mode (branch `offline-mode`, 2026-11-10): only unit, API and browser tests ran, against a fake sbx. On a real sandbox, click Go offline and check `sbx policy ls <sandbox> --wide` shows deny rules (wildcards like `**.amazonaws.com` accepted, `decision: "deny"` as assumed), that `portable exec curl -sS -m 5 https://github.com` is refused while `portable claude -p "say hi"` still answers (if not, Claude needs a host outside anthropic.com/claude.ai/claude.com), then Go back online and check the denies are gone and github.com connects. Also keep `github.com` under Kept while offline, go offline, and check `sbx policy ls` has no deny on `github.com` or `**.github.com` and `portable exec curl -sS -m 5 https://github.com` connects; then Remove it and check the curl is refused
- MCP hosts in the kit (2026-11-04): in a new sandbox, `claude mcp add` Atlassian, GitHub and AWS Knowledge and check each connects; Atlassian's and GitHub's OAuth sign-in may need hosts beyond the MCP endpoint (only lint and unit tests ran). The local AWS Documentation server also needs `pypi.org` and `files.pythonhosted.org` for `uvx` to install it, which aren't allowed
- In-place kit update: `portable doctor` could check `sbx kit add` still exists (experimental in sbx 0.51.0)
- Replacing the GitHub token: check an existing sandbox picks up a newly stored one without `portable rm` (within sbx's 55-minute cache), and that a failed configuration clone succeeds at the next start. The README now says so from Docker's docs and `portable-setup update`, not from a run
- Kit builds now go through sbx's builder sandbox (`SBX_KIT_BUILDER=sandbox`, undocumented, found in sbx 0.51.0). Only `sbx create` was run by hand with it on this Mac (docker driver, containerd store off); run a real `portable` with it, once with the containerd store on, and recheck the variable after sbx upgrades
- Linux hosts are out of scope on purpose (Keychain secrets); if that changes, the pieces needed are a Secret Service backend, `ss` for port detection, Docker's apt route for sbx and the linux Node builds
- The environment page has no way to recreate a sandbox (for new CPUs/memory); it shows the commands instead, since that deletes Docker data. Add a button with a confirmation if that gets tedious
- The README says the sandbox reaches only the kit's hosts and the environment's allowed hosts, but sbx's own default policy on this Mac adds 195 allow rules, including `**.openai.com`, `**.chatgpt.com`, `**.cursor.sh`, `**.gitlab.com`, `**.gcr.io` (`sbx policy ls --wide`). Decide whether to prune them (`sbx policy rm`/`reset`) or document them, and fix the README either way
- Blocked hosts answer "Approval required" and can be allowed with `sbx policy approval`; mention in the README that approving one widens the policy
- Verify a push to a repo the token doesn't cover fails (a dry-run push to System, which it covers, worked on 2026-10-29 with the old setup)
- Images built with Cloud Native Buildpacks don't pull in a sandbox (2026-10-30, `adobe/s3mock:5.2.3` on Portfolio2): their layers use absolute paths (`/layers/...`), and sbx runs the sandbox's dockerd and containerd with `GODEBUG=tarinsecurepath=0`, so extraction fails with `archive/tar: insecure file path`. The Mac's Docker, same version, pulls it fine. Decide between another S3 stand-in, re-packing such images, or documenting it in the README
- The Mac's own `docker-ports` skill (claude-configuration repo) counts live listeners via lsof but not sbx's forwards from `sbx ls`, so a stopped sandbox's ports look free to a project run on the Mac directly
- The configuration repo is still cloned and reset as root in the sandbox; a dedicated uid would be safer
- Consider a separate Mac-only token for the `portable` and `claude-configuration` repos so the session token can't push to them at all (needs the sandbox's config clone to use a read-only route)
- Check from a sandbox that services on the Mac's localhost (`host.docker.internal`, the gateway IP) are refused, and that DNS can't be used to reach arbitrary hosts
- Nothing stops a session writing `.git/hooks` or `.git/config` in the workspace; only the README warns. Consider a check that lists changed hooks after a session
- Infracost was taken out of the sandbox for now (2026-11-04); bring it back from git history (`kit/portable.dockerfile`, the kit's credential and allowed hosts, doctor, configure) if needed. Its CLI sent a usage event to `pricing.api.infracost.io/event` on every command with no switch outside self-hosted pricing mode
- Once these changes are on GitHub's main, run `./install.sh` from `~/Projects/portable` to switch to the installed copy in `~/.local/share/portable`
- Run `portable update` once for real after a merge (only tested against a local stand-in for GitHub)
- Try `/start` and `/stop` on Portfolio2 once, from the Mac and in a session, now that they go through `sbx exec`
- Check what the sandbox's `~/.claude/CLAUDE.md` looks like after a reboot: Docker's Claude workload materializes its own guidance there and claude-configuration's `install.sh` links the same path; if they fight, deliver the workload's text through `/etc/claude-code/CLAUDE.md` instead
- Host-side AWS credential endpoint (`AWS_CONTAINER_CREDENTIALS_FULL_URI` on `host.docker.internal`) so long sessions refresh instead of relaunching when STS expires, and so the keys never sit in the VM
- `*.amazonaws.com` is allowed by name, so any S3 bucket or API Gateway endpoint is a reachable destination; narrow it to the services and region you use once the list is known
- Docker Hub's anonymous pull limit, if hit: sbx reuses the Docker login for pulls, so check whether that already covers it
- A sandbox's Docker data only grows; `portable rm`/`prune` reset it, but a `portable df` showing sizes would help
- See whether the sandbox's Claude follows `kit/files/claude-instructions.md` (managed `CLAUDE.md`): blocked hosts reported, not worked around; installs through compose, not on the shared `node_modules`
- `/usage` limit bars: check whether sbx's OAuth `/login` token carries the `user:profile` scope the old `setup-token` lacked
- With `workspaceDir` empty (the new default), start a real sandbox from a project outside `~/Projects` and run `portable doctor` from `~`; only the folder checks were run against real paths, not a sandbox
- `/ui` in a real session: create a sandbox with `portable claude` (the page should open in the browser by itself), then type `/ui` and Cmd-click the link; only the unit tests and lint ran, not a sandbox
- Change the configuration repo on a real page (set, switch to another repo, clear) and check a second environment switches at its next `portable`; only unit tests and a local run of the clone switching (with the Linux-only linking stubbed) were done, not a sandbox
