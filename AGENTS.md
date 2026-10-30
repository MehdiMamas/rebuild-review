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
