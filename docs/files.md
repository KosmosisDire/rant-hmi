# Project files

An HMI project is a folder of plain text files. The designer writes them, and they read well
in a diff. A file changed by an editor or an AI reaches every screen at once, and one with a
mistake leaves the last good version in place.

```
hmi.toml
data/imports.toml
data/variables.toml
data/records.toml
data/computed.toml
data/theme.toml
pages/<id>.html
components/<id>.html
logic/handlers.html
```

## hmi.toml

```toml
name = "Demo line"
start = "overview"
```

- `start` is the page operators' screens open on. Without it they open on the first page.

## data

```toml
# imports.toml: what pages and handlers may read, each under its alias
[[import]]
alias = "Speed"
entity = "Line1/Speed"
kind = "variable"
intent = "write"

# variables.toml: the HMI's own state
[[variable]]
name = "mode"
start = "Auto"
per = "hmi"

# records.toml: a value's history, which pages read as a list of { t, v }
[[record]]
name = "speedHistory"
source = "Speed"
every_ms = 100
keep_s = 600

# computed.toml: values worked out from others, as a property is, and written back through
# a setter when they have one
[[computed]]
name = "speedPercent"
get = "Speed * 100"
unit = "%"
set = { target = "Speed", value = "v / 100" }

# theme.toml: design values code reads as $name
[[token]]
name = "accent"
dark = "#ff8800"
light = "#0088ff"
```

- `kind` is `topic`, `variable`, `function` or `task`. `intent` is `read` or `write`, and a
  function or a task, which is only ever called, is always `write`.
- A topic imported to write sends with `Jog.send(...)`, and a function is called with
  `await Reset(...)`. Either takes one value of its type, or the type's fields in order:
  `Jog.send({ x: 1, y: 0 })` or `Jog.send(1, 0)`. A function with an untyped request, as
  many devices' commands are, takes nothing: `await Home()`.
- `per` is `hmi` for one value every screen shares, `screen` for one per screen.
- A record samples `source`, an expression, every `every_ms` (50 or more) and keeps each
  sample `keep_s` seconds, in memory, whether or not a screen watches.
- A computed value's `get` reads imports, variables and other computed values, and never
  writes, calls or waits. It is worked out on the system as they change. A write of `v` to
  one with a `set` gives its `target`, a variable imported to write, an HMI variable or
  another computed value with a setter, the `value` expression. One that reads itself is
  refused.

## Pages and components

A page is written as the HTML it draws as. A frame is a `div`, a text a `span`, and a
component placed on a page is a tag named after it.

```html
<page name="Overview" size="1408x792">
  <div id="e1" name="Speed card" x="44" y="44" w="264" h="132" style="background: #1e2125">
    <on event="tap">
      Speed = Speed + 0.1;
    </on>
    <span id="e2" x="22" y="22" w="220" h="44" style="font-size: 32">Speed.toFixed(2)</span>
  </div>
  <Meter id="e3" x="352" y="44" w="264" h="176" level="Speed * 10"/>
</page>
```

- `name`, `x`, `y`, `w`, `h` and `origin` are attributes. A span's text is its body. Every
  other property goes in `style`.
- `x`, `y`, `w` and `h` are pixels, or with a trailing `%` a share of what holds the element:
  its width for `x` and `w`, its height for `y` and `h`. `w="50%"`, `x="(Speed * 10)%"`.
- `w` and `h` may also be `hug`, the size of what the element holds or shows, or `fill`, the
  room its frame's layout leaves it.
- `layout` on a frame lays out what it holds one after another, `"right"`, `"down"`, `"left"`
  or `"up"`, and their `x` and `y` wait. `gap` is the space between them, `"auto"` spreading
  them over the frame's length, `padding` insets them, `wrap: true` wraps them, and `align`
  is where they sit, as `"top left"`, `"center"` or `"bottom right"`:
  `style='layout: "down"; gap: 10; padding: 10; align: "center"'`.
- `origin` is a point of the element's box, a pair of percents of it or pixels such as
  `origin='"50% 100%"'`, the top left when unset. `x` and `y` place it, counted from the
  origin of what holds the element, and the element turns about it. A shape's origin is a
  point of its own outline's box, only what it turns about, and its middle when unset.
- `rotate`, in degrees clockwise, is CSS on every element, shapes too: `rotate: Speed * 90`.
- Every value but the name is an expression, kept raw: text goes in quotes, and `a < b`
  needs no escaping. Expressions and code share the math in [math.md](math.md).
