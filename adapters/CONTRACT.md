# Adapter contract

An adapter captures one platform's running app into a `golden/` folder. The rest of the
review (inventory, rebuild, parity, score) reads only that folder, so every adapter must
produce the same layout.

## Input

`run.json`, written by the capture agent next to the cloned copy of the target:

```
{ "platform": "...", "dir": "path inside work/", "install": "...", "build": "...", "start": "...", "address": "..." }
```

- `env` is optional: an object of environment variables the adapter adds when it starts the app (`{...process.env, ...env, PORT}`), so the original and the rebuild start with the same settings. `rebuild-run.json` gets the same `env`, copied from `run.json` after the build is delivered. Values are stand-ins only, never real secrets; they are never printed or put in the report.

An Electron app has no address. Its `run.json` is `{ "platform": "electron", "dir", "install", "build", "launch": { "executablePath"?, "args", "schemes"? } }`: `args` start the app (usually `["."]`), `executablePath` overrides the Electron found in the app's own dependencies, `schemes` names the app's own URL schemes (allowed like `file:`). How an agent starts and drives each platform is in `adapters/<platform>/DRIVING.md`, which the workflow points the finders and the test writer to.

- `dir` is relative, never absolute (the adapter throws otherwise): to `work/` next to `run.json`, except in a file named `rebuild-run.json`, where it is relative to that file's own folder.
- The target is never run in place. The agent clones it to `<runDir>/work/` and the adapter runs that copy.
- The adapter refuses an address that is not on this machine.

Call: `capture --app <run.json> --out <runDir>/golden [--states states.json]`

## Output

```
golden/manifest.json       platform, app version, screens, states, blocked requests, what could not be captured
golden/screens/<id>/       render.* (the rendered structure and computed style), a11y.json, <size>-<theme>.png
golden/network.har         every request and response, secrets removed
golden/timings.json        list of { name, value, unit }
golden/probes.json         list of { probe, screen, passed, evidence }; passed=false means the probe flagged a problem
golden/console.log         errors the app printed
golden/a11y-violations.json  optional: list of { screen, violations: [{ id, impact, nodes }] }
```

Screenshots are taken at a narrow and a wide size, in light and dark theme. Web: 390 and 1440 px wide. Electron: window content sizes 1024x700 and 1440x900; a window that refuses a size is noted in `manifest.json` `notCaptured`, as is a size where light and dark gave identical pixels ("theme did not change").

`coverage.json` lists `screensReached`, `screensCut` (anything over `--max-screens`), `buttonsSkipped` and `harEntriesSkipped`. `manifest.json` also has `nativeDialogs` (Electron: each dialog the app asked for, answered "canceled").

### Screen identity (Electron)

A screen is the pair (window title kind, signature), where the signature is a hash of the window's accessibility snapshot with digits blanked. The crawl clicks every `button`, `[role=button|tab|menuitem|treeitem|link]`; a new signature is a new screen with the `steps` that reach it. To return to a screen the app is relaunched and the steps replayed. A window the app opens is crawled too, with `openedFrom` naming its parent. `open` in a step names a window kind (its title), not a path. Launch time is `launch-ms` in `timings.json`.

### What an Electron capture does not see

