---
name: stop
description: Stops a workspace project's Docker Compose stack in portable's Docker engine from the Mac, keeping its data. Use when the user types /stop (optionally with a project folder), or asks to stop, shut down or bring down a project running in portable.
---

# Stop a project in portable

Runs the project's `docker compose down` through `bin/portable`, against portable's engine. It's not `portable stop NAME`, which ends a portable session.

## 1. Pick the project

Same as the `start` skill:

- Read `WORKSPACE_DIR` from this repo's `.env` (only that line), expanding `~`. Default `~/Projects/sandboxed`.
- If the user named a folder (`/stop api`), use `$WORKSPACE_DIR/<folder>`.
- Otherwise, if `$WORKSPACE_DIR` has a compose file, use it.
- Otherwise list the subfolders that have one and ask which.

## 2. Stop it

```sh
cd "<project>" && portable docker compose down
```

- Never add `-v`/`--volumes` or `--rmi`: volumes hold the project's databases and `node_modules`. Only if the user explicitly asks to wipe its data, and confirm first.
- Leave the engine (`portable-engine`) and portable's sessions running; other projects and sessions use them.

## 3. Report

```sh
cd "<project>" && portable docker compose ps --all
```

Confirm nothing is left, or list what still is.
