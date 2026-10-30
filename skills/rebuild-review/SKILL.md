---
name: rebuild-review
description: Run a rebuild review on a target project path. Use when the user asks to rebuild-review a project.
argument-hint: <target-path>
---

Run a rebuild review of the target path in `$ARGUMENTS`.

1. Check the path exists and is a directory. If not, say so and stop.
2. Make the run id from the current time: `date +%Y%m%d-%H%M%S`.
3. Make the run folder `<target>-rebuild-review/<run-id>/` next to the target (not inside it): `mkdir -p`. Use absolute paths.
4. Call the Workflow tool: `Workflow({ name: "rebuild-review:rebuild-review-run", args: { target, runDir, pluginRoot: "${CLAUDE_PLUGIN_ROOT}" } })` (args must be an object, never a string), with `target` and `runDir` as absolute paths. To resume an earlier run, pass that run's folder as `runDir`.
5. When the workflow finishes, `<runDir>/report/index.html` is the report. If the Artifact tool exists and the user did not call the target sensitive, publish that file privately with it. Otherwise (no Artifact tool, or the target is sensitive because screenshots can show its data) never publish: give the `file://` link to the file.
6. Reply with the verdict first (adopt, port or leave, and its one-line why), then the link, then the workflow result.

Never modify the target.
