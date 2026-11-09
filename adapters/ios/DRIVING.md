# Driving an iOS app

Platform `ios`. The app runs in an iOS simulator on a Mac, headless (Simulator.app is never opened). `run.json` is
`{ "platform": "ios", "dir"?, "install"?, "build", "app", "bundleId", "device"?: { "name", "runtime"? }, "launch"?: { "args"?, "env"? }, "env"? }`.

- `build` runs in `work/<dir>` with `RUN_DIR` set to the run folder. It builds for the simulator and keeps derived data in the run folder, for example
  `xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$RUN_DIR/dd" CODE_SIGNING_ALLOWED=NO build`.
  A failed build stops the run; the last 20 lines of the build log are in the reason.
- `app` is the built `.app`, relative to the run folder (`dd/Build/Products/Debug-iphonesimulator/App.app`). `bundleId` must match the app's own.
- `device.name` is a simulator device type (default `iPhone 16`); the capture also uses `iPhone SE (3rd generation)` for a second screenshot size.
  `device.runtime` (`iOS 18.3`) names a runtime; without it the newest installed iOS runtime is used and recorded in `manifest.json` `versions`.
  A runtime that is not installed stops the run with its exact name.
- `launch.args` and `launch.env` are given to the app at every launch (env reaches the app through `SIMCTL_CHILD_`).
- The simulator shares this machine's network and cannot block it. An address in `launch` or `env` that is not this machine is refused unless `--allow-network` is given.

## What the capture does
- Makes its own device named `rr-<id>`, boots it with `simctl`, installs the app, and deletes the device when it ends (also on Ctrl-C). It never touches another device.
- Reads the accessibility hierarchy (type, label, identifier, exact frame in points) from the driver Maestro starts on the simulator, taps buttons, links, cells and tabs, and relaunches the app and replays the steps to come back to a screen.
- The app's extensions (Share extension, widget, Watch app) are not driven; they are listed in `manifest.json` `notCaptured`.

## Steps in states.json
`{ "click": "<name>" }` (the control with that label, title or identifier; `"index": n` picks the n-th of the same name), `{ "type": { "into": "<name>", "text": "..." } }` (taps the field, then types), `{ "wait": <ms> }`. `open`, `press`, `failRequest` and `slowRequest` do not apply.

## Tests
- A parity test is a Maestro flow, `F-xxx.test.yaml`, one per feature. Start it with `appId: <bundle id>` and `- launchApp` (add `clearState: true` to start empty). A test passes when `maestro test` exits 0. 120 seconds per test.
- Maestro 2.x needs Java 17 or newer; set `RR_MAESTRO` to the Maestro binary if it is not on PATH.
- Run only where the machine is free: never on a desktop Mac someone is using.
