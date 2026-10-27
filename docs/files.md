# Project files

An HMI project is a folder of plain text files. The editor writes them and so may you: a saved
change reaches every screen, and a file with a mistake leaves the last good one in place.
[reference.md](reference.md) lists every element, property, event and name in one place.

```
hmi.toml                 its name, the page screens open on, and its WebRTC servers
data/imports.toml        the mesh entities it uses, each under an alias
data/variables.toml      its own state
data/computed.toml       values worked out from others
data/records.toml        a value's history
data/theme.toml          design tokens, read as $name
pages/<name>.html        a page
components/<name>.html   a component
logic/handlers.html      handlers that belong to no screen
```

## Data

```toml
# hmi.toml
name = "Line"
start = "overview"
[[ice]]                      # the STUN and TURN servers screens find the HMI through
urls = "stun:stun.l.google.com:19302"
[[ice]]
urls = "turn:turn.example.com:3478"
username = "user"
credential = "secret"

# data/imports.toml
[[import]]
alias = "Speed"
entity = "Line1/Speed"
kind = "variable"            # topic, variable, function or task
intent = "write"             # or read
[[import]]
alias = "Lidar"
entity = "Lab/Lidar"
kind = "topic"
intent = "read"
rate = 5                     # at most 5 values a second, all it sends when left out

# data/variables.toml
[[variable]]
name = "mode"
start = "Auto"
per = "hmi"                  # one for every screen, or "screen" for each its own

# data/computed.toml
[[computed]]
name = "speedPercent"
get = "Speed * 100"
set = { target = "Speed", value = "v / 100" }

# data/records.toml, read as a list of { t, v }
[[record]]
name = "speedHistory"
source = "Speed"
every_ms = 100
keep_s = 600

# data/theme.toml
[[token]]
name = "accent"
dark = "#ff8800"
light = "#0088ff"            # left out, worked out from dark
```

Code sets a variable by assignment (`Speed = 0.5`), calls a function with `await Reset()` and
publishes on a topic with `Jog.send({ x: 1, y: 0 })`. A task is called as a function is, with a
last function for each progress update: `await Fill(5, (p) => { filled = p })`.
`Fill.cancel()` stops it.

## How screens get their values

- A screen gets the values of only the imports and computed values its pages show. The
  editor's Data tab gets every one as the HMI brings it, its big values 250 KB a second at most,
  so they leave the link to the screens that show them.
- The Data tab says which fields of an import come and what reads each. A field picked there
  comes while it stays picked, though nothing else reads it.
- A screen gets only the fields its pages read of each value, and the HMI decodes only those a
  screen or its own code reads, found from the code without running it. A page that shows a
  camera's width never brings its pictures. Code that hands a value on whole, or that the HMI
  cannot follow, reads all of it, and an import to write is read whole.
- A topic it reads may take a rate: each publisher then sends it that many a second at most,
  best effort, the newest at each turn. A value waits for its turn, up to the time between two
  its source sends: up to 100 ms for a source sending 10 a second.
- Small values, replies and what a screen sends go on its socket. A value over 16 KiB goes on a
  second socket, read off the page's main thread, one at a time per import: the next waits
  until the screen has shown the last, and only the newest waits.
- A page on https takes those big values over WebTransport instead, on the HMI's port over
  UDP, and over the second socket where WebTransport does not open within 5 s.
- A screen on the HMI's own host gets big lists of numbers as they are, any other compressed.
- After its first, a big list goes to a screen on another host as the change from the one it
  showed last: the rows it kept, wherever they moved, and its new rows. A map of a million
  points that gained a few goes as about what is new. A list mostly new, as a lidar's, goes
  whole, and so does a list of single bytes, as a grid's.
- The screen's scenes draw off its main thread too, beside the big values. A big value only
  a scene's points read stays there, and each new one draws as it comes. Anything else that
  reads it, as a text showing its length, brings it to the page whole.

## WebRTC

A screen opens a WebRTC connection beside its socket as it connects. It carries the screen's
video, and its `link` channel carries what the socket did: values, big values, pings and
actions, as that way is direct where the socket may come through a proxy, as a Cloudflare
tunnel. The socket says last that the channel takes over, each way, so nothing comes out of
turn, and the channel keeps on the way only what arrives in its round trip. A channel that
breaks gives all back to the socket, and the screen every value anew. A screen on the HMI's
own host keeps to its socket.

- A new project starts with two public STUN servers in `ice`. `ice = []` asks none.
- The HMI offers every address of its host, and the address its NAT shows the outside, as
  the STUN servers tell. `rtc_ports=6740-6759` on `rant run Hmi` pins its ports, to open them
  in a firewall or forward them.
- A TURN server relays for a screen that reaches the HMI no other way.
- A screen whose WebRTC did not open says why in a banner: a browser that gathered no address
  at all is told not to use UDP, as a VPN or a privacy extension makes so.
- Behind a proxy on the HMI's host, as cloudflared, a screen counts where the proxy says it
  is (`CF-Connecting-IP`, `X-Forwarded-For`), so it gets its values compressed.
- Without WebRTC a screen decodes video itself from frames on its socket, which only a page
  on https or localhost can do. Elsewhere the video says why it does not play.

