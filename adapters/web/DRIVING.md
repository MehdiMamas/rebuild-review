# Driving a web app

Platform `web`. The app is a server on this machine; `run.json` has its `address`.

## Start and stop
- Run `install`, `build` and `start` from the copy named in `run.json` (the `dir` inside `work/`). Never run the target itself.
- Set the `PORT` environment variable to the port in `address`. Wait until the address answers. Stop the server when you are done.

## Drive
- Use a headless browser. If none is installed, install `playwright` and its Chromium in a scratch folder outside `work/` and the target, and use it. Do not give up on using the app.
- Open the address, use every screen, control, keyboard key and URL option you can find, and try slow and failing requests (Playwright `route` can delay or fail a request).

## Steps in states.json
`open` takes a path or address on the app's own server. `click`, `type`, `press`, `wait`, `failRequest` and `slowRequest` are as in `adapters/CONTRACT.md`.

## Tests
- A parity test reads the address from `process.env.APP_URL`.
- Import the driver by absolute path: `import { chromium } from '<plugin>/adapters/web/node_modules/playwright/index.mjs'`.
- Each test launches its own browser and closes it at the end. The tests share one running server, so earlier tests leave data behind.
