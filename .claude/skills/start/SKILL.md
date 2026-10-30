---
name: start
description: Boots a workspace project's Docker Compose stack in portable's Docker engine, detached, from the Mac, without opening a portable shell. Use when the user types /start (optionally with a project folder), or asks to start, boot or bring up a project in portable.
---

# Start a project in portable

Runs the project's `docker compose up` through `bin/portable`, so it goes to portable's engine (`portable-engine`), not Docker on the Mac. The dev container exits once Compose returns; the project keeps running in the engine.

## 1. Pick the project

- Read the workspace folder from `WORKSPACE_DIR` in this repo's `.env` (only that line), expanding `~`. Default `~/Projects/sandboxed`.
- If the user named a folder (`/start api`), use `$WORKSPACE_DIR/<folder>`.
- Otherwise, if `$WORKSPACE_DIR` has a compose file (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`), use it.
- Otherwise list the subfolders that have one and ask which. Stop if there are none.

## 2. Boot it

From the project folder (`portable` starts the container in the matching folder):

```sh
cd "<project>" && portable docker compose up --build --detach
```

- Allow up to 10 minutes; the first build and `portable`'s own image build can be slow.
- Don't add `--wait`: one-shot services (e.g. an `install` step) exit and would make it fail.
- Don't pass `-v`, change the project's compose file or `.env`, or run installs on the Mac.
- If `portable` says the engine has an update waiting, mention it; it applies once no session is running.
- If it fails, show the error. For a blocked host, point at `PORTABLE_ALLOW_DOMAINS`; for "port is already allocated", at whatever uses that port on the Mac.

## 3. Report

```sh
cd "<project>" && portable docker compose ps --all
```

Give each service's state, and flag any that exited non-zero (show the last lines of `portable docker compose logs <service>`). For each published port, say whether it's in `PORTABLE_PORTS` in `.env`: those open at `http://localhost:<port>` on the Mac; the others only inside portable. Suggest adding missing ones to `PORTABLE_PORTS` (applies when no session is running) rather than editing it yourself.
