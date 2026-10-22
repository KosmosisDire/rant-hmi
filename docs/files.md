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
publishes on a topic with `Jog.send({ x: 1, y: 0 })`.

## WebRTC

A screen opens a WebRTC connection beside its socket where it can, for speed and video.

- A new project starts with two public STUN servers in `ice`. `ice = []` asks none.
- The HMI offers every address of its host, and the address its NAT shows the outside, as
  the STUN servers tell. `rtc_ports=6740-6759` on `rant run Hmi` pins its ports, to open them
  in a firewall or forward them.
- A TURN server relays for a screen that reaches the HMI no other way.
- Without WebRTC a screen decodes video itself from frames on its socket, which only a page
  on https or localhost can do. Elsewhere the video says why it does not play.

## https

The HMI serves https on its port beside http. A screen away from the HMI's host needs it for
gamepads and to decode video itself.

- The HMI makes its own certificate once and keeps it in `~/.rant/hmi` for every project on
  the host. A browser warns about it until told to trust it.
- `--cert` and `--key` take a real certificate and its key, as PEM files.

## In a window

`rant-hmi-app` shows an HMI's operator screen in a window of its own. Built from source for
now, on Windows:

```
cargo run --manifest-path app/Cargo.toml -- path/to/my-hmi --loopback
cargo run --manifest-path app/Cargo.toml -- http://host:6739
```

- Given a folder it runs that project in the same process as its screen, with no network
  between them. It listens on no port, so no other screen and no editor reach it.
- Given an address it shows that HMI's screen, as a browser would.
- The window is the system's own webview, WebView2 on Windows 10 and 11. It keeps its data in
  `~/.rant/hmi/webview`.

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
  that heard them turning false, or the screen lost. Then `p.lost` is true, as on a release a
  lost screen leaves.
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
