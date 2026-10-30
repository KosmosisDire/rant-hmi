# Pages

A page is a file of the elements it draws. This page lists every element and property.
[Events](events.md) lists what handlers hear, and [Code](code.md) what values read.

```html
<page name="Overview" size="128x72">
  <div id="e1" name="Card" x="4" y="4" w="24" h="hug" style='layout: "down"; gap: 1; padding: 1; background: $panel'>
    <span id="e2" name="Title" w="hug" h="hug">"Line 1"</span>
    <span id="e3" name="Reading" w="hug" h="hug">Line.Speed.toFixed(2) + " m/s"</span>
  </div>
  <Gauge id="e4" name="Dial" x="32" y="4" w="16" h="16" value="Line.Speed"/>
</page>
```

- Each element has an `id` of its own in its file.
- Every value but `id` and `name` is an expression, so text goes in quotes: `text='"Start"'`.
  A value holding double quotes goes in single quotes.
- Lengths are units of 10 px.
- `name`, `repeat`, `x`, `y`, `w`, `h`, `origin` and the properties of a tag's own are
  attributes. The rest go in `style`, as `style='layout: "down"; gap: 1'`.

## Page

| Attribute | Takes |
| --- | --- |
| `name` | its name, as `Pages.Overview` reads it |
| `size` | its size in units, `128x72` when left out |
| `fill` | its background, `$ground` when left out |
| `shows` | `full`, or `over` to open over the page beneath, as a dialog. A handler opens it with `await open(Pages.Confirm)` |

## Elements

| Tag | Is |
| --- | --- |
| `div` | a frame: a box that holds parts and may lay them out |
| `span` | text |
| `input` | a field to type in |
| `media` | a camera, a video or a picture |
| `svg` | a diagram of shapes, drawn in its own units |
| `markup` | SVG that code gives as text |
| `canvas` | what its code draws, in 2D or with WebGL |
| `scene` | a 3D view of parts |
| `group` | parts picked and moved as one, with no box of its own |
| a component's name, as `<Gauge>` | an instance of that component ([Components](components.md#placing-one)) |
| `path` `circle` `ellipse` `rect` `line` `polyline` `polygon` `text` `g` | shapes, in a diagram only |
| `anchor` `axes` `box` `sphere` `cylinder` `points` `mesh` `grid` `floor` `arrow` `model` | 3D parts, in a scene only |

