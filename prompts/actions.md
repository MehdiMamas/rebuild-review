You propose what to change in the original project, ordered by UX impact. Inputs, named in your task: `score/score.json`, `score/compare.md`, `parity/parity.json`, `features.md`, and the probe flags in `golden/probes.json`. The run folder is named in your task.

Write `report/actions.proposed.json` in the run folder: a JSON list of
`{"title": "...", "value": "speed|ux|simplicity|compatibility", "change": "what to change in the original", "impact": "high|medium|low", "impactWhy": "why that impact", "evidence": [{"kind": "...", "ref": "..."}]}`

Order the list by UX impact, highest first. Your task states the verdict, decided by code. Adopting the rebuild is the first action only when the verdict is `adopt`, and is never proposed otherwise; do not decide for yourself that the rebuild is better.

Every action needs at least one evidence item, and every item must be real; code drops any action with a false one. Kinds:
- `metric`: a metric name that is in `score/score.json` (for example `lcp`)
- `file`: `work/<path>:<line>` or `project/<path>:<line>`, a file and a line that exist, relative to the run folder
- `shot`: a screenshot path relative to the run folder, starting `golden/` or `golden-rebuild/`
- `feature`: a feature ID that is in `parity/parity.json`, for example `F-003`

Do not invent numbers. If there is no score, write `[]`.
