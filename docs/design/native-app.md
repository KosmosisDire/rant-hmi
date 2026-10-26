# Native app

A design record for item 25: an HMI as a native app. Written for review, with the options
weighed and why each choice was made.

## The ask

The user's words, 2026-10-21, low priority:

> Run an HMI as a native app. Build and hand out a finished HMI as one standalone executable
> running backend and screen in one process, talking with no network between them, or the
> screen alone as a native app with the backend elsewhere.

The user's vision, 2026-10-22, which now leads the design:

> You would have the web version hosted normally with the backend etc like we do it normally.
> You would design your app in there test it maybe use it on some devices. Then you have a
> device you want to run it native on so you would press a button in the designer to build the
> app, the backend would build the app for the requested platform and it would then download
> the app from the frontend (so you could open the hmi web onto whatever device you want the
> native app on and just get it there immediately). Linux is a large contender here, especially
> the steam deck or other handhelds or touch hmi devices running linux or windows. macos is a
> much smaller priority for this, but should still work if possible.

> It should include all dependencies if possible with no need for installing anything new.

> Wayland or X11 should both be supported as well.

So the flow is:

1. Design and test the HMI in the browser, served by the backend as today.
2. On the device that should run it, open the HMI's editor and press a button.
3. The backend builds the app for that device's platform and the browser downloads it.
4. The app runs on the device with nothing else installed.

## What holds the design

- UI is HTML, CSS and SVG. The pages and components a designer makes are web pages, so the
  screen in a window must be the same client, not a second renderer.
- What is designed is what runs: the app's engine should be the one the designer tests in.
- Nothing to install on the device. The app brings its engine and every library it needs.
- Linux first, Windows beside it, macOS if it can be had. Linux on Wayland and on X11.
- The backend builds an app for any platform from any platform, with no compiler.
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
  then its messages, then a close. `web.rs` was the only door that made those.

## Part 1: the engine

### What the devices have

- The Steam Deck does not reliably ship WebKitGTK. One report on SteamOS 3.9.2 found
  `libwebkit2gtk-4.1.so.0` missing, and SteamOS wipes what pacman installs on its next update.
  Other handheld systems (Bazzite, ChimeraOS) are immutable in the same way.
- Windows 10 and 11 carry WebView2, but Windows 10 IoT Enterprise LTSC, common on panel PCs,
  and Windows Server often do not.
- macOS always has WKWebView.

So on Linux, and on some Windows panels, the app must bring its own engine.

### Options

| Engine | For | Against |
| --- | --- | --- |
| The system webview through wry and tao | A few MB on Windows and macOS. Plain Rust in our process. | Linux must bundle WebKitGTK and GStreamer, about 100 MB, which is known to be fragile and is unproven on SteamOS. A different engine on Linux than the designer tests in. LTSC needs WebView2 bundled, about 150 MB. |
| Chromium from Electron | Prebuilt for every target. H264 included, so WebCodecs video plays. Same engine as Chrome and WebView2. Runs on the Steam Deck, where Electron apps such as Heroic are common. Native Wayland or X11 by itself since Electron 38. | About 100 MB a download. Node beside our backend in the main process. |
| Chromium from CEF (cef-rs) | Chromium in our own Rust process | Stock CEF builds leave H264 out, so video would need our own Chromium build on every target. |
| The system webview on Windows and macOS, Chromium on Linux | Small where it can be | Two window shells and two engines to keep and test. |

Chosen by the user, 2026-10-22: Chromium from Electron everywhere.

The first window was built on wry, before the vision (see As built). It proved the link and the
seams, which all stay. Only the window shell changes.

### The shape

- Electron's main process loads the backend as a Node native addon (napi-rs), built from the
  server's library. Backend and window main share one process, so there is still no network.
- The window serves `hmi://localhost`, a scheme registered as standard and secure, so the page
  is a secure context. `protocol.handle` hands each request to the addon, which answers from
  the same `link::router` as before: the client's files and `/link`.
