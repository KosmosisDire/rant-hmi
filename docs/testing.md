# Testing

## Backend

```sh
cargo test -p rant-hmi
```

This also writes `client/src/protocol` from the Rust types.

## Scenarios

Each scenario in `client/tests/scenarios` is a new user's task, driven in headless Chrome
against the demo line, the cage cell, rant-transcoder and a backend on loopback, domain 153 and
port 6761.

```sh
cargo build -p rant-hmi --bin rant-hmi --examples
cd client && npm run build
node tests/run.mjs          # every scenario
node tests/run.mjs drag     # those whose file name holds "drag"
```

- `HMI_BUILD` and `HMI_CLIENT` name another build and client to run, as ones made with
  `CARGO_TARGET_DIR=target/work` and `vite build --outDir ../target/work/client`, so the
  scenarios run while a backend from `target/debug` stays open on `client/dist`.
- The transcoder is `transcoder-rant/bin` in the RANT folder above, or what
  `HMI_TRANSCODER` names. Without it the video scenarios fail and say so.
- A console error fails a scenario, as does a check.
- A failure names the scenario line that threw and prints the backend's last words.
- Screenshots and the backend's whole log land in `client/tests/out`.

## Examples made in the editor

- `node tests/run.mjs build- --library` makes the standard components a new project starts
  with, in `server/library/components`.
- `node tests/run.mjs classic --into examples/classic` makes the cage cell's first HMI anew,
  from a new project. `--into` replaces that folder with what the scenarios made.
- The classic example runs against the cage cell, `server/examples/cage.rs`, which has the
  real cell's names and types: `cargo run --example cage` beside
  `cargo run -p rant-hmi -- examples/classic --port 6738`.

## Driving the HMI from code

`client/tests/hmi.mjs` speaks the protocol a screen speaks: add pages and elements, set
handlers and rules, import, set values, undo and redo. Scenarios set up with it, and a tool
or an agent can drive the HMI the same way.