## https

The HMI serves https on its port beside http. A screen away from the HMI's host needs it for
gamepads and to decode video itself.

- The HMI makes its own certificate once and keeps it in `~/.rant/hmi` for every project on
  the host. A browser warns about it until told to trust it.
- `--cert` and `--key` take a real certificate and its key, as PEM files.
- WebTransport has a certificate of its own, which a page trusts by the hash the HMI tells it,
  with no warning. A browser takes one that way for two weeks at most, so the HMI makes a new
  one each week.
- WebTransport takes UDP on the HMI's port. Where a firewall passes only TCP, a screen's big
  values come on its socket for its first 5 s, then on its second socket.

## As an app

The download button in the editor's top bar gets the HMI as an app for a device: open the
editor on the device, pick what the app does, and download it. The app is one file with
everything it needs, so nothing is installed first.

- **Platform**: this device's is picked, of Windows, Linux and Linux on ARM. macOS comes later.
- **Runs**: in the app, the HMI and its logic run on the device with no server, on the domain
  the server is on. On this server, the app shows the server's screen, trusting its own
  certificate.
- **Opens**: in a window or full screen. F11 switches between the two.

The first start unpacks the app into `~/.rant/hmi/unpacked`, which takes a few seconds, and later
starts begin at once. An app is the HMI as it was when downloaded: download it again for a newer one.

- Windows warns about an app from an unknown publisher: choose More info, then Run anyway.
- Linux needs the file marked as a program first, with `chmod +x` or in its properties.
- `curl -o line.exe "http://host:6739/app/win-x64?runs=device"` gets one with no editor. The
  platforms are `win-x64`, `linux-x64` and `linux-arm64`. `runs=screen&address=http://host:6739`
  gets one showing that screen, and `fullscreen=true` one that opens full screen.

