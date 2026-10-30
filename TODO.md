# To do

## Before pushing
- [x] Build `portable doctor` (replaces a test suite: checks tools, secrets, mounts and firewall) and run it clean
- [x] Verify Claude starts in the container with your real credential (doctor: "Claude answered (subscription token)")
- [ ] Verify a push to a repo the token doesn't cover fails (a dry-run push to System, which it covers, works since 2026-10-29)
- [x] Run `portable doctor` with `PORTABLE_AWS_PROFILE` set and signed in (passed 2026-10-29)
- [ ] Run `./uninstall.sh` for real once, then `./install.sh` again (only tested with a stand-in `docker`, a fake home folder and a throwaway Keychain entry; the engine's container, volumes and image were added since and are untested)

## Later
- [ ] Once these changes are on GitHub's main, run `./install.sh` from `~/Projects/portable` to switch to the installed copy in `~/.local/share/portable` (until then `portable` still runs the working copy, which hides itself; installing before pushing would install the old version from GitHub)
- [ ] Run `portable update` once for real after a merge (only tested against a local stand-in for GitHub)
- [ ] Try `/start` and `/stop` on Portfolio2 once, from the Mac and in a session (the Mac ones were written from `bin/portable`'s code and the test run was blocked by the permission check; the session ones in `image/skills/` were only checked to load, not run)
- [ ] Check the container's Claude colors now match the host (TERM/COLORTERM are passed through; only the variables were checked, not the colors on screen)
- [ ] Config repo updates briefly show unfiltered `CLAUDE.md`/rules to sessions already running (atomic swap of a versioned clone would close it)
- [ ] Host-side AWS credential endpoint (`AWS_CONTAINER_CREDENTIALS_FULL_URI`) so long sessions refresh instead of relaunching when STS expires
- [ ] Linux/WSL secrets backend (`secret-tool`) for non-Mac hosts
- [ ] Firewall is off (`PORTABLE_FIREWALL=off` in `.env`) because its allowlist works by address and breaks on CDNs: Docker builds resolve through Google DNS and get other Fastly addresses for `dl-cdn.alpinelinux.org` than the engine allowed, and Docker Hub's addresses rotate between 5-minute refreshes. If we want it back, more restricted: DNS-aware filtering with dnsmasq in the engine (Alpine `dnsmasq-dnssec-nftset`, a new package, needs approval and a Scout scan). It answers only allowed names (`address=/#/` for the rest), adds each address it returns to the nft set with `--nftset`, and the firewall blocks every other DNS server, so containers, builds and the engine all resolve through it. That also fixes AWS APIs on EC2-labelled addresses and closes DNS exfiltration. Projects will then need hosts like `binaries.prisma.sh` (Prisma) in `PORTABLE_ALLOW_DOMAINS`
- [ ] `/usage` limit bars missing in the container: the `setup-token` token lacks the `user:profile` scope (README, Claude credential). Find a way without copying the host's full Keychain login
- [ ] Revisit Docker Sandboxes (`sbx`) if it adds AWS support; proxy-injected secrets are the stronger model
- [ ] Re-scan `docker:<DOCKER_VERSION>-dind`/`-cli` with `docker scout cves` and move `DOCKER_VERSION` once Docker ships builds with `golang.org/x/net` 0.60+ (CVE-2026-78663, critical; 29.9.2 still has it in runc, containerd, Compose and Buildx as of 2026-10-29)
- [ ] Boot a real project with `docker compose up` in the container and run its tests (only doctor's test containers have run so far)
- [ ] Check `PORTABLE_PORTS` end to end once the engine restarts: Portfolio2 at http://localhost:3000 in the Mac browser and Postgres on 5432 in TablePlus (only the generated compose config and the update notice were tested)
- [ ] Firewall in a separate gateway container, if the engine-privileged bypass starts to matter (code with Docker access can flush the engine's rules)
- [ ] Docker Hub's anonymous pull limit, if hit: a Docker Hub token from the Keychain for the engine
- [ ] `portable_docker-data` only grows; a `portable` command to show and prune it (`docker system df` / `prune`)
- [ ] Retry Portfolio2's `pnpm dev:docker` in the container once the engine restarts with the firewall off (it applies when no session is running)
- [ ] See whether the container's Claude follows `image/claude-instructions.md` (managed `CLAUDE.md`): blocked hosts reported, not worked around; installs through compose, not on the shared `node_modules`
