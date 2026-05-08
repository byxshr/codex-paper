---
name: paper-webui
description: Start, rebuild, or restart the Codex Paper local web viewer so the user can browse and study saved papers.
---

# Start Web UI

This skill starts the Codex Paper web viewer using the production Nuxt.js server in [src/web](../../src/web).

## Step 1: Check Dependencies

Before starting the viewer:

- Ensure the plugin-level dependencies in [package.json](../../package.json) are installed if the paper parser scripts will be used.
- Ensure the web dependencies in [src/web/package.json](../../src/web/package.json) are installed.
- If `src/web/node_modules` looks corrupted, reinstall the web dependencies before continuing.

## Step 2: Build the Production Server

Use the web app in [src/web](../../src/web) and compare its build marker with the plugin version in [../../.codex-plugin/plugin.json](../../.codex-plugin/plugin.json).

- If `.output/server/index.mjs` is missing, build the app.
- If `.output/.build-version` does not match the plugin version, rebuild the app and refresh `.output/.build-version`.
- Otherwise, reuse the existing production build.

## Step 3: Manage Port 5815

- If port `5815` is already in use by the Codex Paper viewer recorded in `/tmp/codex-paper-webui.pid`, reuse it when the build version matches.
- If the recorded server is stale or built from an older plugin version, stop it and restart the viewer.
- If another unrelated process owns the port, surface that conflict to the user instead of killing it.

## Step 4: Start and Verify the Viewer

- Prefer the helper script [../../scripts/start-webui.sh](../../scripts/start-webui.sh) so startup, PID management, and health checks are deterministic.
- The script starts the built server in the background on port `5815`.
- The script writes `/tmp/codex-paper-webui.pid` and verifies readiness with `http://localhost:5815/api/papers`.

## Step 5: Report Back

Tell the user:

- The viewer URL: `http://localhost:5815`
- Whether the server was reused or rebuilt
- How to stop it: `kill $(cat /tmp/codex-paper-webui.pid)`
