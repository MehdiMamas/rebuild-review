# Driving an Electron app

Platform `electron`. The app is a desktop program with windows and no address. `run.json` has no `address`; it has `launch`: `{ "executablePath"?, "args", "schemes"? }`.

## Start and stop
- Use `launchApp` from `<plugin>/adapters/electron/launch.mjs`: `const s = await launchApp(run, appFile)`. It runs `install` and `build` once, starts the app with Playwright's Electron support in an isolated profile (own user data, home and environment, no real credentials), and returns `{ app, page, rec, faults, windows, stop }`. Call `await s.stop()` when you are done.
- Do not start the app any other way. A request to an outside address from a window is blocked and listed; the main process is sent to a dead proxy, so it cannot reach the network either.
- If the app turns off the `EnableNodeCliInspectArguments` fuse, it cannot be driven; the launch fails with that reason.

## Drive
- `s.page` is the first window. `s.windows` lists all windows; a window is named by its title (its kind). Use roles, labels and visible text, as a person would.
- Native dialogs (open, save, message) are answered with "canceled" and listed; they never block. `s.faults.slowMs` and `s.faults.failApi` delay or fail the app's own fetch and XHR requests.
- Some screens need a sign-in; the profile is empty, so those are not reached. Say so.

## Steps in states.json
`open` names a window kind (the window title), not a path. `click`, `type`, `press`, `wait`, `failRequest` and `slowRequest` are as in `adapters/CONTRACT.md`.

## Tests
- A parity test reads the path of the run file from `process.env.APP_RUN` (not `APP_URL`).
- Import `launchApp` by absolute path: `import { launchApp } from '<plugin>/adapters/electron/launch.mjs'`, read `APP_RUN` as JSON, call `launchApp(run, process.env.APP_RUN)`, and `stop()` at the end.
- Each test launches its own isolated copy of the app. Install and build have already run (`RR_PREPARED=1`).
- The limit is 60 seconds per test, or the launch time plus 60 seconds if the launch alone is longer.
