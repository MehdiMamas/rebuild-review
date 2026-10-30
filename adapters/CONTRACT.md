# Adapter contract

An adapter captures one platform's running app into a `golden/` folder. The rest of the
review (inventory, rebuild, parity, score) reads only that folder, so every adapter must
produce the same layout.

## Input

`run.json`, written by the capture agent next to the cloned copy of the target:

```
{ "platform": "...", "dir": "path inside work/", "install": "...", "build": "...", "start": "...", "address": "..." }
(android and flutter add "apk" and "package", see below)
```

- `dir` is relative, never absolute (the adapter throws otherwise): to `work/` next to `run.json`, except in a file named `rebuild-run.json`, where it is relative to that file's own folder.
- The target is never run in place. The agent clones it to `<runDir>/work/` and the adapter runs that copy.
- The adapter refuses an address that is not on this machine.

Call: `capture --app <run.json> --out <runDir>/golden [--states states.json]`

## Output

```
golden/manifest.json       platform, app version, screens, states, blocked requests, what could not be captured
golden/screens/<id>/       render.* (the rendered structure and computed style), a11y.json, <size>-<theme>.png (size is the adapter's own name)
golden/network.har         every request and response, secrets removed
golden/timings.json        list of { name, value, unit }
golden/probes.json         list of { probe, screen, passed, evidence }; passed=false means the probe flagged a problem
golden/console.log         errors the app printed
golden/a11y-violations.json  optional: list of { screen, violations: [{ id, impact, nodes }] }
```

Screenshots are taken at a narrow and a wide size (a phone and a larger one on mobile), in light and dark theme.

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

Each probe is a general check for one kind of failure, not a check for a known app. Required kinds are those
that apply to the platform. Common to all: repeated identical requests, no visible feedback during a slow
request, a failed request with no visible error, errors the app prints (console or crash log). Web adds focus
lost while typing, input delay, layout shift. Android adds crash or ANR, dropped frames, touch targets under
48 dp, interactive elements with no label.


Web also has a probe for script time per keystroke (`script-cost-per-key`: script time over 5 characters typed 100 ms apart into the first text input of each screen, CPU throttled 4x; the worst value goes to `timings.json` as `script-ms-per-key`, `passed` means 16 ms or less, one frame). For the web "failed request with no visible error" probe only requests the app's own code made count: framework route prefetches and client navigation payloads (headers `sec-purpose`/`purpose` prefetch, `next-router-prefetch`, `rsc` without `next-action`, and `/_next/data/` paths) are not data requests.

## Parity

Call: `parity --app <run.json> --tests <dir> --out <results.json>`

The adapter starts the app named in `run.json`, passes its address in the `APP_URL` environment variable, runs each `<dir>/F-*.test.*` (one file per feature, named by feature ID) with a 60 second limit, and stops the app. Results: a list of `{ feature, passed, detail }`, `detail` being the last lines of the test's output. The same safety rules as capture apply. A platform with no `parity` entry point has no parity phase: the workflow stops with a plain reason.

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


## Android and Flutter

One adapter, `adapters/android/`, serves both platforms; `run.json` differs only in `platform` (`android` or
`flutter`) and the build command. Extra fields: `apk` (built apk, relative to `dir`), `package` (application id).
`start` runs the app's own local API and `address` is that API (localhost); the emulator reaches it as
`10.0.2.2` and the adapter never starts anything else on the network.

It uses plain adb and uiautomator, no Maestro or Appium, on a dedicated headless AVD `rebuild-review` on
port 5584 (every adb call carries `-s emulator-5584`). The AVD is wiped at start and the emulator is stopped
at the end, also on failure. Sizes: `phone` (1080x2400) and `tablet` (1600x2560), light and dark. The render
files are `render.xml` (the uiautomator dump) and `render.json` (flat node list), plus `a11y.json`.

Network: the emulator starts with `-http-proxy` pointing at the adapter's recording proxy. The proxy passes
only the app's own API, answers everything else with 403 and lists it in `blockedRequests`, simulates
`failRequest` and `slowRequest`, and strips secrets from the HAR exactly like the web adapter. HTTPS is refused
by host (no certificate is installed) and listed under `notCaptured`.
Timings: `am start -W` (cold and per screen), `dumpsys gfxinfo` during a scripted scroll, apk size.
In `states.json`, `open` relaunches the app (its value is ignored), and `click` and `type` match the visible text
or content description.

## Changes made to neutral parts for Android

- Screenshot names are `<size>-<theme>.png` with the adapter's own size names, not pixel widths.
- Required probe kinds now depend on the platform.
- The workflow's Capture step picks the adapter folder from `platform`.
