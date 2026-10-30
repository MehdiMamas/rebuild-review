# Benchmark fixture

A small task tracker (Vite, React, a node mock API) with problems planted on purpose.
The list is in `answers.json`: 7 defects, 4 hidden features, 4 bloat items.

**Agents under test must never be shown `answers.json`.** It is the answer key. The
`check-answers.mjs` script reads it too, so do not run that where an agent can see it.

## Run

```
cd benchmark
npm run bench        # installs app/ dependencies, builds, serves http://127.0.0.1:4173
```

Only localhost is used. Flags on the page URL: `?slow=1` (slow responses),
`?fail=list` (list loads fail), `?fail=save` (saves fail), `?density=compact`.

## Check the answers

```
cd benchmark
npm install          # playwright, for the check only
npm run bench        # once, to build app/dist (stop it afterwards)
npm run check        # starts the app on port 4199 and observes each defect and hidden feature
```

Bloat items are checked by grep.

## History

`npm run bench:init [dir]` replays `history/*.patch` (one commit per feature) into a new git
repo in a temp folder (or `dir`) and prints its path, for the git-history finder.
