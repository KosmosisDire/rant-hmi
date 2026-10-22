# Project files

An HMI project is a folder of plain text files. The editor writes them and so may you: a saved
change reaches every screen, and a file with a mistake leaves the last good one in place.

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
- `keydown`, `keyup` and `keyrepeat` hear the keyboard while the element shows on the top page
  and no field is typed in. `key="a"` takes the key that types a, "A" with Shift and " " for
  Space, and `code="KeyA"` the key where a sits. With neither it takes any key. `p` holds
  `key`, `code`, `shift`, `ctrl` and `alt`, and a keyrepeat runs `every="ms"`, 100.
- An element holds one handler per event and key. A key a handler names does nothing else on
  the screen, so Space never presses a button.
- Any handler but an end, a release or a keyup, takes `while="condition"`, and hears its event
  only while the condition is true. An end always runs.
- A key held ends with its keyup however it ends: let go, the window losing focus, the page
  closed or covered, its keydown's while turning false, or the screen lost. Then `p.lost` is
  true, as on a release a lost screen leaves.
- `repeat="6"` or `repeat="Jobs"` draws an element once per item, reading `index` and `item`.
- `<svg>` holds shapes, `<markup>` SVG made by code, `<media src="Camera"/>` a camera or a
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
