---
name: test-ui
description: Runs portable's browser tests for the environment page (Playwright, test/ui), on the Mac with Google Chrome or in a portable sandbox in a throwaway Chromium container. Use when the user types /test-ui (optionally with a test name or file), asks to run the UI, browser or Playwright tests, after changing the page (lib/ui) or its API, and as part of running this project's checks.
---

# Run the browser tests

The tests serve the real page against a fake sbx and drive it in a headless browser. Which command runs them depends on where this session is.

## 1. Pick the command

```sh
uname -s
```

- `Darwin` (the Mac): `npm run test:ui`. It uses the Google Chrome installed on the Mac. If Playwright says Chrome isn't found, say so and stop; don't run `playwright install`.
- `Linux` (a portable sandbox, which has no Chrome): `npm run test:ui:docker`. It runs the tests in a container on the sandbox's Docker with Debian's Chromium, installed on each run (about 30 seconds, mostly the download). The container is removed afterwards, along with the base image if the run pulled it, and the repo is mounted read-only, so there's nothing to clean up.

Either way, run it from the project root after `npm install` (if `node_modules/@playwright/test` is missing, run `npm install` first).

## 2. Run them

Arguments go to `playwright test`, so pass what the user named: a file (`test/ui/network.spec.mjs`) or `-g "<part of a test's name>"`.

```sh
npm run test:ui:docker -- -g "Go offline"
```

- Allow up to 5 minutes.
- Don't change `playwright.config.mjs` or `scripts/test-ui-docker.mjs` to get past a failure without saying so; don't add `--retries` or skip tests.
- In the sandbox, an apt error means `deb.debian.org` or Docker Hub was blocked (offline mode, or the network policy); point at the environment's page (`portable ui` on the Mac). Don't try to install Chromium in the sandbox itself.

## 3. Report

Give the pass/fail count from the last lines. For each failure, the test's name, the expected and received values from Playwright's output, and the file and line. On the Mac, Playwright keeps traces and screenshots of failures in `test-results/` (git-ignored); in the sandbox they went with the container, so rerun the failing test on the Mac if they're needed.