- A preload script tells the page it is in the app, as the init script did.
- Given an address, the window loads that HMI's `/run` and the addon starts no backend.
- Playwright drives Electron through its own debugging port, so tests check the real window.

### Wayland and X11

Since Electron 38 Chromium picks Wayland in a session that says it is one (`XDG_SESSION_TYPE`),
as GNOME and KDE do, and X11 elsewhere, as Steam's Game Mode offers. A compositor alone, as a
kiosk or a panel runs one, says no session, and Chromium then looks only for X11 and ends. So
the launcher names Wayland where it is the only display. `--ozone-platform=x11` stays a way out.

On Linux Chromium's sandbox needs unprivileged user namespaces. Ubuntu 24.04 and later restrict
them for programs without an AppArmor profile, and Electron apps then fail at start. The app
checks and runs without the sandbox where it cannot have it. It shows only its own client and
the HMI it was built from.

## The link with no network

| Option | For | Against |
| --- | --- | --- |
| The server on loopback TCP | No client change | A network after all: any program on the host reaches the port, a port can clash. |
| The engine's IPC | Built in | Text only through wry. Through Electron a second protocol beside the one the scheme gives. |
| The window's own scheme | Only this window can reach it. Binary both ways. The page is a secure context. | A link of our own on the client. |

Chosen: the window's own scheme. On it:

- the client's files, from the same files service the web server uses
- `POST /link` opens a session and answers its number
- `POST /link/<n>` carries the screen's messages, each after its length
- `GET /link/<n>` waits for what the loop sends and answers every piece ready, each after its
  length. The next poll goes when the screen has read these, so a screen is never sent more
  than it reads.

Ordering: the screen keeps one POST in flight and sends what queued meanwhile in the next, so
messages arrive in the order sent, as on a socket.

A page reloaded or gone stops pinging, and the loop drops its session after five seconds, as
it drops a lost socket.

In one process there is no network for WebRTC to be faster on, so the screen takes everything
over the link, video frames too, exactly as a screen whose WebRTC failed does today.

## Part 2: what an app runs

Chosen by the user: either, picked when building.

- **This HMI on the device.** The app holds the project and runs its backend inside: the node,
  the logic, the screen. No server needed. It joins the domain the server was on.
- **This server's screen.** The app holds the server's address and is a window onto its `/run`.

Both are the same runtime: what the app holds decides which. From the command line the same
choice is the argument, a folder or an address.

A self signed certificate is refused by Chromium as it was by WebView2. The app trusts the
certificate of the server it was built from by its fingerprint, which the build writes in.

## Part 3: one file to hand out

### Options

| Option | For | Against |
| --- | --- | --- |
| Build each app with a toolchain | Any format | A compiler, Electron's tools and every target's SDK on the server. |
| An installer format per OS (MSI, AppImage, DMG) | Familiar | A tool per format to run on the server, and the AppImage needs FUSE. |
| A launcher with archives appended | One way on every OS, made by joining files, so any server builds for any target | Unpacks once on first start. Sign after building. |

Chosen: a launcher with archives appended.

- The release builds a runtime per target: the launcher, a small Rust exe, and an archive of
  Electron, the addon, the main script and the built client.
- The server builds an app by streaming the launcher, the runtime archive, an archive of the
  project (or the address), and a trailer saying where each begins. Nothing is written to disk
  and a build takes no longer than the download.
- Started, the launcher reads its trailer. It unpacks the runtime into the user's local data
  once per runtime version, so every app of that version shares it, and the project once per
  build. Then it starts Electron on it and waits.
- macOS takes an app bundle instead, the runtime and the project in its resources, signed ad
  hoc by the server after building, since Apple silicon runs nothing unsigned.

### Where runtimes come from

- A server builds apps from `~/.rant/hmi/runtimes/<version>/<platform>/`: `launcher[.exe]`,
  `runtime.tar.gz` and `runtime.id`, for `win-x64`, `linux-x64`, `linux-arm64` and
  `osx-arm64`.
