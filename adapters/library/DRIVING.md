# Driving a package with the library adapter

`run.json`: `{ "platform": "library", "language": "node", "dir"?, "install"?, "build"?, "entry"?, "env"? }`. `entry` is the folder holding the `package.json` that names the exports (default `.`). There is no `start`, `address` or `command`.

## Steps

A screen is a list of steps run in one fresh process:

- `{ "call": "add", "args": [1, 2] }` calls an export; `"a.b"` calls a method of an earlier result or of an export.
- `{ "new": "Counter", "as": "c", "args": [5] }` builds an instance and names it; later steps use `c.inc`.
- `{ "get": "name" }` reads an export.
- `{ "list": true }` lists the export names (used when there are no type declarations).

`states.json`: `[{ "id", "subpath"?, "steps": [...] }]`. `subpath` is an export path such as `./noisy`.

## Values

Plain JSON passes through. Other values are tagged objects `{ "$": "..." }` in arguments and in results: `undefined`, `number` (`v` is `NaN`, `Infinity` or `-0`), `bigint` (`v` is a decimal string), `Date` (`v` is ISO text), `Map`, `Set`, `RegExp`, `Error` (`name`, `message`, `code`), `bytes`, `symbol`, `Promise`. A function result is `{ "$": "fn", "name" }`, an instance is `{ "$": "instance", "class" }`, never a serialized body. In arguments only: `{ "$": "cb", "returns": ... }` is a callback whose calls are recorded in the step's `callbacks`, and `{ "$": "frozen", "v": ... }` is a deep-frozen value (used to see whether a call changes its argument).

## Isolation

Each run is a new process in an empty working folder with an empty home, an allowlisted environment (plus `run.env`), no network (a network namespace on Linux when `unshare` is allowed, otherwise a dead proxy), an output cap of 1 MB per stream and a 30 s limit; the whole process group is killed at the end. This is not a file-system sandbox: a package can still read files by absolute path.

## Parity tests

A test gets `APP_RUN` (the run file) and `LIB_MODULE` (the absolute path of `run.mjs`):

```js
const { prepare, runSteps } = await import(pathToFileURL(process.env.LIB_MODULE).href);
const ctx = prepare(JSON.parse(fs.readFileSync(process.env.APP_RUN, 'utf8')), process.env.APP_RUN);
const r = await runSteps(ctx, [{ call: 'add', args: [2, 3] }]);   // r.results[0].returned
```
