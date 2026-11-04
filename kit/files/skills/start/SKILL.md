---
name: start
description: Boots a workspace project's Docker Compose stack in this sandbox's Docker engine, detached. Use when the user types /start (optionally with a project folder), or asks to start, boot or bring up a project.
---

# Start a project

Runs the project's `docker compose up` in the sandbox's engine, which `docker` in here already talks to. The project keeps running after this session ends, as long as the sandbox does.

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
- If it fails, show the error. For a blocked host, point at the environment's page (`portable ui` on the host), where it can be allowed; for "port is already allocated", at whatever else in the sandbox (`docker ps`) uses that port.

## 3. Report

```sh
cd "<project>" && docker compose ps --all
```

Give each service's state, and flag any that exited non-zero (show the last lines of `docker compose logs <service>`).

Then the host URLs. portable forwards every port a container publishes to the host within a few seconds and records the mapping in `/etc/portable/ports` (`<sandbox port> <host port>` per line). Wait for it to list each port the stack publishes, up to about 20 seconds:

```sh
for i in $(seq 20); do grep -qE '^<port> ' /etc/portable/ports 2>/dev/null && break; sleep 1; done; cat /etc/portable/ports
```

Report each service's host URL, `http://localhost:<host port>`, and say when the host port differs from the sandbox port (another sandbox or host process had it). If a port never appears, say the stack is reachable in here only, and that running `portable ports` on the host forwards it.
