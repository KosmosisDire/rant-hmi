# Testing

## Backend

```sh
cargo test -p rant-hmi
```

This also writes `client/src/protocol` from the Rust types.

## Scenarios

Each scenario in `client/tests/scenarios` is a new user's task, driven in headless Chrome
against the demo line and a backend on loopback, domain 153 and port 6761.

```sh
cargo build -p rant-hmi --bin rant-hmi --example demo
cd client && npm run build
node tests/run.mjs          # every scenario
node tests/run.mjs drag     # those whose file name holds "drag"
```

- A console error fails a scenario, as does a check.
- A failure names the scenario line that threw and prints the backend's last words.
- Screenshots and the backend's whole log land in `client/tests/out`.

## Driving the HMI from code

`client/tests/hmi.mjs` speaks the protocol a screen speaks: add pages and elements, set
handlers and rules, import, set values, undo and redo. Scenarios set up with it, and a tool
or an agent can drive the HMI the same way.
