# Driving a service (backend adapter)

A service with an HTTP API and no pages. The adapter is the client: it starts the service from `run.json`, calls it with Node's `fetch` and records every request and answer.

## run.json

```json
{ "platform": "backend", "dir": ".", "install": "pnpm install", "build": "pnpm build", "start": "node server.mjs", "address": "http://127.0.0.1:4100", "openapi": "openapi.json", "readyPath": "/health", "env": { "DATABASE_URL": "sqlite:./local.db" } }
```

- `start` is a shell command run in `work/<dir>`; the port is in `PORT`. `address` must be on this machine.
- `openapi` is a path inside `work/<dir>` or a path on the running service (`/openapi.json`). `readyPath` defaults to `/`; any HTTP answer counts as up.
- `env` holds stand-in settings. A store outside this machine (a Postgres, Redis or cloud address) is refused with the reason, also when `stores` is set.
- `stores` (optional, at most 5) declares databases and caches the service needs, each run as a throwaway container: `{ "name": "db", "image": "postgres@sha256:<64 hex>", "port": 5432, "env": { "POSTGRES_PASSWORD": "stand-in" }, "ready": ["pg_isready"], "memory": "2g" }`. `name` is `[a-z][a-z0-9-]{0,30}` and unique; `image` must be given by digest, never by tag; `port` is the port the service connects to on `127.0.0.1` (unique, and not the service's own port; point `run.env` at it, for example `DATABASE_URL=postgres://postgres:stand-in@127.0.0.1:5432/app`); `env` is for the container and holds stand-ins only, because it shows in the process list; `ready` is a command run inside the container until it exits 0 (without it, a TCP connect to the container's port); `memory` overrides the default cap of `1g` (the pids cap is 512; no capability is dropped). Any other key is refused.

## What the service sees

- A new empty temp `HOME`, `XDG_*` and `TMPDIR` at every start with `fresh`, so embedded stores (SQLite, files, memory) start empty. A store kept as a file inside the work copy (`sqlite:./local.db`) starts empty too: the adapter records the untracked files after the build, and a fresh restart deletes any untracked file not in that set (ignored files included, `node_modules` excepted) and puts tracked files back to how the build left them (a `git stash create` commit taken after the build; `git checkout -- .` when the build changed none). The work copy must be a git checkout; otherwise only the temp folders are emptied. Environment allowlist: `PATH`, `LANG`, `LC_*`, `SystemRoot`, plus `run.env`.
- Linux with `unshare` and `ip` allowed: the service runs in a new user and network namespace with only loopback. The adapter reaches it through a helper that enters the same namespace (`nsenter`). Otherwise (proxy mode, for example on macOS) the proxy variables point at a dead address. That cannot stop raw TCP connections or a service that ignores proxy variables, so every capture made in proxy mode lists "network: proxy mode, raw connections not blocked" in `notCaptured`. Run services you do not trust on Linux.
- Store URLs (postgres, mysql, mariadb, mongodb, redis, amqp, kafka, nats and the like) that point outside this machine are refused in `run.json` env and also in the work copy's `.env*` files (not `.example`/`.sample`/`.template`; a key set in `run.json` env wins), `config/*.json|yaml|yml|toml|properties` and root `*.json|yml|yaml|toml|properties` (not `package.json`, `tsconfig*.json` or lock files; files over 1 MB are skipped). The `start`, `install` and `build` strings of `run.json` are checked the same way. The refusal names the file and the scheme, never the value.
- `network.har` drops Authorization, Cookie, Proxy-Authorization and Set-Cookie headers and any header whose value equals a `run.json` env value. `--max-har-bytes N` (default 50 MB) caps `network.har`; entries past it are dropped and counted in `coverage.json` `harEntriesSkipped`. Values of `run.json` env keys that match KEY, TOKEN, SECRET, PASS, CREDENTIAL or AUTH are replaced by `***` in every body and header written. A fresh start (and every parity test) removes files earlier runs left in the work copy: parity takes the untracked-file baseline once, before the first test. A GET whose two captures differ in status or shape gets "GET changed state: <route>" in `notCaptured`. A work copy that is not a git repo gets "fresh restart: work copy is not a git repo, file stores not reset".
- Stores: needs a rootful `docker` or `podman` (`RR_CONTAINER` names another command; a rootless runtime is refused, its container addresses cannot be reached from here). `prepare` pulls every image once per run (the only network step), then each fresh start runs the containers with `--pull=never` on a new internal network (`rr-<pid>-<random>`) with no published ports, waits until each is ready (`RR_STORE_READY_MS`, default 120 s, because a first-boot database can be slow) and relays `127.0.0.1:<port>` to the container: in namespace mode through a socket in the temp root (path at most 100 bytes), in proxy mode a listener on `127.0.0.1:<port>`, which is refused when the port is taken. `install` and `build` run before any store is up, so a build step that needs the database cannot work. A fresh restart removes the containers and starts new ones (the data is gone); a restart that keeps the temp root, or a service that died and is started again by `call`, keeps them. A failed start, `stop` with `removeRoot`, SIGTERM and process exit remove containers and network. Containers carry the labels `rr-backend`, `rr-owner` (pid), `rr-host`; `prepare` removes labelled ones older than 60 s whose owner on this host is gone. `RR_NET_MODE=proxy` forces proxy mode (tests). A store takes the time it needs to start before the service does: `startupMs` does not count it. Each fresh restart (every state and every mutating operation, each captured twice) rebuilds the whole container set, so a capture with stores can run long: `ready` may take up to 120 s each time.
- The service and everything it started are in one process group, killed on stop, timeout and exit. Windows is refused.

## Calling

`const ctx = prepare(run, runFile); await call(ctx, { method, path, headers, query, body, timeoutMs }); await restart(ctx, { fresh: true }); await stop(ctx)` from `api.mjs`. An answer is `{ status, headers, body, bytes, ms, cut?, error? }`: only allowlisted headers (no `Set-Cookie`, no `Authorization`), JSON parsed when the content-type says so, bodies cut at 1 MB, `status` 0 when nothing answered.

## Screens and states

A screen is one operation plus one state. Safe methods run on a fresh store; each mutating operation runs after a restart with empty storage. `states.json` steps are `{ method, path, headers?, query?, body?, save?: { name: "a.b" } }`; `{name}` in a later path or string is replaced by the saved value. The last step of a state is its screen. Each screen is captured twice; JSON values that differ become `"<varies>"` and are listed in `manifest.json` `volatile`.

## Probes

`server-error-on-valid`, `server-error-on-bad-input`, `stack-trace-in-body`, `error-not-json`, `wrong-content-type`, `no-timeout`, `cors-wildcard-credentials`, `secret-in-response`, `latency-ms` (a value, not judged).

## Parity tests

`node --test` files that import `prepare`, `call`, `restart` from `process.env.API_MODULE` and read `process.env.APP_RUN`. Start with `call`; do not use `fetch` on `APP_URL` directly, which is only reachable in proxy mode.