- `<on>` holds a handler's code, first inside its element. A `hold` handler runs once a
  press lasts `after` ms, an expression, 500 when left out: `<on event="hold" after="600">`.
  A `repeat` handler runs at the press, then every `every` ms while it lasts, 100 when left
  out and 50 at the quickest: `<on event="repeat" every="200">`.
- A handler reads what its event brings as `p`. A pointer event brings `x` and `y` across
  the element from 0 to 1, `angle` around its centre, `on` the part pressed and `inside`. An
  instance's own event brings what its component passes to `emit`.
- `repeat` draws an element once per item of a list, or a number of times:
  `<div repeat="6" x="44 + index * 132">`. It and all inside it read `index`, from 0, and
  `item`, and so do their handlers.
- `<group>` keeps elements together, which the editor picks and moves as one. It has no box,
  origin or place of its own, so what it holds sits as it would without it.
- `<svg>` is a drawing, placed like a frame. It holds shapes (`path`, `circle`, `ellipse`,
  `rect`, `line`, `polyline`, `polygon`, `text`, and `g` to group them), drawn in its
  `viewbox` units, by default its size in pixels. `fit` is `"meet"`, `"slice"` or
  `"stretch"`. Every property of a shape is an SVG attribute holding an expression:
  `<line x1="88" y1="88" x2="88" y2="22" transform="`rotate(${Speed * 90} 88 88)`"/>`.
- `<markup>` is an SVG made by code: its body is an expression giving SVG markup as text, or
  a list of it, redrawn as what it reads changes. Markup with an `<svg>` root fills the box
  as that SVG does, so a file pastes in as it is. Other markup draws in pixels. Script, styles
  and `on` attributes in the markup are taken out.
  ```html
  <markup id="e5" x="44" y="44" w="176" h="176">
    `<svg viewBox="0 0 100 100">
      ${Array.from({ length: 12 }, (_, i) =>
        `<line x1="50" y1="4" x2="50" y2="12" stroke="#9aa0a6" transform="rotate(${i * 30} 50 50)"/>`).join("")}
    </svg>`
  </markup>
  ```
- `<media src="Camera" fit='"meet"'/>` shows a camera, a picture or a URL in quotes. `src`
  names a mesh import, bare or as text from an expression. An import with H264, its own or
  the `Video` child rant-transcoder makes on the camera's host, plays over WebRTC. Any other
  shows its pictures as they come: a Rant Image, or MJPEG frames. `fit` is `"meet"`,
  `"slice"` or `"stretch"`, as a drawing's is, so a drawing over it with
  ``viewbox="`0 0 ${Camera.width} ${Camera.height}`"`` and the same fit draws in the
  picture's pixels.
- `<input value="Speed"/>` is a field an operator types into. A bare name as its value takes
  the entry, and its `change` handler reads it as `p.value`.
- `shows="over"` on a page opens it over the page beneath, as a dialog.
- `fill` is a page's ground, an expression too, so `fill="$ground"` follows light and dark.

A component has the same body, with its inputs, the events it sends and its own variables
first.

```html
<component name="Meter" size="264x176">
  <prop name="level" default="0" bindable="true"/>
  <event name="change"/>
  <var name="peak" start="0"/>
  <span id="e1" x="11" y="11" w="242" h="44">level + "%"</span>
</component>
```

- `sizing="fill"` lays the component out in the box each instance is placed at, so what it
  places in percents stretches with it. Without it an instance scales the component whole to
  fit its box, keeping its shape.
- `bindable` lets the component write the input back to what the instance binds it to.
- Each instance keeps its own `<var>` on each screen, from `start`. Its code reads and sets
  it by name.
- Its code reads a part's pointer state by the part's name, `root` for the whole:
  `knob.pressed`, `root.hovered`, `root.heldFor` in ms.

## logic/handlers.html

The HMI's own handlers, which belong to no element.

```html
<logic>
  <on id="h1" name="Count" every="1000">
    ticks = ticks + 1;
  </on>
  <on id="h2" name="Too fast" when="Speed > 1.5" for="2000">
    notify("The line runs too fast");
  </on>
  <on id="h3" name="Follow" change="Running">
    lastRunning = p.value;
  </on>
</logic>
```

- One of `every="ms"`, `when="condition"` with an optional `for="ms"`, `change="name"`,
  `start=""`, `screen="connects"` or `screen="leaves"` says when a handler runs.
