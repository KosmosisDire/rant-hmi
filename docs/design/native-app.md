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

`rant-hmi` stays the server and never links a webview: a headless Linux box has no GTK. The app,
`rant-hmi-app`, is a package of its own in `app/`, on the server's library, built where a desktop
is (Windows and macOS first).

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
   shape. Built.
2. The screen alone: `rant-hmi-app <address>`. Built with the first, as they share the window.
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
- Every HMI's node is named `hmi`, so an app and a server on one mesh clash. Name the node
  after the project?

## As built

### Slices 1 and 2, the window and the screen alone

- Backend: `Door` (app.rs) numbers screens from one count for `web.rs` and the link.
  `Hmi::start` opens the project, the node and any port, and `Hmi::run(stop)` runs until stop:
  Ctrl C for the server, the window closing or Ctrl C for the app. `App::run` takes what feeds
  it as one `Sources`. `kept()` moved from tls.rs to lib.rs, as the webview's data shares the
  folder.
- `link.rs`: the link as an axum router, the client's files from the same service `web.rs`
  serves, and `/link`. A poll answers every piece ready, up to about 1 MB, waits 10 s at most,
  and counts as heard, as a pong does. A session's lanes are kept until read out, as a
  socket's writer keeps them, so the last message a dropped session was sent still arrives.
- The app is the package `app/` (wry 0.57, tao 0.37), with a workspace and lock of its own.
  wry's Linux crates pin exact old `toml_edit` and `toml_datetime` (through glib-macros and
  proc-macro-crate 2), and cargo resolves every platform at once, so in the server's lock they
  took the server's `toml` from 0.8.23 back to 0.8.2 on every build. Apart, the server's lock
  only gains `tower` for its tests, and only the app's backend reads TOML with 0.8.2. The
  backend runs on a thread with its own runtime and the window on the main thread. Each
  request on the window's scheme goes to the router in a task. A start that fails shows why in
  the window. Closing the window ends the screens' sessions and the node, then the process.
- Client: `net/link.ts`, which `connection.ts` now opens. In the app no WebRTC is offered. The
  editor's status bar says "Reached in this app, with no network".
- Tests: cargo tests drive the link (order both ways, a poll that waits, the last message of a
  dropped session, a body cut short). Scenario app-window runs the `linked` example, which
  serves the app's link over http on loopback, so headless Chrome drives the real client
  through it: it reads and writes the demo line, reloads into a new session, opens no socket,
  and the editor's status bar says so. Then the real window: its screen connects and keeps its
  one session past the 5 s a silent screen is lost in, the process listens on no TCP port, and
  closing the window ends the app by itself. Then the window shows a running HMI's screen by
  its address, and a project that cannot open leaves the window saying why until it is closed.
  A client that never takes the app link fails it, so does an app that never says it is there,
  and so does an app whose failed start closed the window at once, a bug the last part found.
- WebView2 here (runtime 155) opens no debugging port, whether asked through its variable or
  the option, so the window itself is checked through the app's log. The app passes
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` on, which wry's own arguments would replace, for a
  machine where it works.

Choices worth a second look:

- The app's own package and lock, so its backend reads TOML with an older `toml` than the
  server's. Moving the server to `toml` 1.x would let the app share its workspace again.
- The app is a windows subsystem exe, so double clicked it opens no console. Its log reaches
  only a pipe that started it.
- The window opens at 1280 by 800 and takes its title from the page.
- A screen in the app gets every video as frames over the link, decoded with WebCodecs, since
  it has no WebRTC.
- The screen alone refuses the HMI's own self signed certificate, as WebView2 does. Use http
  there for now.
- Not yet: packing one exe (slice 3), so the app still needs the client folder beside it
  (`--client`), and CI does not build the app. macOS should build as is but is untried, and
  Linux needs WebKitGTK.
