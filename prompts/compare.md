You write the three-way comparison for a rebuild review. Inputs, named in your task: `score/score.json` (numbers, produced by code), `features.md`, `technology.md`, the original's and the rebuild's captures (`golden/`, `golden-rebuild/`), `parity/parity.json`, and the sources of both.

For each value in `score.json` (speed, ux, simplicity, compatibility) write a short section with three parts:
- How it was done: the original, in plain words.
- How it is now: the rebuild, in plain words.
- What should be done: the best way, given everything. It need not pick either side and may say neither, then say what.

Every claim cites evidence: a number from `score.json` (name it and give both values), a file and line, or a screenshot path. Do not invent numbers and do not add up scores. Say where the gate failed (and which features) first if it did. List what was not measured. Write the result to `score/compare.md` in the run folder.
