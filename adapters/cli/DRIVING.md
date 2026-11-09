# Driving a command-line tool

Platform `cli`. The tool has no server and no window. `run.json` is `{ "platform": "cli", "dir", "install", "build", "command": ["<exe>", "<fixed args>"...], "env"? }`. `command[0]` is either a name found on PATH (`node`) or a path inside `work/<dir>` (`./bin.mjs`, `target/release/tool`); an absolute path outside the work copy is refused. A fixed argument that names a file in the work copy is passed as its full path.

## Run the tool
- Never run it in the target folder or by hand. From a shell: `node <plugin>/adapters/cli/run.mjs --app <runDir>/run.json -- <args>` prints the result as JSON (`code`, `signal`, `stdout`, `stderr`, `ms`, `timedOut`, `written`).
- Every run is a new process in a new empty working folder with a new empty home (`HOME`, `XDG_*`, `APPDATA` point at it). The environment is an allowlist (PATH, LANG, LC_*, TMPDIR, TEMP, SystemRoot) plus `run.env`; `TERM=dumb`, `CI=1`, no `NO_COLOR`. Nothing carries over between runs, so a state that needs a file made by an earlier command is built with `file` steps.
- The network is blocked: inside a network namespace on Linux when `unshare` is allowed, otherwise through proxy variables pointing at a dead address (only tools that honour them are blocked). Say in your result when the tool needs the network.
- stdout and stderr are capped at 1 MB each. Output that is not UTF-8 comes back as base64 (`stdoutB64`). A run that has not ended after `timeoutMs` (default 30 s) is killed with its whole process group.
- Windows is refused.

## Steps in states.json
One state is one invocation built from its steps: `{ "args": ["add", "milk"] }` (arguments are joined in order), `{ "stdin": "text" }` (written, then stdin is closed), `{ "file": { "path": "in.txt", "content": "..." } }` (created in the working folder before the run), `{ "env": { "NAME": "value" } }`. A screen is one invocation; the other steps of the contract (`open`, `click`, ...) do not apply.

## Tests
- A parity test reads the run file path from `process.env.APP_RUN` and the path of the module from `process.env.CLI_RUN_MODULE`.
- `const { prepare, runCli } = await import(pathToFileURL(process.env.CLI_RUN_MODULE).href); const ctx = prepare(JSON.parse(fs.readFileSync(process.env.APP_RUN, 'utf8')), process.env.APP_RUN);` then `const r = await runCli(ctx, { args: ['--version'] });` and assert on `r.stdout`, `r.stderr`, `r.code` and `r.written`. Install and build have already run (`RR_PREPARED=1`).
- `runCli` options: `args`, `stdin` (a string; `''` closes stdin at once), `keepStdinOpen` (an open pipe that is never written to), `env`, `files` (`{ "path": "content" }`), `timeoutMs`.
- The limit is 60 seconds per test.
