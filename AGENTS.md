# rebuild-review

Claude Code plugin: a one-shot review that rebuilds a project from its behaviour and
rendered output, then scores the rebuild against the original. See README.md.

## Install and test

- Install: `claude plugin marketplace add MehdiMamas/rebuild-review`, then `claude plugin install rebuild-review@rebuild-review`.
- Run: `/rebuild-review:rebuild-review <target-path>`. It makes `<target>-rebuild-review/<run-id>/` next to the target and starts the workflow `rebuild-review:rebuild-review-run`. The seven phases are stubs that write `<Phase>.done`; finished phases are skipped on a rerun with the same run folder.
- Validate: `claude plugin validate .`
- Test without installing: `claude -p "/rebuild-review:rebuild-review <path>" --plugin-dir <this checkout> --permission-mode bypassPermissions`, against a throwaway git repo; its `git status` must stay clean.
- Gotcha: the skill and the workflow must not share a name. With both called `rebuild-review:rebuild-review`, the call goes straight to the workflow and the skill text never runs.
- Gotcha: a clean `CLAUDE_CONFIG_DIR` has no login, so `claude -p` cannot run there; use `--plugin-dir`.

## Conventions

- The plugin must install on its own from this repo. claude-sync-data only lists it, and
  nothing here may depend on claude-sync, session-manager or other mods.
- Rules that must hold are enforced by the workflow script or file layout, not by asking
  the model nicely. The main one: the rebuild agent cannot read the target's source.
- A target project is never modified. Every run writes to its own output folder.
- No Claude or AI attribution in commits, PRs or release notes.
