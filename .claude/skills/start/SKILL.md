---
name: start
description: Boots a workspace project's Docker Compose stack in its portable sandbox, detached, from the Mac, without opening a portable shell. Use when the user types /start (optionally with a project folder), or asks to start, boot or bring up a project in portable.
---

# Start a project in portable

Runs the project's `docker compose up` through `bin/portable`, so it goes to the project's sandbox and its own Docker engine, not Docker on the Mac. The command returns once Compose does; the project keeps running in the sandbox.

## 1. Pick the project

- If the user named a folder (`/start api`), use that folder, relative to the current one.
- Otherwise, if the current folder has a compose file (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`), use it.
- Otherwise list the subfolders that have one and ask which. Stop if there are none.

## 2. Boot it

From the project folder (`portable` uses the sandbox for the folder it's run in, creating it on first use):

```sh
cd "<project>" && portable exec docker compose up --build --detach
```

- Allow up to 10 minutes; the first build, and creating the sandbox the first time, can be slow.
- Don't add `--wait`: one-shot services (e.g. an `install` step) exit and would make it fail.
- Don't pass `-v`, change the project's compose file or `.env`, or run installs on the Mac.
- If it fails, show the error. For a blocked host, point at **Extra allowed hosts** on the environment's page (`portable ui`); for "port is already allocated", at whatever else in that sandbox uses the port.

## 3. Report

```sh
cd "<project>" && portable exec docker compose ps --all
```

Give each service's state, and flag any that exited non-zero (show the last lines of `portable exec docker compose logs <service>`).

Then the Mac URLs. `portable` forwards every port the stack publishes to the Mac after the command above returns, at the same number when the Mac has it free and otherwise at the next free one. List the mapping:

```sh
cd "<project>" && portable ports
```

Report each service's Mac URL, `http://localhost:<Mac port>`, and say when the Mac port differs from the port in the compose file.