- `npm run runtime` in `app` builds this host's and puts it there (built, slice 4).
- Each release attaches every platform's as `rant-hmi-runtime-<version>-<platform>.tar.gz`,
  those three files archived, and the server fetches the one a build needs from its own
  version's release the first time it is asked (slice 7). An offline server takes the file by
  hand, put in the runtimes folder as it is.
- Platforms take the names the release's archives have, as `rant install` reads them.

## Part 4: built from the editor

- A button in the editor's top bar, "Get the app", opens a sheet.
- The sheet picks the platform of the device it is open on, from the browser, and offers the
  others. It asks what the app runs: this HMI on the device, or this server's screen.
- Download streams the app, named after the HMI: `Packing line.exe` on Windows, `Packing line`
  on Linux, `Packing line.zip` with the app bundle on macOS.
- An app is about 170 MB, and its runtime unpacks to about 390 MB on the first start.
- Linux browsers drop the mark that lets a file run, so the sheet says how to set it. On a
  Steam Deck, "Add to Steam" then puts it in Game Mode, where the gamepad drives it.
- Windows warns about an unsigned exe until it is signed.

## Slices

1. The link, the `Door`, `Hmi::start` and `run`, the client's link shape, and a window.
   Built, with the window on wry.
2. The screen alone. Built with the first.
3. The Electron shell on Windows: the addon, the main script, the scheme, the preload. The wry
   window goes. Playwright drives the real window. Built.
4. The launcher and its archives: an app for this host built and run from one file. Built.
5. Built from the editor: the `/app` route, the runtime cache, the sheet, the domain and the
   certificate written in. Built.
6. Linux: runtimes for x64 and arm64, run under Wayland and X11 (WSLg offers both here), the
   sandbox check. Then on a Steam Deck, in the desktop and in Game Mode. Built for x64, arm64
   comes with CI.
7. Release: CI builds every runtime and attaches them, the server fetches by its version, docs
   and the agent skill. Built.
8. macOS: the app bundle and its ad hoc signature. Later, as its own item.

## Runtimes for released servers

Item 31, the user's ask of 2026-10-24: a released server on Ubuntu offered no app for any
platform, its sheet saying it had no runtime, since only `npm run runtime` in a checkout makes
one, and only for its own host. The parts:

1. Where a server gets each platform's runtime. A Linux server builds a Windows app for a panel
   PC too, so it needs runtimes it cannot build.
2. Who builds them. Only a host of that platform can: the addon and launcher are native code,
   and Electron comes per platform. So CI builds them, one runner each.
3. Linux had never run: the sandbox check, Wayland and X11, arm64.
4. macOS needs an app bundle signed after the project goes in.

| Where runtimes come from | For | Against |
| --- | --- | --- |
| The release attaches each, the server fetches one on first use | The package stays 8 MB, only what is used is fetched, any server builds any platform | The first build of each platform downloads 166 MB, an offline server takes the file by hand |
| Every package carries all | Offline | `rant install hmi` grows to about 520 MB, headless servers too |
| Each package carries its own | Offline | About 180 MB, and a Linux server builds no Windows app |
| The server assembles Electron's own release with a small part of ours | Release files about 20 MB | It repacks Electron, more code and a second source to pin |
| Built on demand | | A compiler and every target's tools on the server |

Chosen by the user, 2026-10-24: fetched from the release, platforms named as the release names
them (`win-x64`, `linux-x64`, `linux-arm64`, `osx-arm64`), macOS later. The steps: Linux runs
(slice 6), CI builds and attaches every runtime, the server fetches its version's, docs and the
skill, then a release when the user says.

## Open questions for the user

- Updates: an app is a snapshot of the HMI when built. Should it ask its server for a newer
  build when it can reach it, and offer to update itself?
