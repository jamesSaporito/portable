---
name: ui
description: Gives the link to this environment's page on the host (ports, services, allowed hosts, AWS, Claude configuration). Use when the user types /ui, or asks for the environment's page, its settings page or the portable UI.
---

# Link to the environment page

The page runs on the host, not in here, so don't try to open or fetch it; give the user the link.

```sh
cat /etc/portable/page 2>/dev/null
```

- Reply with the address as a bare link on its own line (e.g. `http://127.0.0.1:52817/`), and say to Cmd-click it (Ctrl-click on other systems) to open it in their browser.
- Add one line: if the page says the browser doesn't have its token yet, run `portable ui` once on the host in this project's folder; the link works on its own after that.
- If the file is missing or empty, the page hasn't started: say to run `portable ui` on the host in this project's folder.
