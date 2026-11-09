# Adapter contract

An adapter captures one platform's running app into a `golden/` folder. The rest of the
review (inventory, rebuild, parity, score) reads only that folder, so every adapter must
produce the same layout.

## Input

`run.json`, written by the capture agent next to the cloned copy of the target:

```
{ "platform": "...", "dir": "path inside work/", "install": "...", "build": "...", "start": "...", "address": "..." }
```

- `env` is optional: an object of environment variables the adapter adds when it starts the app (`{...process.env, ...env, PORT}`), so the original and the rebuild start with the same settings. `rebuild-run.json` gets the same `env`, copied from `run.json` after the build is delivered. Values are stand-ins only, never real secrets; they are never printed or put in the report. The Electron adapter applies `env` too (after its allowlist copy; the isolated home, profile folders and dead proxy still win).

A command-line tool has no address either. Its `run.json` is `{ "platform": "cli", "dir", "install", "build", "command": ["<exe>", "<fixed args>"...], "env"? }`: `command[0]` is a name on PATH or a path inside `work/<dir>` (an absolute path outside the work copy is refused; in a file named `rebuild-run.json`, `dir` is relative to that file's folder as below). A screen is one invocation; `states.json` steps for it are in `adapters/cli/DRIVING.md`.

A service with an HTTP API and no pages has an address, as a web app, plus two optional keys. Its `run.json` is `{ "platform": "backend", "dir", "install", "build", "start", "address", "openapi"?, "readyPath"?, "env"? }`: `openapi` is a path inside `work/<dir>` or a path on the running service (such as `/openapi.json`); `readyPath` (default `/`) is the path polled at start, and any HTTP answer counts as up. `env` values that point at a store outside this machine (a `postgres://` or `redis://` address on another host, a `DB_HOST` that is not local) are refused with the reason. A screen is one operation plus one state; `states.json` steps are in `adapters/backend/DRIVING.md`.

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
golden/probes-not-checked.json  list of { probe, route, reason }: probes and measurements that could not run on a screen (time budget, the window closed or reloaded after a click, a crash); each row is also a string `<probe> <route>: <reason>` in `manifest.json` `notCaptured`
golden/console.log         errors the app printed
golden/a11y-violations.json  optional: list of { screen, violations: [{ id, impact, nodes }] }
golden/coverage.json       optional: screensReached, screensCut (distinct routes the screen cap stopped), sameRouteSkipped [{ route, count }] (same route, different data, left out by --max-per-route, default 2), buttonsSkipped, harEntriesSkipped
```

Screenshots are taken at a narrow and a wide size, in light and dark theme. Backend: none; `manifest.json` `notCaptured` says "no screens or screenshots: HTTP service". CLI: none; `manifest.json` `notCaptured` says "no screens or screenshots: command-line tool". Web: 390 and 1440 px wide. Electron: window content sizes 1024x700 and 1440x900; a window that refuses a size is noted in `manifest.json` `notCaptured`, as is a size where light and dark gave identical pixels ("theme did not change").

`coverage.json` lists `screensReached`, `screensCut` (anything over `--max-screens`), `buttonsSkipped` and `harEntriesSkipped`. `manifest.json` also has `nativeDialogs` (Electron: each dialog the app asked for, answered "canceled").

### Screen identity (Electron)

A screen is the pair (window title kind, signature), where the signature is a hash of the window's accessibility snapshot with digits blanked. The crawl clicks every `button`, `[role=button|tab|menuitem|treeitem|link]`; a new signature is a new screen with the `steps` that reach it. To return to a screen the app is relaunched and the steps replayed. A window the app opens is crawled too, with `openedFrom` naming its parent. `open` in a step names a window kind (its title), not a path. Launch time is `launch-ms` in `timings.json`.

### What an Electron capture does not see

Requests made by the main process are not observed (only windows are); the app runs with `--proxy-server` and the proxy variables pointed at a dead address, so they cannot leave the machine. This is measured by `adapters/electron/test/run.mjs` check 5 (a main-process `fetch` to a server on this machine's network address; the hit count must be 0). Requests over a custom protocol handled in the main process are invisible to the driver. Anything behind a sign-in is not reached: the profile is empty and isolated.

## CLI

`adapters/cli/` (`run.mjs`, `capture.mjs`, `probes.mjs`, `parity.mjs`, `DRIVING.md`). A screen is one invocation: no arguments, `--help`, `-h`, `help`, `--version`, then the subcommands named in the help text (lines indented two or more spaces that start with a lowercase word followed by two or more spaces or a tab), each with `--help`, one level deeper, up to `--max-screens` (30; the rest in `coverage.json` `screensCut`). `golden/screens/<id>/` holds `stdout.txt`, `stderr.txt` (absent when that stream was not text), `result.json` (`args`, `code`, `signal`, `ms`, `timedOut`, `written`) and the text files the run wrote under `out/` (`home/...` or `cwd/...`, up to 256 KB each); non-text output is kept as size and SHA-256 only (`stdoutBinary`, `stderrBinary` in `result.json`, each with `cut` when the stream passed 1 MB), because it cannot be scrubbed. Output is cut at 1 MB per stream and noted in `notCaptured`. `network.har` has no entries. Output and written files go through the same secret scrub as the web HAR.

Every run is a new process in an empty working folder with an empty home, an allowlisted environment, `TERM=dumb`, `CI=1`, and no network. On Linux, when `unshare --user --net --map-root-user` is allowed, each run is inside such a namespace; otherwise the proxy variables point at a dead address (needs Node 24 for `NODE_USE_ENV_PROXY`) and `notCaptured` says "network blocked only for tools that honour proxy variables". `adapters/cli/test/run.mjs` check 5 measures it: a fetch from the fixture to a server on this machine's network address; the hit count must be 0. Isolation covers HOME, the working folder, the environment and the network only; it is not a filesystem sandbox (absolute paths and `TMPDIR` are reachable). A timeout kills the whole process group. Windows is refused ("CLI adapter: process-group kill is not supported on Windows").

Probes (`probes.mjs`): `bad-flag-exit`, `error-to-stderr` (screen `root`: an unknown flag must exit non-zero with the message on stderr and nothing on stdout), `stack-trace-shown` and `color-when-piped` (every run), `stdin-hang` (screen `no-args`: stdin is an open pipe never written to; flagged when still running after 10 s and nothing was printed), `help-exit` (`--help` exits 0 with output on stdout), `slow-start` (a value only: `startup-ms`, the median of 5 `--help` runs, goes to `timings.json`). Per-screen `<id>.ms` is recorded and not scored; `build-ms` and `startup-ms` are scored. Web-only metrics read "not measured".

Parity: each test gets `APP_RUN` (the run file) and `CLI_RUN_MODULE` (the path of `run.mjs`) and imports `prepare` and `runCli` from it; 120 seconds per test, each in its own process group (killed whole on a timeout) with its own temp parent that is removed afterwards.


## Backend

`adapters/backend/` (`api.mjs`, `discover.mjs`, `capture.mjs`, `probes.mjs`, `parity.mjs`, `worker.mjs`, `DRIVING.md`). A screen is one operation plus one state (`GET /items`, `POST /items`). Operations come from the OpenAPI document (`run.json` `openapi`, then `/openapi.json`, `/openapi.yaml`, `/swagger.json`, `/v3/api-docs`, `/docs/json`, `/.well-known/openapi`), else by probing: `GET /`, `Link` headers and `href`/`url` fields in JSON, `OPTIONS` and `Allow` on each path found, `robots.txt`, and an introspection call to `POST /graphql` (one screen when it answers, else a note; per-operation GraphQL is not captured); `coverage.json` `surfaceKnown` is false when nothing is found. Request bodies come from the document's examples or the schema's smallest valid value; a mutating operation with no body to send, or a path parameter with no example, is listed in `coverage.json` `operationsSkipped` with the reason, and so is an operation that needs credentials (it is still called without any; the 401 is the behaviour recorded, and no credential is invented). Up to `--max-screens` (30); the rest in `screensCut`.

Safe methods run first on a fresh store; each state and each mutating operation runs after a restart with empty temp storage. Each screen is captured twice, and a JSON value that differs becomes `"<varies>"` in `response.json`; the paths are in `manifest.json` `volatile`. `golden/screens/<id>/` holds `request.json`, `response.json` (`status`, allowlisted `headers`, `body`: JSON parsed when the content-type says so) and `result.json` (`ms`, `bytes`, `cut`, `error`). `network.har` is the full record of every call, including the probes' (this is the platform where the HAR is the behaviour). Bodies are cut at 1 MB and noted; a body that is not text is kept as its size only. Headers outside an allowlist (so `Set-Cookie` and `Authorization`) are dropped; strings go through the same secret scrub as the web HAR.

Isolation as the CLI adapter: a new empty `HOME`, `XDG_*` and `TMPDIR` at every fresh start, an allowlisted environment plus `run.env`, and no network beyond loopback (a user and network namespace on Linux when `unshare` and `ip` are allowed, with the calls made through a helper that enters it; otherwise dead proxy variables and `notCaptured` says "network: proxy mode, raw connections not blocked"). The service and its children are one process group, killed on stop. Windows is refused. The target folder is never written. A store outside this machine is refused; the outbound calls of the service are blocked and not recorded.

Probes: `server-error-on-valid`, `server-error-on-bad-input` (malformed JSON, an empty object, wrong types, a 100 KB string; 4xx passes), `stack-trace-in-body`, `error-not-json` (a 4xx/5xx body that is not JSON on a service that answers in JSON), `wrong-content-type`, `no-timeout` (still open at 10 s), `cors-wildcard-credentials`, `secret-in-response`, and `latency-ms` (a value only).

Parity: each test gets `APP_RUN`, `API_MODULE` (the path of `api.mjs`) and `APP_URL`, and imports `prepare`, `call` and `restart` from the module; in a network namespace `APP_URL` is not reachable from the test, so calls go through `call`. 120 seconds per test, each in its own process group with its own temp parent, removed afterwards.

## Library

`adapters/library/` (`run.mjs`, `harness.mjs`, `surface.mjs`, `capture.mjs`, `probes.mjs`, `parity.mjs`, `DRIVING.md`). A package other code imports, with no app to run. Its `run.json` is `{ "platform": "library", "language": "node", "dir", "install", "build", "entry", "env"? }`; `entry` is the package's main entry (a path inside `work/<dir>` or the package name). Only Node packages are driven so far; other languages stop with a plain reason.

A screen is one call: `<export>` with typed-minimal arguments, and `<export>-noargs` when it has required parameters. Calls run in a child process with the isolation of the CLI adapter (empty cwd and `HOME`, allowlisted environment plus `run.env`, no network, 1 MB output cap, process-group kill). Each call is captured twice and a differing value becomes `"<varies>"` (paths in `manifest.json` `volatile`). Parameters of a stream, socket, buffer or file-handle type are not called and are listed in `coverage.json` `callsSkipped`. At most 200 exports are driven; the rest are listed.

Golden extras: `surface.json` (exports with kind, signature and, for classes, members), `steps.json` and `types/` (copies of the package's `.d.ts`). `network.har` is empty.

Probes: `import-side-effects`, `throws-non-error`, `unhandled-rejection`, `process-hang`, `mutates-argument`; `deprecation-warning` is listed, not judged. Values: `import-ms`, `install-size`, `dependency-count`.

Surface compatibility: `surface-missing` (lower is better) counts exports of the original that the rebuild lacks or types incompatibly. It is measured for TypeScript packages only and reads "not measured" for plain JavaScript.

Parity: each test gets `APP_RUN`, `LIB_MODULE` (the path of `run.mjs`), `RR_PREPARED=1` and `RR_TMP_PARENT`; 120 seconds per test in its own process group.

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
| `startup-ms` | CLI: median time of 5 `--help` runs. Backend: time from starting the service to its first answer |
| `import-ms` | library: median time to import the entry |
| `latency-ms` | backend: median of 5 calls to the first GET screen that answered |
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

Safe area (`safe-area`, web per-change check only, not capture): each route at 390x844 with touch, iPhone insets top 47 and bottom 34 set with CDP `Emulation.setSafeAreaInsetsOverride` (so `env(safe-area-inset-*)` reads them), once in browser mode and once in standalone mode (`matchMedia('(display-mode: standalone)')` and `navigator.standalone` shimmed in JS; CSS `@media (display-mode)` rules are not emulated). One row per mode, screen `<id>:browser` and `<id>:standalone`. It fails when a visible interactive element (links, buttons, form fields, `summary`, button-like roles, `tabindex` 0 or more) overlaps the top or bottom inset, or `elementFromPoint` at its centre is neither the element nor inside it. The band test runs only on pages whose viewport meta has `viewport-fit=cover`: with the default (`auto`) Safari keeps the page inside the insets, and the evidence says the bands were not checked.

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

`node adapters/web/check.mjs --base-url <url> --routes /a,/b [--out <dir>] [--budget-seconds 110] [--storage-state file] [--allow-origin https://x,...] [--wait-for <css selector>]`

A standalone run of the probes on the routes a change touched, against an app that is already running; no run folder. Exit 0 pass, 1 fail, 2 incomplete (nothing failed but something was not checked), 3 error (bad arguments, app unreachable, browser missing). Never a pass for something not checked. `--out` is a directory with `result.json` (`version, status, baseUrl, routes, screenshots, elapsedMs, passed, failed, notChecked, blockedOrigins`) and `<slug>-390.png`, `<slug>-1440.png` per route, taken before any probe. Load probes run first on every route, one at a time; click probes after, 4 at a time; at the budget what has not run goes to `notChecked`. A route that ends on another path is `notChecked`. `--wait-for` waits (up to 10 s, and never past the budget) for the selector to be visible on every route before the screenshots; if it does not show, the shots are taken anyway and `notes` gets `{ route, note }` (also when no time is left to wait); a note never changes the status or exit code, and an invalid selector is an error (exit 3). Rows in `failed` for `input-delay` and `script-cost-per-key` carry `value` (a number) and `unit` (`ms`). Blocked cross-origin requests are listed, not counted as console errors. Clicks on labels that look destructive or outward-facing are skipped and listed; on a non-localhost base URL no click runs.