- Two copies of one HMI: an app running the HMI and the server running it both run its logic,
  so what the logic does by itself (timers, watches) happens once per copy. And every HMI's
  node is named `hmi`, so they clash on the mesh. Name the node after the HMI and the device?
- Full screen with no title bar for a panel or a handheld: a choice in the sheet?
- Should an app that runs the HMI also serve it on the network, so phones reach it too?
- Signing: Windows warns about an unsigned exe and macOS refuses an app from the internet
  until opened by hand. A certificate to sign with on the server, later?

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
- The window is the package `app/` (wry 0.57, tao 0.37), with a workspace and lock of its own.
  wry's Linux crates pin exact old `toml_edit` and `toml_datetime` (through glib-macros and
  proc-macro-crate 2), and cargo resolves every platform at once, so in the server's lock they
  took the server's `toml` from 0.8.23 back to 0.8.2 on every build. The backend runs on a
  thread with its own runtime and the window on the main thread. A start that fails shows why
  in the window. Closing the window ends the screens' sessions and the node, then the process.
  Slice 3 replaced this package.
- Client: `net/link.ts`, which `connection.ts` now opens. In the app no WebRTC is offered. The
  editor's status bar says "Reached in this app, with no network".
- Tests: cargo tests drive the link (order both ways, a poll that waits, the last message of a
  dropped session, a body cut short). Slice 3 moved the window's checks to the real window.
- WebView2 here (runtime 155) opens no debugging port, so the wry window was checked through
  the app's log. Electron's window is driven directly.

### Slice 3, the Electron window

- `app/` is the Electron app: `main.mjs`, `preload.cjs`, `package.json` pinning Electron
  44.9.3 (45.0.0 was a day old), and the Rant logo made square as `icon.ico` and `icon.png`
  for the window. The exe keeps Electron's icon until slice 4 stamps the launcher.
- `app/addon` is the crate `rant-hmi-addon`, a napi-rs 3 cdylib on the server's library, back
  in the server's workspace and lock: the old toml pin came from wry. It offers `start`,
  `request`, `stop` and `kept`. `start` runs the backend on a thread with its own runtime as
  the wry app did, and each request runs on that runtime, as a poll waits on its timers.
- napi on Windows links only for the MSVC target (the GNU one wants a `libnode.dll`, which
  Electron has none of), so the addon builds for `x86_64-pc-windows-msvc` there, and only
  when asked: the workspace's default members are the server alone, so `cargo build` and
  `cargo test` stay as they were. `npm run build` in `app` builds it and puts it beside the
  main script as `rant-hmi.node`. `HMI_ADDON` names another, as the tests do.
- Main: the scheme `hmi` is registered standard and secure, `protocol.handle` hands each
  request to the addon by method, path and body, and a screen served there gets the preload
  that sets `window.rantHmiApp`. Given an address no preload, so that screen is a browser's.
  The window's data goes to `~/.rant/hmi/window`. A start that fails shows a page saying why.
  The last window closed stops the backend, then the app quits.
- Arguments are read by name and the first plain one, passing over the switches Electron and
  Chromium take and the app's folder when run from source. With nothing to show the window says
  what to give it, since the folder it runs in would become a project, as the server makes one.
- From source it runs as `npx electron . <project>`. No npm script: Windows PowerShell drops the
  `--` of `npm start -- ...`, so npm took `--loopback` as its own and the app joined the network
  (the user hit it, 2026-10-22).
- Full screen (the user asked, 2026-10-22): F11 toggles it, as in a browser, since the window
  has no menu, and `--fullscreen` opens the window so. The build sheet can write it in later.
  F11 is caught before the page sees it, so a page cannot use F11.
