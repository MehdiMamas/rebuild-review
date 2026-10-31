# rebuild-review

Claude Code plugin: a one-shot review that rebuilds a full project from its behaviour and
what it renders, then scores the rebuild against the original. See README.md.

## Install and test

- Install: `claude plugin marketplace add MehdiMamas/rebuild-review`, then `claude plugin install rebuild-review@rebuild-review`.
- Run: `/rebuild-review:rebuild-review <target-path>`. It makes `<target>-rebuild-review/<run-id>/` next to the target and starts the workflow `rebuild-review:rebuild-review-run`. Phases not described below are stubs that write `<Phase>.done`; finished phases are skipped on a rerun with the same run folder.
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
- Writes `<runDir>/features.md` (IDs, given/when/then, seen by, keep or defect), `<runDir>/technology.md` (languages, frameworks, storage, build tools) and `<runDir>/Inventory.done`. `features.md` and `technology.md` hold no source: `node scripts/check-features.mjs <file> <work>` must pass for each (fences, source paths, import/JSX lines, 40+ char copied runs); the phase fails if it does not after 2 fix tries.
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
- The room is a new `mktemp -d` folder outside the run folder (the run folder's name contains the target's name). Everything the builder sees is a filtered copy in `room/input/`: `features.md`, `technology.md`, `stack.md` and `golden/`. `features.md`, `technology.md` and `stack.md` are re-checked with `check-features.mjs` before copying, and the copies are grepped for the target path and the run folder path.
- `golden/` is filtered (`filterGolden`) because `network.har` holds the app's JS, CSS and source map bodies and `render.html` can hold inline scripts, which together are the source. JSON, image and font bodies stay (API contract and assets); `run.json` is dropped.
- The child is `claude -p` in the room with `--setting-sources project` and the settings file passed with `--settings` (kept in `<room>.settings/`, outside the room, because it names the denied paths), no user settings or memory, WebFetch/WebSearch off, `--no-session-persistence`. Permission mode `bypassPermissions`; budgets and models are constants at the top of `room.mjs`.
- Settings gotchas, proven by `scripts/room.live.test.mjs`: a Read deny rule needs the absolute form `Read(//abs/path)` (one slash is ignored); the Read tool is stopped only by that deny rule, Bash only by `sandbox.filesystem.denyRead`, so both are needed; `sandbox.network.strictAllowlist: true` is required or the model can widen the network list itself with `allowed_domains`.
- The child may not read the target, the run folder, the folder holding all runs (`<target>-rebuild-review`), the git common dir of a worktree target, the plugin root, `~/.claude/projects` and these credential folders when present: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.docker`. `Edit` rules (which cover Write) stop writes to the target and run folder.
- The built project is delivered with `git clone` of its committed state (it must be a clean git repo with a commit); ignored and uncommitted files never arrive.
- Every run first proves the wall: a canary in `<runDir>/.canary`, a haiku child tries to read it; a hit, a sandbox that cannot start, or a child that never tried a `cat` and a Read refuses the build. After the run, any target or run folder path in the child's transcript fails it.
- Tests: `node --test scripts/room.test.mjs` (CI, no `claude`); `node --test scripts/room.live.test.mjs` (local, calls `claude`, costs money).

## Score phase (phase 1: measure, judge, compare)

- Needs `project/rebuild-run.json` and `parity/parity.json`; otherwise the phase stops with a plain reason. Files: `rubric.json` (gate and weights), `scripts/score.mjs`, `prompts/{judge,skeptic,compare}.md`, `adapters/web/metrics.mjs` (LCP, CLS, bytes, heap, narrow overflow, axe-core; written by `capture.mjs` into `timings.json` and `a11y-violations.json`).
- Every score is a comparison: a metric delta is `(original - rebuild) / max(original, rebuild)` for lower-is-better (flipped for higher), from -1 to +1, positive means the rebuild is better; a difference under the metric's `floor` (absolute, or `"10%"` of the larger side) counts as 0; a metric missing on either side is "not measured", never 0. A value is the mean of its measured deltas and its judged delta (judges' `(rebuild - original) / 10`), half each. Overall is the weighted sum, -100 to +100. Functionality is a gate (`minPassRate` 0.95 on the rebuild's parity run), reported beside the scores, never blended in.
- Code does the arithmetic. Three blind judges (sonnet) each get `judge-<i>/A` and `/B` in a temp folder with shuffled labels (no `.git`, `README*`, `run.json`, `rebuild-run.json`, `stack.md`); the label map is written to `score/.labels.json` only after judging. Each judge writes `answer.json` in its own folder; `score.mjs check <answer.json> <judgeDir> <score/judge-N.json>` writes only the kept items to `score/judge-N.json` (dropped ones beside it as `.dropped.json`), so a judge with no checked file counts for nothing, and the first prep step clears `score/`. It drops any score whose citation is not a real file, `file:line`, or metric name for that side. Skeptics look at each judged gap of 3+ points and each metric delta of 0.5+; a refuted judged gap is removed and listed, a measured number is only annotated. `score.mjs collate` writes `score/score.json`; a compare agent writes `score/compare.md`.
- Change weights or floors in `rubric.json` only; no code reads them as constants. Never tune them to make a fixture pass.
- Compatibility is narrow: accessibility violations and horizontal overflow at 390 px, Chromium only. The output says "other browsers: not checked".
- Tests: `node --test scripts/score.test.mjs`; `cd adapters/web && npm test` (check 3c prints the new timings).

## Report phase

- Files: `scripts/report.mjs` (`verdict`, `check-actions`, `render`), `prompts/{compare,actions}.md`, `rubric.json` key `verdict` (`adoptOverall` 15, `worseValue` -0.15, `betterValue` 0.15, from phase 1's same-against-same noise limits; never tune them to a fixture). Writes `report/index.html` and `Report.done`.
- Code decides the verdict: `adopt` (gate passed, overall >= adoptOverall, no value delta <= worseValue), `port` (not adopt, some value delta > 0.15), else `leave`; no score is `leave`. A sonnet agent only proposes `report/actions.proposed.json` (`evidence: [{kind: metric|file|shot|feature, ref}]`); `check-actions` drops any action with a false citation (listed in `actions.dropped.json`).
- The page is one file: no script, strict CSP, images embedded (at most 6 pairs and 8 MB, the rest counted), every string escaped. `compare.md` must use `## <value>` with `### was`, `### now`, `### should`. `parity/rounds.json` and `parity/loop-stop.txt` are optional.
- The report is private: the skill publishes it with the Artifact tool when present and the target is not sensitive; otherwise only a `file://` link.
- Tests: `node --test scripts/report.test.mjs`.

