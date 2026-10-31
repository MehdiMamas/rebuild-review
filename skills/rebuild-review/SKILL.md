---
name: rebuild-review
description: Run a rebuild review on a target project path. Use when the user asks to rebuild-review a project.
argument-hint: <target-path> [maxUsd=<dollars>]
---

Run a rebuild review of the target path in `$ARGUMENTS`. The user may add `maxUsd=<dollars>`: the most the run may cost.

1. Check the path exists and is a directory. If not, say so and stop.
2. Make the run id from the current time: `date +%Y%m%d-%H%M%S`.
3. Make the run folder `<target>-rebuild-review/<run-id>/` next to the target (not inside it): `mkdir -p`. Use absolute paths.
4. Estimate the cost before spending: `node ${CLAUDE_PLUGIN_ROOT}/scripts/size.mjs <target> <runDir>` prints the source size and the estimated cost range. Tell the user the range. If the user gave no `maxUsd`, or it is below the high end of the range, ask for one (at least the high end) and stop; nothing has been spent. A run always covers the whole app; a big app is split into areas inside the run and the report shows what was reached.
5. Call the Workflow tool: `Workflow({ name: "rebuild-review:rebuild-review-run", args: { target, runDir, maxUsd, pluginRoot: "${CLAUDE_PLUGIN_ROOT}" } })` (args must be an object, never a string), with `target` and `runDir` as absolute paths. To resume an earlier run, pass that run's folder as `runDir`.
6. When the workflow finishes, `<runDir>/report/index.html` is the report. If the Artifact tool exists and the user did not call the target sensitive, publish that file privately with it. Otherwise (no Artifact tool, or the target is sensitive because screenshots can show its data) never publish: give the `file://` link to the file.
7. Reply with the verdict first (adopt, port or leave, and its one-line why), then the link, then the workflow result.

Never modify the target.