- Tests: scenario app-window drives the window through Playwright's Electron support: it reads
  and writes the demo line, reloads into a new session, opens no socket, and the editor's
  status bar says it is in the app. Then started as a person starts it, without Playwright,
  whose debugging ports would listen: the screen keeps its one session past 5 s, the process
  listens on no TCP port, and closing the window ends the HMI, then the app. Then the window
  shows a running HMI's screen by its address, never told it is in the app, and a project that
  cannot open leaves the window saying why. F11 fills the screen and gives it back, pressed
  through Electron's own input, since Playwright's keys reach the page past the window, and
  the app opened with `--fullscreen` fills it. Given nothing it says what to give it and leaves
  its folder empty. Removing the preload fails it, so does closing without stopping the
  backend, a wrong key, the flag ignored, or the folder it runs in taken as the project. The `linked` example went, as nothing needs it now.
- Traps found: this shell inherits `ELECTRON_RUN_AS_NODE=1` from VS Code's extension host,
  which makes Electron plain Node, so the harness clears it. Playwright starts Electron through
  `cmd.exe` on Windows, so a kill ends only cmd and the harness ends the whole tree. Playwright
  reads the app's output itself until launch returns, so a start error is checked on the
  window, not in the log. The harness starts programs with their console hidden, and Windows
  then sometimes started the app's window hidden too, which a polite close never reaches, so
  the app is started shown.

Choices worth a second look:

