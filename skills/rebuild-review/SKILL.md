---
name: rebuild-review
description: Run a rebuild review on a target project path. Use when the user asks to rebuild-review a project.
argument-hint: <target-path> [maxUsd=<dollars>] [base=<url@ref|none|keep>] [runDir=<dir>] [unattended=1]
---

Run a rebuild review of the target path in `$ARGUMENTS`. The user may add `maxUsd=<dollars>`: the most the run may cost; `base=<url@ref|none|keep>`: the answer to the base question in step 4; `runDir=<dir>`: an existing run folder to resume (skip steps 2 and 3); `unattended=1`: no one is at the keyboard (started by `scripts/unattended.sh`).

Unattended: never ask anything. A missing `base` means `keep`. A missing `maxUsd`, or one below the high end of the estimate, stops the run with that reason and nothing spent. Wait for the Workflow to finish in this turn (do not end the turn while it runs).

1. Check the path exists and is a directory. If not, say so and stop.
2. Make the run id from the current time: `date +%Y%m%d-%H%M%S`.
3. Make the run folder `<target>-rebuild-review/<run-id>/` next to the target (not inside it): `mkdir -p`. Use absolute paths.
4. Find the upstream base first: `node ${CLAUDE_PLUGIN_ROOT}/scripts/base.mjs detect <target> <runDir>` prints whether the app is a fork, a framework app or a template, the upstream address, ref and commit, how it was found, and how many own files and lines the app has. If `base` was given, use it without asking (`keep` keeps the detected one). Otherwise ask the user once, with the finding shown: keep the detected base, give another as `url@ref`, or `none`. For a given `url@ref` or `none` run `node ${CLAUDE_PLUGIN_ROOT}/scripts/base.mjs pin <runDir> <url@ref|none>` (it saves `base` in `run.json`; a pinned answer wins over detection) and then run detect again. When nothing was detected, say "no base found" and ask only if the user wants to name one. The rebuild is then built on top of that base, and code metrics count only the app's own code.
5. Estimate the cost before spending: `node ${CLAUDE_PLUGIN_ROOT}/scripts/size.mjs <target> <runDir>` prints the source size and the estimated cost range. Tell the user the range. If the user gave no `maxUsd`, or it is below the high end of the range, ask for one (at least the high end) and stop; nothing has been spent. A run always covers the whole app; a big app is split into areas inside the run and the report shows what was reached.
6. Tell the user how to watch the run: print `node ${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs <runDir>` (it serves a page on 127.0.0.1 and prints its link; print it in unattended mode too). Then call the Workflow tool: `Workflow({ name: "rebuild-review:rebuild-review-run", args: { target, runDir, maxUsd, pluginRoot: "${CLAUDE_PLUGIN_ROOT}" } })` (args must be an object, never a string), with `target` and `runDir` as absolute paths. To resume an earlier run, pass that run's folder as `runDir`.
7. When the workflow finishes, `<runDir>/report/index.html` is the report. If the Artifact tool exists and the user did not call the target sensitive, publish that file privately with it. Otherwise (no Artifact tool, or the target is sensitive because screenshots can show its data) never publish: give the `file://` link to the file.
8. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/confidence.mjs" <runDir>`; it prints the confidence percentage and the part that limits it. Reply with the verdict and the percentage on the first line (for example `adopt, 54% confident, limited by track record`), then the verdict's one-line why, then the link, then the workflow result. If it prints `not measured`, say so instead of a number.

Never modify the target.
