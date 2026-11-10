---
name: stop
description: Stops a workspace project's Docker Compose stack in this sandbox's Docker engine, keeping its data. Use when the user types /stop (optionally with a project folder), or asks to stop, shut down or bring down a project.
---

# Stop a project

Runs the project's `docker compose down` in the sandbox's engine.

## 1. Pick the project

Same as the `start` skill:

- If the user named a folder (`/stop api`), use `$WORKSPACE_DIR/<folder>`.
- Otherwise, if the current folder has a compose file, use it.
- Otherwise, if `$WORKSPACE_DIR` has one, use it.
- Otherwise list the subfolders of `$WORKSPACE_DIR` that have one and ask which.

## 2. Stop it

```sh
cd "<project>" && docker compose down
```

- Never add `-v`/`--volumes` or `--rmi`: volumes hold the project's databases and `node_modules`. Only if the user explicitly asks to wipe its data, and confirm first.
- Leave other projects' containers alone; other sessions may be using them.

## 3. Report

```sh
cd "<project>" && docker compose ps --all
```

Confirm nothing is left, or list what still is. portable drops the host-side forwards of ports that went away within a few seconds (`/etc/portable/ports` loses their lines), so there's nothing to clean up on the host.
