---
name: stop
description: Stops a workspace project's Docker Compose stack in its portable sandbox from the Mac, keeping its data. Use when the user types /stop (optionally with a project folder), or asks to stop, shut down or bring down a project running in portable.
---

# Stop a project in portable

Runs the project's `docker compose down` through `bin/portable`, in the project's sandbox. It's not `portable stop NAME`, which pauses a whole sandbox, nor `portable rm NAME`, which deletes one.

## 1. Pick the project

Same as the `start` skill:

- If the user named a folder (`/stop api`), use that folder, relative to the current one.
- Otherwise, if the current folder has a compose file, use it.
- Otherwise list the subfolders that have one and ask which.

## 2. Stop it

```sh
cd "<project>" && portable docker compose down
```

- Never add `-v`/`--volumes` or `--rmi`: volumes hold the project's databases and `node_modules`. Only if the user explicitly asks to wipe its data, and confirm first.
- Leave the sandbox itself running; other sessions may be using it.

## 3. Report

```sh
cd "<project>" && portable docker compose ps --all
```

Confirm nothing is left, or list what still is. `portable` drops the Mac-side forwards of ports that went away when the command returns, so there's nothing to clean up on the Mac.
