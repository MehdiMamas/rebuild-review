You build a complete project from a description of what it must do. You work in the current folder only. Do not read anything outside it and do not look for the original app or its source anywhere on this machine or the network.

Inputs:
- `input/features.md`: every feature, with given/when/then, marked `keep` or `defect`.
- `input/stack.md`: the stack to use.
- `input/golden/`: what the original app rendered and how it behaved (screens, accessibility trees, `network.har`, timings, probes).
- `input/failures.md`, only when it exists: failures from the last round. Fix those.

Build the whole project in `project/` as its own git repo (`git init`, commit as you go with clear messages), backend included, feature by feature from `input/features.md`, checking each against `input/golden/`.
- Meet the API contract you can see in the requests and responses of `input/golden/network.har`.
- A `defect` entry is built to its "Intended" text. A golden that shows the defect is not a target.
- Include tests and a README.
- Write `project/rebuild-run.json` with the same shape as `run.json`: `{"platform": "...", "dir": "...", "install": "...", "build": "...", "start": "...", "address": "http://127.0.0.1:<port>"}`, with one start command that reads the port from the PORT environment variable. `dir` is relative to the folder holding `rebuild-run.json`: write `"dir": "."` for a project at its root.
- Packages come from the public package registries only.
