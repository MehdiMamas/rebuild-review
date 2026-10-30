# rebuild-review

Claude Code plugin: a one-shot review that rebuilds a project from its behaviour and
rendered output, then scores the rebuild against the original. See README.md.

## Status

Planning. Nothing is built yet, so there is no setup, build, test or deploy step.
The design and the ordered work list are in issue #1. Update this file when that changes.

## Conventions

- The plugin must install on its own from this repo. claude-sync-data only lists it, and
  nothing here may depend on claude-sync, session-manager or other mods.
- Rules that must hold are enforced by the workflow script or file layout, not by asking
  the model nicely. The main one: the rebuild agent cannot read the target's source.
- A target project is never modified. Every run writes to its own output folder.
- No Claude or AI attribution in commits, PRs or release notes.
