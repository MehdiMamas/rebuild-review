# Adapter contract

An adapter captures one platform's running app into a `golden/` folder. The rest of the
review (inventory, rebuild, parity, score) reads only that folder, so every adapter must
produce the same layout.

## Input

`run.json`, written by the capture agent next to the cloned copy of the target:

```
{ "platform": "...", "dir": "path inside work/", "install": "...", "build": "...", "start": "...", "address": "..." }
```

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
```

Screenshots are taken at a narrow and a wide size, in light and dark theme.

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
console, no visible feedback during a slow request, a failed request with no visible error, script time per keystroke (`script-cost-per-key`: script time over 5 characters typed 100 ms apart into the first text input of each screen, CPU throttled 4x; the worst value goes to `timings.json` as `script-ms-per-key`, `passed` means 16 ms or less, one frame).

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
`a11y.json`, a HAR as `network.har`. Probes are in `probes.mjs`. Parity is `parity.mjs`: each test is a `node --test` file that imports Playwright by absolute path from `adapters/web/node_modules`.
