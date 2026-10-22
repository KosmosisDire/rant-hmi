# Reference

Every element, property, event and name a project can use, in one place.
[files.md](files.md) shows the files and how each part behaves, and [math.md](math.md) the
math. The backend's tests write the event and name tables from the code, so they never fall
behind it.

One unit is 10 px. Every value an element takes but `id` and `name` is an expression, so text
goes in quotes: `text='"Start"'`.

## Lay out with frames

Put parts in a frame that lays them out, rather than placing each by `x` and `y`. A frame
with `layout` sets what it holds in a row or a column, so the parts keep their spacing when a
text grows, an item comes or the screen is narrower. Keep `x` and `y` for what sits on its
own, as a marker over a picture.

```html
<div id="e1" name="Header" x="0" y="0" w="fill" h="hug" style='layout: "right"; align: "center left"; gap: 1; padding: 1; background: $panel'>
  <span id="e2" name="Title" w="hug" h="hug">"Packing line"</span>
  <div id="e3" name="Space" w="fill" h="1"/>
  <Button id="e4" name="Start" w="12" h="4" text='"Start"'/>
  <Button id="e5" name="Stop" w="12" h="4" text='"Stop"'/>
</div>
```

- `w="fill"` along the flow takes the room left, shared by every part that fills. Across the
  flow, a part that fills stretches to the frame.
- `h="hug"` makes the frame as tall as what it holds.
- A list is a frame holding one part with `repeat`.

## Pages and components

| Attribute | Of | Takes |
| --- | --- | --- |
| `name` | both | its name, as `Pages` and an instance's tag read it |
| `size` | both | its size in units, as `128x72`, the size when left out |
| `fill` | a page | its ground, an expression, `$ground` when left out |
| `shows` | a page | `full`, or `over` to open over the page under it, as a dialog does |
| `sizing` | a component | `scale` to draw it whole in each instance's box, or `fill` to lay it out there |

A component's interface comes first in its file:

| Tag | Attributes | Is |
| --- | --- | --- |
| `<prop>` | `name`, `default`, `bindable="true"` | an input each instance sets as an attribute. A bindable one writes back to the name the instance gives it |
| `<event>` | `name` | an event its code sends with `emit`, heard on the instance by `<on event>` |
| `<var>` | `name`, `start` | each instance's own state on each screen |

## Elements

| Tag | Is |
| --- | --- |
| `div` | a frame: a box that holds parts and may lay them out |
| `span` | a text |
| `input` | a field to type in |
| `media` | a camera, a video or a picture |
| `svg` | a diagram of shapes, drawn in its own units |
| `markup` | SVG that code gives as text |
| `canvas` | what its code draws, in 2D or with WebGL |
| `scene` | a 3D view of parts |
| `group` | parts picked and moved as one, with no box of its own |
| a component's name, as `<Gauge>` | an instance of that component |
| `path` `circle` `ellipse` `rect` `line` `polyline` `polygon` `text` `g` | shapes, in a diagram only |
| `anchor` `axes` `box` `sphere` `cylinder` `points` `grid` `arrow` `model` | 3D parts, in a scene only |

