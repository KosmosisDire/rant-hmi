# Native app

A design record for item 25: an HMI as a native app. Written for review, with the options
weighed and why each choice was made.

## The ask

The user's words, 2026-10-21, low priority:

> Run an HMI as a native app. Build and hand out a finished HMI as one standalone executable
> running backend and screen in one process, talking with no network between them, or the
> screen alone as a native app with the backend elsewhere.

Two parts:

1. One exe holds the backend and the screen, and they talk with no network.
2. The screen alone as a native app, its backend on another machine.

And a third the first implies: a finished HMI handed out as that one file.

## What holds the design

- UI is HTML, CSS and SVG. The pages and components a designer makes are web pages, so the
  screen in a window must be the same client, not a second renderer.
- One way to do each thing: the window reuses the backend's loop and the client's screen.
- The backend runs on headless machines too, so the server must never need a desktop library.
- A screen held by a person must lose nothing it has today: video, gamepads, keys, touch.

## Today

- `rant-hmi` is one Rust process: the Rant node, the logic in QuickJS, and the app's loop.
- It serves the built client folder over http and https on one port, and each screen opens a
  WebSocket at `/ws`. CBOR both ways, cut into pieces by lanes so a small message never waits
  behind a picture.
- Beside the socket a screen offers WebRTC data channels and video. Without WebRTC the socket
  carries everything, video frames too, which the page decodes with WebCodecs on a secure page.
- `/run` is the operator's screen. Every other path is the editor.
- The app's loop does not know sockets: a screen is an `Inbound::Open` with an outbox of lanes,
  then its messages, then a close. `web.rs` is the only door that makes those today.

## Part 1: the window

### Options

| Shell | For | Against |
| --- | --- | --- |
| wry and tao | The system's own webview: WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK on Linux. A few MB. Plain Rust in our process. | Each OS has its own engine. Linux needs WebKitGTK. |
| Tauri | wry and tao with a bundler, installers and updates | A CLI, a config, its own IPC and commands, and a project shape of its own. We need a window and one channel. |
| Electron | One Chromium everywhere | Node beside the Rust backend: two processes, about 150 MB each app. |
| A browser in app mode | No code: `msedge --app=http://127.0.0.1:6739/run` | A second process over loopback TCP, a browser that may be missing, and a window that can be sent anywhere. |
| CEF | One Chromium everywhere, in process | Over 100 MB each app, a heavy build. |
| A native renderer (egui, Slint, RmlUi as the explorer) | No web engine | Rewrites every page's HTML, CSS and SVG. Against the first rule. |

Chosen: wry and tao. They are what Tauri is built on, without the parts we would not use. A
probe on this machine's toolchain built and ran it: a hidden window, a page from the exe's own
scheme, binary both ways.

### The link with no network

| Option | For | Against |
| --- | --- | --- |
| The server on loopback TCP | No client change | A network after all: any program on the host reaches the port, a port can clash. |
| wry's IPC (`postMessage` in, a script run out) | Built in | Text only: CBOR goes as base64, and each video frame through a script. |
| The webview's own scheme | Only this webview can reach it. Binary both ways. The page is a secure context. | A link of our own on the client. |

Chosen: the webview's own scheme. The window serves `https://hmi.localhost` (wry's custom
protocol, which never touches a socket), and on it:

- the client's files, from the same files service the web server uses;
- `POST /link` opens a session and answers its number;
- `POST /link/<n>` carries the screen's messages, each after its length;
- `GET /link/<n>` waits for what the loop sends and answers every piece ready, each after its
  length. The next poll goes when the screen has read these, so a screen is never sent more
  than it reads.

The probe showed each part: a POST body arrives whole, a 200 KB answer comes back intact after
a wait, and the page is a secure context, so WebCodecs and gamepads work.

Ordering: the screen keeps one POST in flight and sends what queued meanwhile in the next, so
messages arrive in the order sent, as on a socket.

A page reloaded or gone stops pinging, and the loop drops its session after five seconds, as
it drops a lost socket. Nothing new handles it.

### WebRTC in the window

None. In one process there is no network for WebRTC to be faster on, so the screen takes
everything over the link, video frames too, exactly as a screen whose WebRTC failed does today.

### Seams

- Backend: a `Door` numbers every screen from one count and hands its events to the loop.
  `web.rs` and the window's link are its two users. `run` splits into `start`, which opens the
  project, the node and the port and fails before any window shows, and `run`.
- The link is an axum router called in process, so cargo tests drive it with no webview.
- Client: `net/link.ts` puts the socket and the window's link behind one shape: send, opened,
  heard, closed, and whether a network lies under it (WebRTC is offered only then). The shell
  says it is there with a script run before the page.

### Binaries

`rant-hmi` stays the server and never links a webview: a headless Linux box has no GTK. A second
binary of the same crate, `rant-hmi-app`, needs the cargo feature `window`, and is built where a
desktop is (Windows and macOS first).

```
rant-hmi-app <project>          runs it here and shows its operator screen
rant-hmi-app https://host:6739  shows that HMI's screen, its backend elsewhere
```

## Part 2: the screen alone

Given an address the window opens that HMI's `/run` as a browser would, over its socket and
WebRTC. No backend in process. A self signed certificate is refused by the webview, so for now
it takes http or a real certificate.

## Part 3: one exe to hand out

### Options

| Option | For | Against |
| --- | --- | --- |
| Build time embedding | Plain `include_bytes` | Needs a Rust toolchain wherever an HMI is packed. |
| A resource section (PE, Mach-O) | Signing keeps working | Different on each OS. |
| An archive appended to the exe | One way on every OS, made by copying the exe | Sign after packing, since it breaks a signature made before. A macOS app keeps it in its bundle instead. |

Chosen: an archive appended to the exe. `rant-hmi-app pack <project> <out>` copies its own exe and
appends the client and the project after it, with a trailer that says where they begin. Started,
the app finds the trailer, unpacks into a folder under the user's local data named by the pack's
id, and runs it as any project: no second way to read a project.

## Slices

1. The window in process: `rant-hmi-app <project>`, the `Door`, the link, the client's link
   shape. A scenario drives the real window through WebView2's debugging port.
2. The screen alone: `rant-hmi-app <address>`.
3. Pack: one exe holding the client and the project.
4. Release: CI builds the app on Windows and macOS, the package carries it, docs and the agent
   skill. A macOS bundle, Linux on WebKitGTK, an icon.

## Open questions for the user

- Should a packed app also serve the network, so phones reach it too? Today: the window only.
- Should the app open the editor too, a desktop designer? Today: the operator screen only.
- Full screen with no title bar for a panel PC: a flag, or a setting in `hmi.toml`?
- Trusting the HMI's own certificate in the screen alone, by its fingerprint.
- Installers: Tauri's bundler makes MSI, DMG and AppImage from a wry app, worth taking later.
- Windows Server and 10 LTSC lack the WebView2 runtime: ship its bootstrapper, or say so.
