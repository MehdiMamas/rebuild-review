# Contributing

Thanks for helping. Setup, build and test details for each part are in [AGENTS.md](AGENTS.md).

## Setup

- Install pnpm: `npm install -g pnpm@12.16.1` (or `corepack enable`).
- Install the web adapter: `cd adapters/web && pnpm install`. Chromium is needed for its tests: `pnpm exec playwright install chromium`.
- The Electron adapter has its own `pnpm install` in `adapters/electron` (Linux needs a display, for example `xvfb-run -a`).

## Checks CI runs

From the repo root, after the setup above:

```
node --test scripts/workflow-parse.test.mjs
node --test scripts/check-features.test.mjs scripts/parity-results.test.mjs scripts/room.test.mjs
node --test scripts/score.test.mjs scripts/report.test.mjs scripts/size.test.mjs
node --test adapters/web/test/crawl.test.mjs
cd adapters/web && pnpm test
```

The full list of test files is in `.github/workflows/ci.yml`; run the ones for the code you changed.

Never run `node --test scripts/*.test.mjs`. It includes `scripts/room.live.test.mjs`, which calls a paid model.

## Rules that hold

- The rebuild step never reads the target's source. Enforced by the room in `scripts/room.mjs`, not by the prompt.
- A target project is never changed. Every run writes to its own output folder.
- `workflows/rebuild-review.js` is one script of template literals, so a stray backtick in a prompt breaks every run. `scripts/workflow-parse.test.mjs` compiles it; run it after any edit there.
- Keep issues, PRs and commits free of local paths, secrets and the names of private apps you reviewed.

## Filing a bug

Use the bug form under Issues. Give the command you ran, what you expected, what happened, and the plugin version from `.claude-plugin/plugin.json`. Questions go to Discussions.