- Electron 44.9.3, not 45.0.0.
- The addon only for the MSVC target on Windows, and out of the default members.
- The window opens at 1280 by 800, keeps its menu hidden, and takes its title from the page.
- F11 belongs to the window, not to pages.
- Two apps at once share the window's data folder, so the second cannot make its cache and
  says so, and their nodes clash as `hmi` (seen as Rant's duplicate-authority warning). Both
  wait on the node name question.
- The scenario shows real windows on the desktop, full screen for a moment, as the WebView2
  one did.

### Slices 4 and 5, one file built from the editor

- `app/pack`, the crate `rant-hmi-pack`, is the file's one definition, which the server writes
  and the launcher reads: a trailer of three ranges (runtime, project, settings) and a mark at
  the end, the settings as JSON (name, runtime id, what it shows, domain, loopback, full screen,
  the fingerprint it trusts), and folders as gzipped tar, skipping what starts with a dot. Ids
  are a SHA-256 of the archive, so a folder unpacks once per content. A folder unpacks into a
  sibling and is renamed into place, so a start cut short leaves nothing half done. `kept()`
  moved here, as the launcher shares it. Its command line archives a runtime for the script.
- `app/launcher`, the crate `rant-hmi-launcher` (program `rant-hmi-app`), windows subsystem with
  the Rant icon. It reads its own file, unpacks the runtime and project under
  `~/.rant/hmi/unpacked/<id>` once, starts Electron there with the settings and what it was
  started with, clears `ELECTRON_RUN_AS_NODE`, and ends with Electron's code. Why it cannot
  start goes to a message box on Windows.
- `app/runtime.mjs` (`npm run runtime`) builds the client, the release addon, launcher and
  pack program, puts Electron's own folder together with the window in `resources/app` and the
  client in `resources/client/dist`, where the window's default finds it, archives it, and
  installs it for this host's server. Electron's `default_app.asar` is left out. About 2.5
  minutes, most of it the release build.
- Server: `apps.rs`, `GET /app/targets` and `GET /app/<platform>?runs=device|screen&
  fullscreen=..&address=..`, on the web server only, so an app's own editor has none. The app
  streams from the runtime's files with the project archived from disk at that moment, so it
  carries the last saved edit. The domain is the server's, 0 read as Rant reads it, and the
  loopback the server's, so an app built from a test server stays on loopback. The fingerprint
  is SHA-256 over the certificate chain as Chromium writes it, `sha256/` and base64, made where
  TLS is set up and given only to an app reaching the server over https. A download is named
  after the HMI, as UTF-8 with a plain fallback.
- Window: `--trust` accepts that certificate in `certificate-error`. Every value is given as
  `--name=value`, since Electron ends at once, silently, when an address is followed by a value
  as the next word (found as the screen app quit at start). A server that does not answer shows
  a waiting page and is tried again every 3 s.
- Client: `shell/GetApp.tsx`, a download button in the top bar, hidden in the app, opening a
  popover (a sheet on a phone). Platform is picked from the browser (`userAgentData`, else
  `navigator.platform`), Windows on ARM and Intel Macs taking the platforms there are. A device
  with no app of its own, as a phone, is told its browser shows `/run`.
- Tests: cargo tests write and read an app, refuse a range past the end, keep one id for one
  folder, and build apps through the routes for both kinds, with and without https, refusing a
  screen app with no address and a platform with no runtime. Scenario app-export, on a fresh
  system with this host's runtime: the sheet picks Windows and greys out the rest, the app it
  downloads unpacks and connects on its first start (about 3.5 s) and its second (about 0.4 s),
  ending as its window closes, the unpacked runtime run on the unpacked project reads the demo
  line, and screen apps built over http by the sheet and over https by the route connect.
  Breaking the platform guess fails it, so does never trusting the certificate. The scenario
  first stood the runner still for seconds, which stalls every worker: the copy of the runtime
  and the window lookups block no more, and its check read the 166 MB body as text before
  checking, now only on failure. A failing run once left its window open, holding the runner's
  pipes until its time ran out, since ending an app left the window it started: a downloaded
  app's stop now ends the window too, and a run failed on purpose ends clean.

Choices worth a second look:

- tar.gz for every archive: an app is 166 MB on Windows. zstd or xz would be smaller, and slower
  to build.
- Unpacked apps stay in `~/.rant/hmi/unpacked` for good. Nothing yet clears old ones.
- The project in an app is a snapshot. An app does not update itself.
- The unpacked project is where the app's HMI keeps its state, so a new download starts afresh.

### Slice 6, Linux

- The launcher on Linux, before it starts the window:
  - checks the sandbox: a child it forks makes a user namespace and maps this user into it, as
    Chromium's sandbox does. Where that fails the window gets `--no-sandbox`. Ubuntu 24.04 and
    later make the namespace but deny the map to a program with no AppArmor profile, and older
    switches (Debian's `unprivileged_userns_clone`, `max_user_namespaces` 0) deny the namespace.
  - names Wayland, `--ozone-platform=wayland`, where `WAYLAND_DISPLAY` is set and `DISPLAY` is
    not. Before this, Wayland alone under WSLg ended at start with "Missing X server or $DISPLAY".
- The window closes on SIGTERM as on Ctrl C, as a session ending on Linux sends it.
- `runtime.mjs --built-client` takes the client in `client/dist` as it is, for CI.
- The app scenarios run on Linux. The harness closes a window with SIGTERM where Windows has
  taskkill, and finds a downloaded app's window through `/proc`, by its program's link, since
  Chromium writes its whole command line over its first argument. app-export takes this host's
  platform and its label from `/app/targets`, and sets the run bit on what it downloads, as a
  person must.
- Tested:
  - karbon, Ubuntu 22.04 on its X11 desktop: app-window and app-export pass. Its runtime built
    there in about 2 minutes and is 133 MB, the Windows one 166 MB.
  - An app built by the server ran sandboxed. Inside `unshare --user`, where a nested namespace
    cannot map its user, as under Ubuntu 24.04's rule, it ran without the sandbox, and its
    Electron alone there ended at start with Chromium's "The SUID sandbox helper binary was
    found, but is not configured correctly".
  - WSLg on Ubuntu 24.04, whose kernel has no AppArmor: a Wayland desktop's session (both
    displays and `XDG_SESSION_TYPE=wayland`) ran on Wayland with no X11 window, an X11 desktop
    on X11, and Wayland alone once the launcher named it.
- Not tried: arm64, which CI builds next, a Steam Deck, Ubuntu 24.04's AppArmor rule on a real
  machine, a desktop with no GPU.

Choices worth a second look:

- No sandbox where the check fails, rather than an AppArmor profile, which needs root to install.
- Where the launcher cannot start on Linux it says why on stderr only, which a start from a file
  manager never shows.

### Slice 7, runtimes in each release

- `rant-hmi-pack <folder> <file>` archives a folder as apps carry one and prints its id.
  `runtime.mjs` archives the runtime with it, then the platform's folder (the launcher,
  `runtime.tar.gz` and `runtime.id`) as the file a release attaches, so a checkout makes the
  same file CI does. The runtime inside is gzipped twice, which costs a few seconds and keeps one
  archive format for every part.