Requests made by the main process are not observed (only windows are); the app runs with `--proxy-server` and the proxy variables pointed at a dead address, so they cannot leave the machine. This is measured by `adapters/electron/test/run.mjs` check 5 (a main-process `fetch` to a server on this machine's network address; the hit count must be 0). Requests over a custom protocol handled in the main process are invisible to the driver. Anything behind a sign-in is not reached: the profile is empty and isolated.

## Score outputs (optional)

The score phase reads these `timings.json` names. An adapter that lacks one shows up as "not measured" in the score, never as 0. Per-screen names are `<screen>.<name>`; the score uses the worst across screens.

| name | meaning |
|---|---|
| `<screen>.lcp` (ms), `<screen>.cls` | largest contentful paint and cumulative layout shift, wide size, light theme |
| `<screen>.bytes` | encoded bytes transferred on an uncached load |
| `<screen>.heap-mb` | JS heap in use after load |
| `<screen>.overflow-narrow` (px) | horizontal overflow at the narrow size, at least 0 |
| `inp-ms` | stand-in for INP: the slowest input event in the typing probe. One typing run, not field INP |
| `build-ms` | time of the `build` command (install is not timed) |
| `script-ms-per-key` | see Probes |

`a11y-violations.json` lists accessibility rule violations per screen. Compatibility is measured narrowly: Chromium only, so other browsers are reported as not checked.

## states.json

A list of `{ id, steps }`. Each step is exactly one of:

| step | meaning |
|---|---|
| `{ "open": "<path or address>" }` | go to a screen |
| `{ "click": "<name>" }` | activate the control with that accessible name or text |
| `{ "type": { "into": "<name>", "text": "..." } }` | type into the field with that name |
| `{ "press": "<key>" }` | press a key |
| `{ "wait": <ms> }` | pause |
| `{ "failRequest": "<address part>" }` | answer matching requests with a failure |
| `{ "slowRequest": { "match": "<address part>", "ms": <n> } }` | delay matching requests |

Targets are named the way a person would name them, never by internal identifiers. The adapter
simulates failures and delays itself; it never relies on switches inside the app. The state's
screen is captured when its steps finish. The crawl writes the first list and #6 later writes more,
so capture runs twice.

## Probes

Each probe is a general check for one kind of failure, not a check for a known app. Required kinds:
focus lost while typing, input delay, layout shift, repeated identical requests, errors in the
console, no visible feedback during a slow request, a failed request with no visible error (only requests the app's own code made count: framework route prefetches and client navigation payloads, such as headers `sec-purpose`/`purpose` prefetch, `next-router-prefetch`, `rsc` without `next-action`, and `/_next/data/` paths, are not data requests), script time per keystroke (`script-cost-per-key`: script time over 5 characters typed 100 ms apart into the first text input of each screen, CPU throttled 4x; the worst value goes to `timings.json` as `script-ms-per-key`, `passed` means 16 ms or less, one frame).

## Parity

Call: `parity --app <run.json> --tests <dir> --out <results.json>`

The adapter starts the app named in `run.json`, passes its address in the `APP_URL` environment variable (an Electron app has no address: each test gets `APP_RUN`, the path of the run file, and launches its own isolated copy with `launchApp` from `adapters/electron/launch.mjs`), runs each `<dir>/F-*.test.*` (one file per feature, named by feature ID) with a 60 second limit (Electron: or the launch time plus 60 seconds when the launch alone takes longer, measured once at the start), and stops the app. Results: a list of `{ feature, passed, detail }`, `detail` being the last lines of the test's output. The same safety rules as capture apply. A platform with no `parity` entry point has no parity phase: the workflow stops with a plain reason.

## Safety, enforced in code

- Requests to anything but the app's own address are blocked and listed in `manifest.json`.
- Credentials and token-like values never reach the files in `golden/`.
- The target's folder is not written to.

## Web

The web adapter lives in `adapters/web/`. Address is a localhost URL. It starts the app from
`install`, `build` and `start` in `work/<dir>`, with the port in the `PORT` environment variable.
It drives Chromium: crawl by following links and clicking buttons on the app's own origin, sizes
390 and 1440 wide, `render.html` and `render.css.json` as the render files, the accessibility tree as
`a11y.json`, a HAR as `network.har`. Probes are in `probes.mjs`; the score measurements (LCP, CLS, bytes, heap, narrow overflow, axe-core violations) are in `metrics.mjs`. Parity is `parity.mjs`: each test is a `node --test` file that imports Playwright by absolute path from `adapters/web/node_modules`.

## Per-change check (web)

`node adapters/web/check.mjs --base-url <url> --routes /a,/b [--out <dir>] [--budget-seconds 110] [--storage-state file] [--allow-origin https://x,...]`

A standalone run of the probes on the routes a change touched, against an app that is already running; no run folder. Exit 0 pass, 1 fail, 2 incomplete (nothing failed but something was not checked), 3 error (bad arguments, app unreachable, browser missing). Never a pass for something not checked. `--out` is a directory with `result.json` (`version, status, baseUrl, routes, screenshots, elapsedMs, passed, failed, notChecked, blockedOrigins`) and `<slug>-390.png`, `<slug>-1440.png` per route, taken before any probe. Load probes run first on every route, one at a time; click probes after, 4 at a time; at the budget what has not run goes to `notChecked`. A route that ends on another path is `notChecked`. Blocked cross-origin requests are listed, not counted as console errors. Clicks on labels that look destructive or outward-facing are skipped and listed; on a non-localhost base URL no click runs.