An app is built from its platform's runtime, the window it runs in. The server gets a
platform's from the [HMI's release](https://github.com/KosmosisDire/rant-hmi/releases) of its
own version the first time an app for it is downloaded, about 170 MB, and keeps it in
`~/.rant/hmi/runtimes/<version>/<platform>`.

- A server with no way to GitHub takes the file by hand: get
  `rant-hmi-runtime-<version>-<platform>.tar.gz` from that release and put it in
  `~/.rant/hmi/runtimes/<version>/` as it is.
- `--runtimes-from <url>` fetches them from a mirror of the release's files instead.

## In a window

From source, `rant-hmi-app` is the window those apps run, on Chromium from Electron:

```
cd app && npm install && npm run build
npx electron . path/to/my-hmi --loopback
npx electron . http://host:6739
```

- Given a folder it runs that project in the same process as its window, with no network
  between them. It listens on no port, so no other screen and no editor reach it.
- Given an address it shows that HMI's screen, as a browser would, and tries again while it
  does not answer.
- `--fullscreen` opens it full screen, and F11 switches.
- It keeps the window's data in `~/.rant/hmi/window`.
- `npm run runtime` builds this host's runtime for apps and puts it where this host's server
  builds apps from, `~/.rant/hmi/runtimes/<version>/<platform>`.

## Pages

```html
<page name="Overview" size="128x72">
  <div id="e1" name="Card" x="4" y="4" w="24" h="12" style="background: $panel; border-radius: $radius">
    <on event="tap">
      Speed = Speed + 0.1;
    </on>
    <span id="e2" name="Reading" x="2" y="2" w="20" h="4">Speed.toFixed(2)</span>
  </div>
  <Gauge id="e3" name="Dial" x="32" y="4" w="16" h="16" value="Speed * 10"/>
</page>
```

- A frame is a `div`, a text a `span`, and a component a tag of its name. Each element has an
  `id` of its own in its file.
- Every value but `id` and `name` is an expression, text in quotes. The math is in
  [math.md](math.md).
- Lengths are units of 10 px. `x`, `y`, `w` and `h` also take a percent of what holds the
  element, and `w` and `h` take `hug` or `fill`.
- `style` holds the rest as CSS, with lengths in units: `layout: "down"; gap: 1; padding: 1`
  lays out a frame's parts. CSS in quotes is taken as written: `box-shadow: "0 2px 8px #0008"`.
- `<on event="...">` holds a handler: `tap`, `press`, `release`, `hold`, `repeat`, `drag` or
  `outside`. Its `p` holds `x` and `y` across the element, 0 to 1. A hold runs
  `after="ms"`, 500 when left out, and a repeat `every="ms"`, 100. Each is an expression.
- A drag's `p.dx` and `p.dy` say how far it moved since the last, in the units the element's
  own x and y count, so `x="PuckX"` follows the pointer with `PuckX = PuckX + p.dx`.
- `scroll` hears a wheel or a trackpad over the element, and `zoom` the same with Ctrl, as a
  trackpad's pinch comes. One with no scroll handler zooms by any wheel. A scroll's `p.dx` and
  `p.dy` move what it shows as a finger dragging it would, so a wheel turned down gives `dy`
  below 0. A zoom's `p.factor` is how much bigger it grows. Both bring `x` and `y` too.
- On a touch screen two fingers scroll by their middle and zoom by their spread, and the press
  they began ends with a release but no tap. One finger scrolls what takes scroll once it moves
  a little, unless what it pressed takes drag. Safari's pinch on a trackpad zooms too.
- A drag or scroll handler that takes a while to run misses no move: what comes meanwhile adds
  up, and a zoom's factors multiply.
- A page's handler that touches only the screen's own variables, reading what its event brings,
  tokens and the math, runs on the screen itself, so a view it pans follows the finger with no
  round trip. Any other runs on the system. Either way it does the same, and what a screen sets
  of its own shows at once.
- `keydown`, `keyup` and `keyrepeat` hear the keyboard while the element shows on the top page
  and no field is typed in. `key="a"` takes the key that types a, "A" with Shift and " " for
  Space, and `code="KeyA"` the key where a sits. With neither it takes any key. `p` holds
  `key`, `code`, `shift`, `ctrl` and `alt`, and a keyrepeat runs `every="ms"`, 100.
- `buttondown` and `buttonup` hear a gamepad's buttons the same way. `button="south"` takes
  one by where it sits, whatever its maker prints on it, as
  [reference.md](reference.md#the-button-filter) lists them. `pad="1"` takes only the second
  pad. `p` holds `button` and `pad`.
- `axes` hears the sticks and triggers once a frame while they move, then once at rest with
  zeros. `p` holds `lx`, `ly`, `rx`, `ry` from -1 to 1, each y up, `lt` and `rt` from 0 to 1,
  every axis in `axes`, and `pad`. Each counts from 0 past `deadband="0.1"`.
- An element holds one handler per event and filter. A key a handler names does nothing else
  on the screen, so Space never presses a button.
- Any handler but an end, a release, a keyup or a buttonup, takes `while="condition"`, and
  hears its event only while the condition is true. An end always runs, axes at rest too.
- A key or button held ends with its keyup or buttonup, and moving sticks come to rest, however
  they end: let go, the window losing focus, the pad gone, the page closed or covered, the while
  that heard them turning false, or the screen silent for half a second or lost. Then `p.lost`
  is true, as on a release a lost screen leaves.
- A screen whose page hides, as a tab behind another, is sent no values until it shows
  again, when it gets every value anew at once.
- `repeat="6"` or `repeat="Jobs"` draws an element once per item, reading `index` and `item`.
- `<svg>` holds shapes, `<markup>` SVG made by code, `<canvas>` what its code draws,
  `<scene>` 3D parts such as `<box>` and `<anchor>`, `<media src="Camera"/>` a camera or a
  picture, and `<input>` a field to type in.
- `shows="over"` opens a page over another, as a dialog: `await open(Pages.Confirm)`.

## Components

```html
<component name="Meter" size="24x16" sizing="fill">
  <prop name="level" default="0" bindable="true"/>
  <prop name="colour" default="$accent"/>
  <event name="change"/>
  <var name="peak" start="0"/>
  <span id="e1" name="Reading" x="1" y="1" w="22" h="4" style="color: colour">level + "%"</span>
</component>
```

- A `<prop>` is an input each instance sets as an attribute. A `bindable` one writes back to
  what the instance binds it to.
- `emit("change", value)` sends an event, handled on the instance by `<on event="change">`.
- A `<var>` is each instance's own state on each screen.
- `sizing="fill"` lays it out in each instance's box. Without it an instance scales it whole.
- Code reads a part's `pressed`, `hovered` and `heldFor` by its name, `root` for the whole.

## Logic

```html
<logic>
  <on id="h1" name="Too fast" when="Speed > 1.5" for="2000">
    notify("The line runs too fast");
  </on>
</logic>
```

A handler runs on one of `every="ms"`, `when="condition"` with an optional `for="ms"`,
`change="name"`, `start=""`, `screen="connects"` or `screen="leaves"`.

## Problems

Every screen lists what goes wrong on it, and the HMI gathers every screen's in one list.

- A page's: a property or drawing that fails, an instance whose component is missing, a video
  the screen cannot play. It holds while an element shows it, and goes once fixed.
- A run's: a handler or logic that throws or stops on an unknown value, on a screen or on the
  system. Each counts every time it comes, and tells the person at the screen too.
- The HMI's own: an error nothing caught, a promise nothing heard reject, an error or warning
  on the console, in the page or its data worker, and a part of the editor that broke, which
  shows what broke with a way to draw it again. These are bugs in the HMI, with their stack.

The editor's status bar counts the faults and warnings, and opens the list. A row on an element
opens it in Design, a row with a stack shows it, and the eraser clears those that passed from
this list only. The operator's screen shows none of it, but sends its own.

An agent reads the same list three ways:

- `GET /problems` gives every problem as JSON, each with `screen` (null for the system),
  `source`, `level`, `text`, `detail` (the stack), `page`, `element`, `count` and `at`, in ms
  since 1970.
- The log names each new one a screen finds, with its stack, as `screen 3 found a page's problem
  on main e4: width: Speedd names no mesh import, variable or record`.
- `Hmi/Problems` on the mesh ([status.md](status.md#hmiproblems)).