- CI's build job builds the runtime on `win-x64`, `linux-x64` and `linux-arm64` after the
  package, Linux in the manylinux_2_28 containers, and lints the addon and the launcher there.
  macOS waits for slice 8.
- A new job, check-apps, takes each platform's file as the release will carry it, unpacks it as
  a server would, and runs app-export, then app-window, on Windows and on Linux under Xvfb. Linux
  on ARM drives the editor in Playwright's Chromium, named by `HMI_BROWSER`, since Chrome has no
  build there. The release waits for it.
- GitHub's Ubuntu 24.04 runners keep `apparmor_restrict_unprivileged_userns` at 1, so
  app-export proves the launcher's sandbox check on x64 and arm64. Electron run from source has
  no such check, so app-window runs with the rule off.
- `release.py` checks that each release carries what it must: the HMI's four package archives
  and three runtimes, Rant's TypeScript package.
- CI shares one build per platform. Windows builds everything for the MSVC target the addon
  needs, so the runtime reuses the build. check-apps runs the build job's release programs and
  the addon the runtime carries, building nothing. Swatinem's rust-cache keeps each platform's
  dependencies between runs. A run took 29 minutes before, 13 with the cache empty, and 7.8
  with it filled: the Windows build 16.5, 10.6, then 5.4, its app check 12.5 then 2.

The server gets a platform's runtime the first time an app for it is asked for:

- `/app/targets` says of each platform whether its runtime is `here`, on the `release`, or
  `none` (macOS, until slice 8). The release's file put in the runtimes folder by hand counts as
  here.
- `POST /app/<platform>/runtime` gets it, answering a line of JSON as it goes: fetching, with
  the bytes got and of, unpacking, then done or failed. Asks at the same time share one fetch.
  `GET /app/<platform>` gets the runtime first too, for a client with no sheet.
- The file lands as `<file>.part`, renamed when whole. It unpacks into a folder beside the
  platform's, which takes the name only once `runtime.tar.gz` is the one `runtime.id` names. A
  fetched file then goes either way, and one put there by hand stays until it unpacks.
- reqwest 0.13, on the rustls and aws-lc-rs the server has, with the system's certificates and
  proxies. 15 s to connect, 60 s with no data.
- A failure says the address, why, and which file to put in which folder by hand.
- `--runtimes-from <url>` names a mirror of the release's files, for a site with no way to
  GitHub, and for the tests.
- The sheet: Download on a platform whose runtime is on the release has the server get it first,
  under a bar and "Getting the Windows runtime: 45 of 166 MB.", then downloads the app as
  before. A failure shows the server's message. Closing the sheet or picking another platform
  meanwhile leaves the app undownloaded.
- Tested:
  - cargo tests with a release on loopback: one fetch for two asks, a damaged runtime refused
    leaving nothing, a missing file saying where to put it, then that file put there by hand.
  - Scenario app-fetch: a slow release on loopback, the bar, the app built from what came, a
    second app fetching nothing, and the error for a platform the release lacks.
  - A real asset fetched from GitHub through its redirect, checked against Windows' roots.

Choices worth a second look:

- Downloading an app fetches its runtime when needed, rather than refusing until asked ahead.
- A failed fetch is not remembered, so each ask tries again.

The docs' As an app section says where runtimes come from, how to take one by hand, and how to
get an app with curl. The agent skill's HMI section has the same in a row and a line.