## Score phase (phase 2: the rebuild beats the original)

- Checker: `node benchmark/score-rebuild.mjs <runDir> [--out file] [--control]`. It starts the original (`run.json`) and the rebuild (`project/rebuild-run.json`) one after the other with `startApp`, runs every planted-problem check on both and prints a table: item, original, rebuild, evidence. Exit 0 only if the original has every item and the rebuild has beaten every one. `--control` checks only the original (every D, H and B item must read `present`).
- Written from `answers.json` but black-box: controls are found by role and label, slow and failed requests are made with `page.route`; bloat (B1 to B4) is read from the source files; D1 multiplies the list response to 2000 rows with `page.route`, types 5 keystrokes into the search box at 4x CPU slowdown and compares script ms per key (present above 16 ms; gone at or under 16 ms or 50% lower than the original). If the original does not read above 16 ms under that load, D1 is `could not check` on both sides.
- Results are `present`, `gone` or `could not check`; the last never counts as beaten. Beaten means `gone` for D and B items, `present` for H items (features that must survive).
- Never tune the checker, `rubric.json`, tests or prompts to get a pass; an item the rebuild does not beat is reported with its cause.
- `score.mjs blind` flips the label order for each judge after the first, so both orders occur in every run. Test: `node --test scripts/score.test.mjs`.

## Confidence

- `node scripts/confidence.mjs <runDir>` writes `score/confidence.json`; `report.mjs render` computes the same and shows it in the verdict section, with a table of the parts and each part's inputs, and a percentage for each value. Settings are in `rubric.json` key `confidence` (first guesses, never tune them to a fixture).
- The number is the weakest of four parts, each 0 to 100: **coverage** (features compared out of found, metrics measured out of expected, screens reached out of seen when `golden/coverage.json` exists, multiplied), **agreement** (spread of the judges' per-judge mean deltas in `values.<name>.judges`, share of judged gaps refuted, share of judge items dropped), **margin** (distance of overall and each value from the verdict thresholds in units of noise; on a threshold reads about 50), **track record** (Wilson lower bound of the share of right verdicts in `benchmark/calibration.json`, so few runs give a low number). The report names the part that set it. No score reads "not measured". A target with more source lines than the biggest calibrated run is capped and the page says so.
- Record a known-answer run: after Score, `node benchmark/calibrate.mjs <runDir> --expect adopt|port|leave --kind same|worse|fixed`. Write the expected verdict on the issue first. A wrong verdict stays in the file; never change thresholds, prompts, weights, tests or the fixture to fix it.
- The parity tests for known-answer runs are `benchmark/known-answer-tests/` (F-001..F-007 are the planted defects D1-D7, F-008..F-011 the hidden features H1-H4); run them with `adapters/web/parity.mjs --tests benchmark/known-answer-tests`, and set `PLAYWRIGHT_PATH` when the tests are copied elsewhere. On the unchanged fixture the defect tests fail, so the gate fails and the verdict is `leave`; a copy with every defect fixed passes.
- It is not a calibrated probability. Reading it: a low number with "track record" as the limit means the tool has few checked runs, not that this verdict looks bad. Tests: `node --test scripts/confidence.test.mjs`.

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

## Size and scale (#35 step 1)
- `node scripts/size.mjs <workDir> <runDir>` counts source lines of git-tracked files (skipping lock, vendored, generated and non-source files, all listed) and writes `<runDir>/size.json` with the budgets from `scale.json` (one unit = 20,000 lines; floors equal the old fixed limits; per-unit values are first guesses). Not yet used by the workflow. Test: `node --test scripts/size.test.mjs`.
- `capture.mjs` takes `--max-screens` (30), `--max-buttons` (10) and `--max-har-bytes` (50 MB) and writes `golden/coverage.json`: screens reached, screens cut, buttons skipped, HAR entries dropped. `cd adapters/web && npm test` check 8 covers it.