- A frame, a group, a diagram, a `g`, a scene and an `anchor` hold parts.
- Any element but a 3D part may hold handlers, each an `<on event="...">`
  ([Events](events.md)), and [state](#state).

## Every element

| Property | Takes |
| --- | --- |
| `name` | its name. A component's code reads a part by it |
| `x`, `y` | where its origin sits in what holds it: units, or a percent of the holder, as `50%` or `level * 100%` |
| `w`, `h` | its size: units, a percent, `hug` to fit what it holds, or `fill` for the room its frame leaves it |
| `origin` | the point of its own box that `x` and `y` place and it turns about, as `'"50% 50%"'`. Its top left corner when left out |
| `repeat` | a number or a list, to draw a copy per item ([Repeat](#repeat)) |
| `enabled` | `false` to take no events, in it and all it holds, and to draw it dimmed |

## Layout

A frame with `layout` sets what it holds in a row or a column.

```html
<div id="e1" name="Header" x="0" y="0" w="fill" h="hug" style='layout: "right"; align: "center left"; gap: 1; padding: 1'>
  <span id="e2" name="Title" w="hug" h="hug">"Packing line"</span>
  <div id="e3" name="Space" w="fill" h="1"/>
  <Button id="e4" name="Start" w="12" h="4" text='"Start"'/>
  <Button id="e5" name="Stop" w="12" h="4" text='"Stop"'/>
</div>
```

| Property | Takes |
| --- | --- |
| `layout` | `"right"`, `"down"`, `"left"` or `"up"`: the way its parts follow one another |
| `align` | where the parts sit, one of nine points, as `"top left"`, `"center left"` or `"center"`. Top left when left out |
| `gap` | the units between the parts, or `"auto"` to spread them over its length |
| `wrap` | `true` to go on in a new row or column when one is full |
| `stack` | `"first"` to put the first part on top where parts overlap |
| `padding` | the units between its edge and its parts |
| `overflow`, `overflow-x`, `overflow-y` | `"auto"` or `"scroll"` to scroll what spills past it, by wheel and by finger |

- A part with `position: "absolute"` keeps the place its `x` and `y` give.
- A list is a frame holding one part with [repeat](#repeat).
- The phone button under the editor's page shows the page as a phone held upright lays it out.

## Text, fields and media

| Property | Of | Takes |
| --- | --- | --- |
| `text` | `span`, the shape `text` | its words, written as the tag's body: `<span ...>Speed.toFixed(1) + " m/s"</span>` |
| `align` | `span`, `input` | where its lines sit in its box, one of the nine points a frame's `align` takes. An input takes `"left"`, `"center"` or `"right"` |
| `value` | `input` | what it shows. A name there, as `value="target"`, is set to what is typed |
| `src` | `media` | a camera or picture member, as `Cell.Camera`, any expression giving one, or text as a URL |
| `fit` | `media`, `svg` | `"meet"` to show it whole, the default, `"slice"` to fill the box cut to size, or `"stretch"` |
| `viewbox` | `svg` | the box its shapes draw in, `"x y width height"`. Left out, they draw in units from its corner |
| `markup` | `markup` | SVG as text, or a list of texts, written as the tag's body |

## Shapes

Every property of a shape but `name`, `repeat` and `enabled` is an SVG attribute in small
letters, each an expression: `cx`, `r`, `fill`, `stroke`, `d`, `points`, `pathlength`.

- `rotate` turns it by degrees about its `origin`, its centre when left out.
- A `g` moves what it holds as one, by its `transform`.

## Canvas

```html
<canvas id="e1" name="Level" x="2" y="2" w="4" h="16">
  ctx.fillStyle = $accent;
  ctx.fillRect(0, height * (1 - Tank.Level), width, height * Tank.Level);
</canvas>
```

| Property | Takes |
| --- | --- |
| `context` | `"2d"`, the default, or `"webgl2"` |
| `draw` | the code that draws, written as the tag's body |

- The code reads what any value reads, and `ctx` in 2D or `gl` with WebGL, `width` and
  `height` in units, and `keep`, an object kept between draws for what it makes once:
  `keep.points ??= gl.createBuffer()`.
- In 2D one unit is one, and each draw starts clear. With WebGL the code clears it.
- It draws every frame while it reads `time.now`.

## Scenes

```html
<scene id="e1" name="Cell" x="2" y="2" w="40" h="30" style="background: $panel">
  <floor id="e2" name="Floor"/>
  <anchor id="e3" name="Arm" pose="Robot.Arm">
    <box id="e4" name="Link" pose="{ position: vec(0.5, 0, 0) }" size="vec(1, 0.1, 0.1)"/>
  </anchor>
</scene>
```

A scene draws its parts in metres with z up. Every property of a part is an attribute.

| Property | Of | Takes |
| --- | --- | --- |
| `target` | `scene` | the point the camera looks at and turns about, `vec(0, 0, 0)` |
| `yaw` | `scene` | how far round from x the camera is, in radians, `-2` |
| `pitch` | `scene` | how far up the camera is, in radians, `0.5` |
| `distance` | `scene` | how far the camera is from `target`, `5` |
| `pose` | every part | where it sits and how it turns in what holds it: a Pose, as `Robot.Arm`, or `{ position: vec(0, 0, 1) }`, each half optional |
| `color` | every part but `anchor`, `axes`, `grid` and `model` | a colour, `$accent`, or `$border` for a floor. `points` take a list too, one per point. A PointCloud or a Mesh left without one shows its own `rgb` |
| `opacity` | `box`, `sphere`, `cylinder`, `mesh`, `grid` | `1` |
| `size` | `box` | its edges, `vec(1, 1, 1)` |
| `size` | `axes` | how long its arrows are, `1` |
| `size` | `points` | how wide each dot is in metres, `0.05`, or a list, one per point |
| `size` | `floor` | how wide it is, `10` |
| `step` | `floor` | the gap between its lines, `1` |
| `radius` | `sphere`, `cylinder` | `0.5` |
| `length` | `cylinder` | along its z, `1` |
| `points` | `points` | a list of points with `x`, `y` and maybe `z`, as a Double3 list from the mesh, or a PointCloud, a LaserScan, a Path or a Polyline. A cloud's points sit at its `origin` |
| `joined` | `points` | `true` to draw one line through them instead of dots, broken where a point is not drawn |
| `mesh` | `mesh` | a Mesh, as `Cell.Part`, `null` for none. Its vertices sit at their cloud's `origin`, and their `normal_x`, `normal_y` and `normal_z` light it when it has them |
| `grid` | `grid` | a Grid, as `Cell.Map`, `null` for none. Its first cell's outer corner sits at its `origin`. A flat one draws as a picture, a square a cell, a deep one as a cube a cell |
| `field` | `points`, `mesh`, `grid` | a number each point or vertex has, or a grid's field, which colours it from blue to red, as `"intensity"`, or `"z"` for height. A scan's points have `range` and `intensity`. A grid takes its first field when left out |
| `range` | `points`, `mesh`, `grid` | the low and high ends of `field`, as `[0, 100]`, its values' own when left out. A point outside it is not drawn, nor a triangle with a vertex outside it, nor a cell |
| `vector` | `arrow` | where it points from its pose, as long as it is, `vec(1, 0, 0)` |
| `src` | `model` | a USD file in the project's files, as `"files/ur10e/ur10e.usd"`, or a glTF file, `.glb` or `.gltf`, as `"files/hall.glb"` or any URL, which stays as its file puts it |
| `joints` | `model` | a USD robot's joints by name, `{ elbow_joint: 0.5 }`, each turned by radians or slid by metres, or a JointState, as `Arm.JointState`. A file of several robots takes each one's under its name, `{ carter_1: { left_wheel: 2 }, arm: Arm.JointState }`. A joint that mimics another, as a gripper's finger, follows it unless given its own. A glTF model has none |
| `names` | `model` | the joint each of a JointState's positions is for, a list or a JointNames, as `Arm.JointNames`, or these under each robot's name. Left out, a robot takes its moving joints in the order Isaac Sim lists them |

- An `anchor` draws nothing. It places what it holds by its pose, as a frame of a TF tree.
- A USD robot reads as Isaac Sim saves one: its layers, references and variants, meshes and
  shapes, colours and textures. Its collision shapes stay hidden. A layer or texture outside the
  project's files is left out with a warning. One on a web server, as NVIDIA's asset server, is
  downloaded into `files/downloaded` the first time.
- A USD file may hold several robots, as a cell or a warehouse does. Each is named by the prim
  that holds it, and the inspector lists them with their moving joints.
- A model stands z up in metres, as every RANT frame. A USD file is turned and scaled by its own
  `upAxis` and `metersPerUnit`, centimetres when it gives none. A glTF file is y up in metres by
  its standard.
- The camera moves only by its properties. A scene added in the editor comes with a `<var>`
  its camera reads and handlers that move it.

## Style

Any CSS property goes in `style`, each value an expression:
`background: Line.Running ? $green : $panel`.

- A bare number is units for a length: sizes, padding, margin, gap, borders and their radius,
  font size, letter spacing and outlines. It is degrees for `rotate`, a blur in units for
  `backdrop-filter`, and as it is for the rest, as `opacity: 0.5`.
- CSS text is taken as written: `box-shadow: "0 2px 8px #0008"`. Bare numbers in it that CSS
  would refuse read as units: `"0 0.2 0.8 #0008"`.

## State

A `<var>` first inside a page or an element keeps state there:

```html
<div id="e1" name="Menu" w="20" h="hug">
  <var name="expanded" start="false"/>
  <on event="tap">
    expanded = !expanded;
  </on>
</div>
```

- The element and all it holds read it by name.
- `start` is its first value, as JSON.
- Each screen keeps its own, or with `per="hmi"` every screen shares one.

## Repeat

`repeat="6"` or `repeat="Line.Jobs"` draws an element once per item. Each copy reads `index`,
from 0, and `item`, its item of the list.
