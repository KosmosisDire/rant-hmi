# Rant HMI

A GUI for designing safe, fast and powerful HMIs and apps easily. Design and deploy your user
interface in the web while the logic runs reliably in a native backend. Supports streaming
data over WebSocket or WebRTC.

![The editor, designing a robot cell's overview page](docs/editor.png)

![The finished page on an operator's screen, a job running](docs/page.png)

## Install

```
rant install hmi
```

## Usage

```
rant run Hmi project=C:/path/to/my-hmi    # a folder, made into a project when empty
```

Open http://localhost:6739 to design it, and http://localhost:6739/run on an operator's
screen.

## Build

```
cd client && npm install && npm run build && cd ..
cargo run -p rant-hmi -- path/to/my-hmi
```