A frame, a group, a diagram, a `g`, a scene and an `anchor` hold parts. Any element but a 3D
part holds handlers, each an `<on event="...">` ([Events](#events)).

## Properties

Each element has an `id` of its own in its file. `name`, `repeat`, `x`, `y`, `w`, `h`,
`origin` and a tag's own below are attributes. The rest go in `style`, as
`style='layout: "down"; gap: 1'`. A group takes only `name`.

### Every element

| Property | Takes |
| --- | --- |
| `name` | its name. A component's code reads a part by it |
| `repeat` | a number or a list, to draw a copy per item, each reading `index` and `item` |
| `x`, `y` | where its origin sits, from the origin of what holds it: units, or a percent of the holder, as `50%` or `level * 100%` |
| `w`, `h` | its size: units, a percent, `hug` to fit what it holds, or `fill` for the room its frame leaves it, else the whole holder |
| `origin` | the point of its own box that `x` and `y` place and it turns about: two lengths, each units or a percent of its box, as `'"50% 50%"'`. Its top left corner when left out |

### Frames

| Property | Takes |
| --- | --- |
| `layout` | `"right"`, `"down"`, `"left"` or `"up"`, to set what it holds one after another that way. Their `x` and `y` then go unused |
| `align` | where they sit, one of nine points such as `"top left"`, `"center left"` or `"center"`. Top left when left out |
| `gap` | the units between them, or `"auto"` to spread them over its length |
| `wrap` | `true` to go on in a new row or column where one is full |
| `stack` | `"first"` to put the first part on top where parts overlap |

In a frame with a layout, a part with `position: "absolute"` keeps the place its `x` and `y`
give.

### Texts, fields, pictures and diagrams

| Property | Of | Takes |
| --- | --- | --- |
| `text` | `span`, the shape `text` | its words, written as the tag's body: `<span ...>Speed.toFixed(1) + " m/s"</span>` |
| `value` | `input` | what it shows. A name there, as `value="Speed"`, is set to what is typed: a number while it holds one, true or false while it holds those |
| `src` | `media` | an import's name to show its video or pictures, or an expression giving a picture or a URL |
| `fit` | `media`, `svg` | how it fits its box: `"meet"` whole, the default, `"slice"` filling it cut to size, or `"stretch"` |
| `viewbox` | `svg` | the box its shapes draw in, `"x y width height"`. Left out, they draw in units from its corner |
| `markup` | `markup` | SVG as text, or a list of texts, written as the tag's body |
| `context` | `canvas` | `"2d"`, the default, or `"webgl2"` |
| `draw` | `canvas` | the code that draws on it, written as the tag's body |

### Canvas

```html
<canvas id="e1" name="Level" x="2" y="2" w="4" h="16">
  ctx.fillStyle = $accent;
  ctx.fillRect(0, height * (1 - Level), width, height * Level);
</canvas>
```

- Draw code reads what an expression reads, and `ctx` with `"2d"` or `gl` with `"webgl2"`,
  `width` and `height` in units, and `keep`, an object kept between draws for what the code
  makes once: `keep.points ??= gl.createBuffer()`.
- In 2D one unit is one and each draw starts clear. With WebGL the viewport is the whole
  canvas, and the code clears it.
- It draws again when its box or anything the code read changes, at most once a frame, and
  every frame while it reads `time.now`.
- It only reads: setting a name there throws.

### Scenes

```html
<scene id="e1" name="Cell" x="2" y="2" w="40" h="30" yaw="-2" style="background: $panel">
  <grid id="e2" name="Floor"/>
  <anchor id="e3" name="Arm" pose="Arm">
    <box id="e4" name="Link" pose="{ position: vec(0.5, 0, 0) }" size="vec(1, 0.1, 0.1)"/>
  </anchor>
</scene>
```

A scene draws its parts with three.js, in metres with z up, lit from above and from the
camera. Its CSS `background` shows behind them. Each part's every property is an attribute,
each an expression.

| Property | Of | Takes |
| --- | --- | --- |
| `target` | `scene` | the point its camera looks at and orbits, `vec(0, 0, 0)` when left out |
| `yaw` | `scene` | how far round from x the camera is, in radians, `-2` when left out |
| `pitch` | `scene` | how far up the camera is, in radians, `0.5` when left out |
| `distance` | `scene` | how far the camera is from `target`, `5` when left out |
| `pose` | every part | where it sits and how it turns from what holds it: a Pose, as `Arm` for a Pose import, or `{ position: vec(0, 0, 1) }`, each half optional |
| `size` | `box` | its edges, a vector, `vec(1, 1, 1)` |
| `size` | `axes` | how long its arrows are, `1` |
| `size` | `points` | how wide each dot is, `0.05` |
| `size` | `grid` | how wide it is, `10` |
| `radius` | `sphere`, `cylinder` | `0.5` |
| `length` | `cylinder` | along its z, `1` |
| `points` | `points` | a list of vectors, as a Double3 list from the mesh |
| `joined` | `points` | `true` to draw one line through them instead of dots |
| `step` | `grid` | the gap between its lines, `1` |
| `vector` | `arrow` | where it points from its pose, as long as it is, `vec(1, 0, 0)` |
| `src` | `model` | the URL of a glTF file, `.glb` or `.gltf` |
| `joints` | `model` | its named nodes moved from where the file puts them: `{ Elbow: 0.5 }` turns one by radians about its own z, `{ Slide: { position: vec(0, 0, 0.2) } }` moves one by a pose |
| `color` | every part but `anchor`, `axes` and `model` | any colour a page takes, `$accent`, or `$border` for a grid |
| `opacity` | `box`, `sphere`, `cylinder` | `1` |

- An `anchor` draws nothing. It places what it holds by its pose, as a frame of a TF tree.
- `axes` shows x, y and z in red, green and blue. A `grid` lies on its xy plane, centred on
  its pose.
- A box, a sphere and a cylinder sit centred on their pose.
- A model file loads once however many parts show it, and draws in its own materials.
- A value that cannot be read gives way to the default, and the editor says why on the
  scene. A part whose values are not known yet draws nothing.
- The camera moves only by its properties, so a person turns it through handlers on the
  scene: `turn = turn - p.dx * 4` on drag, with `yaw="turn"` and `turn` a screen variable.

### Shapes

Every property of a shape but `name` is an SVG attribute, each an expression: `cx`, `r`,
`fill`, `stroke`, `d`, `points` and the rest, in small letters, as `pathlength`.

- `rotate` turns it by degrees about its `origin`, a point of its own box, its centre when
  left out.
- A `g` moves what it holds as one, by its `transform`.

### Instances

An instance's inputs are attributes, as `<Gauge id="e3" value="Speed * 10"/>`, and the rest
is CSS on its box. An input left out takes its default. `w="hug"` and `h="hug"` take the
component's own size.

### Style

Any CSS property goes in `style`, each value an expression:
`background: Running ? $green : $panel`.

- A bare number is units for a length: sizes, padding, margin, gap, borders and their radius,
  font size, letter spacing and outlines. It is degrees for `rotate`, and as it is for the
  rest, as `opacity: 0.5`.
- CSS text is taken as written: `box-shadow: "0 2px 8px #0008"`. Bare numbers in it that the
  browser would refuse read as units: `"0 0.2 0.8 #0008"`.
- `transition` runs on screens only, so the editor follows a drag at once.

## Events

An element hears an event through an `<on event="...">` holding its code, which reads what
the event brings as `p`.

- A setting is an attribute of the `<on>`, shown here with its default. Each is an
  expression.
- A filter takes only the events that bring its value, as `key="a"`, and any when left out.
  An element holds one handler per event and filter.
- An event that comes while its handler still runs is dropped, but a stream's next one waits
  for the run, gathering what comes meanwhile. A stream that ends at rest comes once more with
  every number it brings 0.

<!-- events: written by the backend's tests from server/src/events.rs -->

### Pointer

| Event | When | Settings | `p` holds |
| --- | --- | --- | --- |
| `tap` | Pressed and let go on it. | `while="true"` | `x` across it, 0 to 1<br>`y` down it, 0 to 1<br>`angle` degrees around its centre, 0 up<br>`on` the part pressed, by name<br>`inside` true while over it |
| `press` | Pressed down. Ended by `release`. | `while="true"` | as `tap` |
| `release` | Let go, anywhere. | none | as `tap` |
| `hold` | Held down a while. | `after="500"`<br>`while="true"` | as `tap` |
| `repeat` | Again and again while pressed. | `every="100"`<br>`while="true"` | as `tap` |
| `drag` | Moved while pressed. A stream, summing `dx` and `dy`. | `while="true"` | `x` across it, 0 to 1<br>`y` down it, 0 to 1<br>`angle` degrees around its centre, 0 up<br>`on` the part pressed, by name<br>`inside` true while over it<br>`dx` how far it moved across since the last, as its own x counts<br>`dy` how far it moved down since the last, as its own y counts |
| `outside` | A press anywhere else. | `while="true"` | as `tap` |

### Wheel and pinch

| Event | When | Settings | `p` holds |
| --- | --- | --- | --- |
| `scroll` | Scrolled over it. A stream, summing `dx` and `dy`. | `while="true"` | `x` across it, 0 to 1<br>`y` down it, 0 to 1<br>`on` the part under it, by name<br>`dx` how far across, as its own x counts<br>`dy` how far down, as its own y counts, below 0 as a wheel turns down |
| `zoom` | Pinched or zoomed over it. A stream, multiplying `factor`. | `while="true"` | `x` across it, 0 to 1<br>`y` down it, 0 to 1<br>`on` the part under it, by name<br>`factor` how much bigger, below 1 smaller |

### Entry

| Event | When | Settings | `p` holds |
| --- | --- | --- | --- |
| `change` | A value entered. A stream. | `while="true"` | `value` what was entered |

### Keyboard

| Event | When | Settings | `p` holds |
| --- | --- | --- | --- |
| `keydown` | A key pressed. Ended by `keyup`. | `key` filter<br>`code` filter<br>`while="true"` | `key` what it types, as "a" or "Enter"<br>`code` where it sits, as "KeyA"<br>`shift` true while Shift is down<br>`ctrl` true while Ctrl is down<br>`alt` true while Alt is down |
| `keyup` | A key let go. | `key` filter<br>`code` filter | as `keydown` |
| `keyrepeat` | Again and again while a key is down. | `key` filter<br>`code` filter<br>`every="100"`<br>`while="true"` | as `keydown` |

### Gamepad

| Event | When | Settings | `p` holds |
| --- | --- | --- | --- |
| `buttondown` | A gamepad button pressed. Ended by `buttonup`. | `button` filter<br>`pad` filter<br>`while="true"` | `button` which, by where it sits, as "south"<br>`pad` which pad, 0 for the first |
| `buttonup` | A gamepad button let go. | `button` filter<br>`pad` filter | as `buttondown` |
| `axes` | A gamepad's sticks or triggers moved. Ends at rest. A stream. | `pad` filter<br>`deadband="0.1"`<br>`while="true"` | `lx` the left stick across, -1 to 1<br>`ly` the left stick up, -1 to 1<br>`rx` the right stick across, -1 to 1<br>`ry` the right stick up, -1 to 1<br>`lt` the left trigger, 0 to 1<br>`rt` the right trigger, 0 to 1<br>`axes` every axis as the pad gives it, down positive<br>`pad` which pad, 0 for the first |

A component's own events, which its code sends with `emit`, take `while="true"`.

### The `button` filter

| Value | Is |
| --- | --- |
| `south` | A, Cross |
| `east` | B, Circle |
| `west` | X, Square |
| `north` | Y, Triangle |
| `lb` | left bumper, L1 |
| `rb` | right bumper, R1 |
| `lt` | left trigger, L2 |
| `rt` | right trigger, R2 |
| `back` | Back, Share |
| `start` | Start, Options |
| `ls` | left stick pressed |
| `rs` | right stick pressed |
| `up` | pad up |
| `down` | pad down |
| `left` | pad left |
| `right` | pad right |
| `home` | Guide, PS |

### The `pad` filter

| Value | Is |
| --- | --- |
| `0` | the first |
| `1` | the second |
| `2` | the third |
| `3` | the fourth |

<!-- end events -->

## Code

Code reads the project's names:

- each import by its alias. A topic sends with `Alias.send(...)`, and a function is called
  as `await Alias(...)`.
- each variable, computed value and record by its name, a record as a list of `{ t, v }`,
  oldest first.
- a mesh enum by its type's name, its `options` the names it takes.
- a theme token as `$name`.

A handler reads `p`, and what a repeat draws reads `index` and `item`. A component's code
reads its inputs and `<var>` by name, and each part's `pressed`, `hovered` and `heldFor` in ms
by the part's name, `root` for the whole. A handler sets a name by assignment:
`Speed = 0.5`, `jog[index] = 1`.

<!-- names: written by the backend's tests from client/src/lang/api.js -->

| Name | What | Read in |
| --- | --- | --- |
| `sqrt(x)` | square root | everywhere |
| `abs(x)` | without its sign | everywhere |
| `sign(x)` | -1, 0 or 1 | everywhere |
| `min(...values)` | the least | everywhere |
| `max(...values)` | the most | everywhere |
| `clamp(x, low, high)` | x kept between low and high | everywhere |
| `lerp(a, b, t)` | from a toward b by t, numbers or vectors | everywhere |
| `round(x)` | the nearest whole number | everywhere |
| `floor(x)` | the whole number at or below | everywhere |
| `ceil(x)` | the whole number at or above | everywhere |
| `trunc(x)` | the whole part | everywhere |
| `pow(x, y)` | x to the power y | everywhere |
| `exp(x)` | e to the power x | everywhere |
| `ln(x)` | natural log | everywhere |
| `sin(radians)` | sine | everywhere |
| `cos(radians)` | cosine | everywhere |
| `tan(radians)` | tangent | everywhere |
| `asin(x)` | in radians | everywhere |
| `acos(x)` | in radians | everywhere |
| `atan(x)` | in radians | everywhere |
| `atan2(y, x)` | the angle of y and x, in radians | everywhere |
| `hypot(...values)` | the length of its arguments | everywhere |
| `degrees(radians)` | radians as degrees | everywhere |
| `radians(degrees)` | degrees as radians | everywhere |
| `PI` | half a turn, in radians | everywhere |
| `vec(x, y, z?)` | a 2D or 3D vector | everywhere |
| `fromEuler(roll, pitch, yaw)` | a quaternion from roll, pitch and yaw in radians | everywhere |
| `mix(a, b, t)` | a colour from a toward b by t | everywhere |
| `time` | the clock | everywhere |
| `time.now` | ms since 1970, moving where it shows | everywhere |
| `notify(text)` | tell this screen | a page's handlers |
| `log(...values)` | write to the log | a page's handlers |
| `sleep(ms)` | wait ms | a page's handlers |
| `open(page, options?)` | open a page, its answer when it closes | a page's handlers |
| `close(answer?)` | close the top page | a page's handlers |
| `Pages` | each page by name, to open | a page's handlers |
| `emit(event, value?)` | send an event out | a component's handlers |
| `link` | this screen's link to the system | what a screen draws and a component's handlers |
| `link.open` | true while the screen reaches the system | what a screen draws and a component's handlers |
| `link.webrtc` | true while its WebRTC connection is open too | what a screen draws and a component's handlers |
| `link.pingMs` | the round trip in ms, smoothed, null before one | what a screen draws and a component's handlers |
| `keys` | the keys held, each true by what it types or where it sits, as keys.a or keys.KeyA | what a screen draws and a component's handlers |
| `gamepads` | the gamepads, gamepads[0] the first, null where none is | what a screen draws and a component's handlers |

JavaScript's own, read everywhere:

| Name | What |
| --- | --- |
| `Math` | JavaScript's math |
| `Number(value)` | as a number |
| `String(value)` | as text |
| `Boolean(value)` | as true or false |
| `Array` | lists |
| `Object` | fields of a value |
| `JSON` | values as JSON text |
| `Date` | dates and times |
| `parseFloat(text)` | the number text starts with |
| `parseInt(text, radix?)` | the whole number text starts with |
| `isNaN(value)` | true when not a number |
| `isFinite(value)` | true for a finite number |

<!-- end names -->

## Data files

`hmi.toml`:

| Key | Takes |
| --- | --- |
| `name` | the project's name |
| `start` | the page screens open on, else the first |
| `[[ice]]` | a STUN or TURN server: `urls`, and a TURN server's `username` and `credential`. Two public STUN servers when left out, `ice = []` for none |

Each `[[import]]` in `data/imports.toml`:

| Key | Takes |
| --- | --- |
| `alias` | the name code reads it by |
| `entity` | its path on the mesh, as `Line1/Speed` |
| `kind` | `topic`, `variable`, `function` or `task` |
| `intent` | `read`, or `write` to set, send or call it. A function or a task is always `write` |

Each `[[variable]]` in `data/variables.toml`:

| Key | Takes |
| --- | --- |
| `name` | its name, in camelCase |
| `start` | the value it starts from |
| `per` | `hmi` for one every screen shares, or `screen` for one per screen |

Each `[[computed]]` in `data/computed.toml`:

| Key | Takes |
| --- | --- |
| `name` | its name, in camelCase |
| `get` | an expression over imports, variables and other computed values |
| `set` | `{ target, value }`: a write to it sets `target` to `value`, an expression of the new value `v` |
| `unit` | what the editor shows after its value, as `%` |
| `note` | what it means, for the editor |

Each `[[record]]` in `data/records.toml`:

| Key | Takes |
| --- | --- |
| `name` | its name, in camelCase |
| `source` | an expression over imports and variables, sampled |
| `every_ms` | how often it is sampled |
| `keep_s` | how long each sample is kept, in seconds |

Each `[[token]]` in `data/theme.toml`:

| Key | Takes |
| --- | --- |
| `name` | its name, read as `$name` |
| `dark` | its value in dark mode, an expression over other tokens and the math: a colour, a number or a text |
| `light` | its value in light mode. Left out, the dark one is read in light mode, its tokens light |

## Logic

`logic/handlers.html` holds the HMI's own handlers, run on the system. Each is an
`<on id="..." name="...">` with one of:

| Attribute | Runs its code | `p` holds |
| --- | --- | --- |
| `every="ms"` | every so many ms | nothing |
| `when="condition"` | as the condition turns true, or with `for="ms"` once it has held that long | nothing |
| `change="name"` | when an import or a variable changes | `value` and `previous` |
| `start=""` | once, as the HMI starts | nothing |
| `screen="connects"` | when a screen connects | `screen`, its number |
| `screen="leaves"` | when a screen is lost | `screen` |

The HMI's own status is on the mesh too: [status.md](status.md).
