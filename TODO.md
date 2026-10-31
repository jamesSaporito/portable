# To do

## Before pushing

## Later
- Port forwarding (2026-10-30, written but not yet run end to end): `portable doctor` from the workspace for the new "Ports" line; `/start` in `portable claude` on Portfolio2 and open the reported Mac URLs in the browser and TablePlus, then `/stop` and see the forwards go within ~5 s; a second sandbox on the same folder (`portable --name second docker compose up -d`) whose stack wants 3000 should get 3001 on the Mac; two `--worktree` agents in one sandbox whose stacks both want 3000 (the in-sandbox `docker-ports` skill should move one, and `portable ports` shows both); after exiting a session, `pgrep -f ports_watch` finds nothing
- The README says the sandbox reaches "only the hosts in `kit/portable.yaml` and `PORTABLE_ALLOW_DOMAINS`", but sbx's own default policy on this Mac adds 195 allow rules, including `**.openai.com`, `**.chatgpt.com`, `**.cursor.sh`, `**.gitlab.com`, `**.gcr.io` (`sbx policy ls --wide`). Decide whether to prune them (`sbx policy rm`/`reset`) or document them, and fix the README either way
- Blocked hosts answer "Approval required" and can be allowed with `sbx policy approval`; mention in the README that approving one widens the policy
- Verify a push to a repo the token doesn't cover fails (a dry-run push to System, which it covers, worked on 2026-10-29 with the old setup)

- Images built with Cloud Native Buildpacks don't pull in a sandbox (2026-10-30, `adobe/s3mock:5.2.3` on Portfolio2): their layers use absolute paths (`/layers/...`), and sbx runs the sandbox's dockerd and containerd with `GODEBUG=tarinsecurepath=0`, so extraction fails with `archive/tar: insecure file path`. The Mac's Docker, same version, pulls it fine. Decide between another S3 stand-in, re-packing such images, or documenting it in the README
- `portable doctor` once reported `FAIL  sbx has no 'github' secret source` (2026-10-30) while `sbx secret ls` listed it and the sandbox half bound the token fine; the same grep matched right afterwards, so the check is flaky (sbx output while another sbx command runs?). Make it retry or read `sbx secret ls --format json`
- The Mac's own `docker-ports` skill (claude-configuration repo) counts live listeners via lsof but not sbx's forwards from `sbx ls`, so a stopped sandbox's ports look free to a project run on the Mac directly
- Review item 6 (FABLE-SUGGESTIONS.md): `portable-setup settings` merges the Mac's settings over the sandbox's own, so hooks, `mcpServers` and `permissions` a session adds to `~/.claude/settings.json` survive into later sessions; strip those keys from the sandbox's copy before merging
- Review item 2: consider a separate Mac-only token for the `portable` and `claude-configuration` repos so the session token can't push to them at all (needs the sandbox's config clone to use a read-only route)
- Review item 3: check from a sandbox that services on the Mac's localhost (`host.docker.internal`, the gateway IP) are refused, and that DNS can't be used to reach arbitrary hosts
- Review item 7: nothing stops a session writing `.git/hooks` or `.git/config` in the workspace; only the README warns. Consider a check that lists changed hooks after a session
- Review item 8: `debian:trixie-slim` and `docker/sbx-kit-claude:2.1.314` are pinned by tag, not digest; the configuration repo is still cloned and reset as root
- Infracost sends a usage event to `pricing.api.infracost.io/event` on every command and v2.18.3 has no switch for it outside self-hosted pricing mode; revisit if that matters
- Only the Terraform, Terraform-plan and AWS Infracost plugins are baked in; add Terragrunt/CloudFormation/Google/Azure to `kit/portable.dockerfile` if a project needs them
- Once these changes are on GitHub's main, run `./install.sh` from `~/Projects/portable` to switch to the installed copy in `~/.local/share/portable`
- Run `portable update` once for real after a merge (only tested against a local stand-in for GitHub)
- Try `/start` and `/stop` on Portfolio2 once, from the Mac and in a session, now that they go through `sbx exec`
- Check what the sandbox's `~/.claude/CLAUDE.md` looks like after a reboot: Docker's Claude workload materializes its own guidance there and claude-configuration's `install.sh` links the same path; if they fight, deliver the workload's text through `/etc/claude-code/CLAUDE.md` instead
- `resources@1` is fixed at 4 CPUs and 8 GiB in `kit/portable.yaml`; make it configurable (`PORTABLE_MEMORY`/`PORTABLE_CPUS`) once kit args are confirmed to expand into capability config, or via `sbxenv.yaml` when it leaves experimental
- Host-side AWS credential endpoint (`AWS_CONTAINER_CREDENTIALS_FULL_URI` on `host.docker.internal`) so long sessions refresh instead of relaunching when STS expires, and so the keys never sit in the VM
- `*.amazonaws.com` is allowed by name, so any S3 bucket or API Gateway endpoint is a reachable destination; narrow it to the services and region you use once the list is known
- Linux hosts: sbx supports Ubuntu 24.04 with KVM; portable would need a secrets backend other than the Keychain (`secret-tool`) and sbx's file fallback is world-readable per its docs
- Docker Hub's anonymous pull limit, if hit: sbx reuses the Docker login for pulls, so check whether that already covers it
- A sandbox's Docker data only grows; `portable rm`/`prune` reset it, but a `portable df` showing sizes would help
- See whether the sandbox's Claude follows `kit/files/claude-instructions.md` (managed `CLAUDE.md`): blocked hosts reported, not worked around; installs through compose, not on the shared `node_modules`
- `/usage` limit bars: check whether sbx's OAuth `/login` token carries the `user:profile` scope the old `setup-token` lacked
