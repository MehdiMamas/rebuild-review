# rebuild-review

Claude Code plugin: a one-shot review that rebuilds a full project from its behaviour and
what it renders, then scores the rebuild against the original. See README.md.

## Install and test

- Install: `claude plugin marketplace add MehdiMamas/rebuild-review`, then `claude plugin install rebuild-review@rebuild-review`.
- Run: `/rebuild-review:rebuild-review <target-path>`. It makes `<target>-rebuild-review/<run-id>/` next to the target and starts the workflow `rebuild-review:rebuild-review-run`. The seven phases are stubs that write `<Phase>.done`; finished phases are skipped on a rerun with the same run folder.
- Validate: `claude plugin validate .`
- Test without installing: `claude -p "/rebuild-review:rebuild-review <path>" --plugin-dir <this checkout> --permission-mode bypassPermissions`, against a throwaway git repo; its `git status` must stay clean.
- Gotcha: the skill and the workflow must not share a name. With both called `rebuild-review:rebuild-review`, the call goes straight to the workflow and the skill text never runs.
- Gotcha: a clean `CLAUDE_CONFIG_DIR` has no login, so `claude -p` cannot run there; use `--plugin-dir`.

## Capture (web adapter)

- Contract every adapter follows: `adapters/CONTRACT.md`. Web adapter: `adapters/web/` (`capture.mjs`, `probes.mjs`, `context.mjs`).
- Setup once: `cd adapters/web && npm install` (Playwright; Chromium must be installed, `npx playwright install chromium`).
- Run: `node adapters/web/capture.mjs --app <runDir>/run.json --out <runDir>/golden [--states states.json]`. The app must already be cloned to `<runDir>/work/`; `run.json` is described in the contract. Only localhost addresses are accepted.
- Test: `cd adapters/web && npm test` (about 3 minutes). It runs six checks on a `bench:init` copy of `benchmark/`, never on the repo folder, and prints which planted defects the probes flagged.
- Gotcha: `work/` holds source, so the sandbox for the rebuild step (#7) must deny reads of it as well as the target.

## Inventory phase

- Needs `<runDir>/work/` (clone of the target) and `<runDir>/run.json` (platform, install, build, start, address); `golden/` is used when present. The skill passes `pluginRoot` (`${CLAUDE_PLUGIN_ROOT}`) so the workflow can run `scripts/check-features.mjs`.
- Four finders run in parallel on sonnet (code reader, black-box user, history reader, docs reader), each writing only `<runDir>/inventory/<finder>.md`; the black-box user also writes `inventory/states.json`. Then merge and a critic loop (at most 3 rounds).
- Writes `<runDir>/features.md` (IDs, given/when/then, seen by, keep or defect), `<runDir>/technology.md` (languages, frameworks, storage, build tools) and `<runDir>/Inventory.done`. `features.md` holds no source: `node scripts/check-features.mjs <features.md> <work>` must pass (fences, source paths, import/JSX lines, 40+ char copied runs); the phase fails if it does not after 2 fix tries.
- Tests: `node --test scripts/check-features.test.mjs`; for the full phase, run the workflow on a `bench:init` copy (clone it to `<runDir>/work`, write `run.json`, `Capture.done`), then `node benchmark/score-inventory.mjs <runDir>/features.md`. Only the scorer reads `answers.json`.
- Each run gets its own port from `scripts/free-port.mjs` (capture writes it into `run.json`; the finders start the app with `PORT` set to it).
- If the second capture fails, run the skill again with the same run folder: `InventoryFound.done` makes it skip the finders, merge and critics and repeat only the capture. Test: `node --test scripts/free-port.test.mjs`.

## Parity phase (phase 1: the suite)

- Needs `features.md`, `run.json` and `golden/`. Adapter entry point: `parity.mjs --app <run.json> --tests <dir> --out <results.json>` (contract in `adapters/CONTRACT.md`); a platform with no `parity.mjs` stops the phase with a plain reason. Web: `adapters/web/parity.mjs`, app start and stop shared with capture in `adapters/web/app.mjs`.
- A writer agent (sonnet) writes `<runDir>/parity/tests/F-xxx.test.mjs`, one per feature, from `features.md` and the running app, never from `work/`. `keep` tests assert the behaviour, `defect` tests assert the Intended text and should fail on the original. A fix loop (3 rounds) repairs wrong tests; two runs on the original must agree. Tests that stay wrong or flip move to `parity/removed/` and are listed in `parity/untested.md`.
- With `<runDir>/project/rebuild-run.json` it also runs the tests on the rebuild (`parity/rebuild.json`), captures it into `golden-rebuild/` and runs `scripts/visual-diff.mjs` (`parity/visual-diff.json`, percent of differing pixels, no pass or fail). Writes `parity/parity.json` and `Parity.done`. Phase 2 (feeding failures back to the builder) is not built yet.
- Probe `script-cost-per-key` (web): script time per keystroke in every visible text input (up to 5) at 4x CPU slowdown; the value is `script-ms-per-key` in `golden/timings.json`, flagged above 16 ms. The threshold is not tuned to the fixture.
- Pass or fail decisions are code: `scripts/parity-results.mjs` (`wrong`, `settle`, `merge`); `features.md` entries start `F-xxx keep.` or `F-xxx defect.`. Tests: `node --test scripts/parity-results.test.mjs scripts/visual-diff.test.mjs` (the latter needs `cd adapters/web && npm install` first); `cd adapters/web && npm test` checks the timing is written and prints it.

## Stack and Rebuild phases (clean room)

- Both run through `node scripts/room.mjs stack|build --target T --run-dir R [--failures file]` (a sonnet agent starts it in the background and reads `<runDir>/rebuild/<mode>-<n>.result.json`). Prompts: `prompts/stack.md`, `prompts/build.md`. `Stack.done` / `Rebuild.done` are written only when the result says ok. `--failures` is for the parity loop (#8).
- The room is a new `mktemp -d` folder outside the run folder (the run folder's name contains the target's name). Everything the builder sees is a filtered copy in `room/input/`: `features.md`, `technology.md`, `stack.md` and `golden/`. `features.md`, `technology.md` and `stack.md` are re-checked with `check-features.mjs` before copying, and the copies are grepped for the target path, the run folder path and the target's folder name.
- `golden/` is filtered (`filterGolden`) because `network.har` holds the app's JS, CSS and source map bodies and `render.html` can hold inline scripts, which together are the source. JSON, image and font bodies stay (API contract and assets); `run.json` is dropped.
- The child is `claude -p` in the room with `--setting-sources project` and the settings file passed with `--settings` (kept in `<room>.settings/`, outside the room, because it names the denied paths), no user settings or memory, WebFetch/WebSearch off, `--no-session-persistence`. Permission mode `bypassPermissions`; budgets and models are constants at the top of `room.mjs`.
- Settings gotchas, proven by `scripts/room.live.test.mjs`: a Read deny rule needs the absolute form `Read(//abs/path)` (one slash is ignored); the Read tool is stopped only by that deny rule, Bash only by `sandbox.filesystem.denyRead`, so both are needed; `sandbox.network.strictAllowlist: true` is required or the model can widen the network list itself with `allowed_domains`.
- Every run first proves the wall: a canary in `<runDir>/.canary`, a haiku child tries to read it; a hit or a sandbox that cannot start refuses the build. After the run, any target or run folder path in the child's transcript fails it.
- Tests: `node --test scripts/room.test.mjs` (CI, no `claude`); `node --test scripts/room.live.test.mjs` (local, calls `claude`, costs money).

## Conventions

- Any kind of project, not only web. Nothing outside a platform adapter may assume HTML,
  a browser or React; a platform-specific need means the adapter contract changes.
- In and out: the words and what the app renders are the input. The output is the full
  project done the best way, backend included. The score and report come with it and never
  replace it. Never call the rendered app "output" in docs or issues.
- The plugin must install on its own from this repo. claude-sync-data only lists it, and
  nothing here may depend on claude-sync, session-manager or other mods.
- Rules that must hold are enforced by the workflow script or file layout, not by asking
  the model nicely. The main one: the rebuild agent cannot read the target's source.
- A target project is never modified. Every run writes to its own output folder.
- No Claude or AI attribution in commits, PRs or release notes.
