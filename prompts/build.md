You build a complete project from a description of what it must do. You work in the current folder only. Do not read anything outside it and do not look for the original app or its source anywhere on this machine or the network.

Inputs:
- `input/features.md`: every feature, with given/when/then, marked `keep` or `defect`.
- `input/stack.md`: the stack to use.
- `input/golden/`: what the original app rendered and how it behaved (screens, accessibility trees, `network.har`, timings, probes).
- `input/foundations.md`, when it exists: what must carry over whatever the features say (license and attribution, saved data formats, config files, extension manifests, external services, and so on). Keep every item marked `found`, as `input/stack.md` says.
- `input/base/`, only when it exists: the upstream the app is built on. `project/` already starts as that tree. Change only the app-own behaviour on top of it.
- `input/failures.md`, only when it exists: failures from the last round. Fix those.

Build the whole project in `project/` as its own git repo (`git init`, commit as you go with clear messages), backend included, feature by feature from `input/features.md`, checking each against `input/golden/`.
- Meet the API contract you can see in the requests and responses of `input/golden/network.har`.
- A `defect` entry is built to its "Intended" text. A golden that shows the defect is not a target.
- Include tests and a README.
- Write `project/rebuild-run.json` with the same shape as `run.json`: `{"platform": "...", "dir": "...", "install": "...", "build": "...", "start": "...", "address": "http://127.0.0.1:<port>"}`, with one start command that reads the port from the PORT environment variable. A command-line tool (platform "cli") has no `start` or `address`: write `{"platform": "cli", "dir": "...", "install": "...", "build": "...", "command": ["<executable>", "<fixed arguments>"...]}`, where `command[0]` is a name on PATH or a path relative to `dir` (a file the build makes, or a script with a shebang and the executable bit). A service with an HTTP API and no pages (platform "backend") uses the shape of the first form with `"platform": "backend"`; add `"openapi"` (a path inside `dir` or on the running service) and `"readyPath"` only when the original's `run.json` has them. It keeps its data in files under its home or temp folder, not in a database server. `dir` is relative to the folder holding `rebuild-run.json`: write `"dir": "."` for a project at its root.
- Packages come from the public package registries only.
- Work in the foreground: never end your turn while a command still runs in the background; wait for it first.
- Before finishing, commit everything, including `rebuild-run.json`, and leave `git status` clean. Add a `.gitignore` for dependencies and build output: ignored and uncommitted files are not delivered.
