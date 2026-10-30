---
name: start
description: Boots a workspace project's Docker Compose stack in portable's Docker engine, detached. Use when the user types /start (optionally with a project folder), or asks to start, boot or bring up a project.
---

# Start a project

Runs the project's `docker compose up` in portable's engine, which `docker` in here already talks to. The project keeps running after this session ends.

## 1. Pick the project

- If the user named a folder (`/start api`), use `$WORKSPACE_DIR/<folder>`.
- Otherwise, if the current folder has a compose file (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`), use it.
- Otherwise, if `$WORKSPACE_DIR` has one, use it.
- Otherwise list the subfolders of `$WORKSPACE_DIR` that have one and ask which. Stop if there are none.

## 2. Boot it

```sh
cd "<project>" && docker compose up --build --detach
```

- Allow up to 10 minutes; the first build can be slow.
- Don't add `--wait`: one-shot services (e.g. an `install` step) exit and would make it fail.
- Don't pass `-v`, change the project's compose file or `.env`, or run installs against the workspace directly.
- If it fails, show the error. For a blocked host, point at `PORTABLE_ALLOW_DOMAINS` in portable's `.env`; for "port is already allocated", at whatever else in the engine (`docker ps`) or on the Mac uses that port.

## 3. Report

```sh
cd "<project>" && docker compose ps --all
```

Give each service's state, and flag any that exited non-zero (show the last lines of `docker compose logs <service>`). For each published port, say whether it's in `$PORTABLE_PORTS`: those open at `http://localhost:<port>` on the Mac too; the others only in here. Suggest adding missing ones to `PORTABLE_PORTS` in portable's `.env` (applies when no session is running).
