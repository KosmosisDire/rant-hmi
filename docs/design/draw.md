# Drawing in a scene

Asked 2026-10-27: a scene should let a designer draw any visualization, easily and
efficiently, with SDFs and procedural meshes possible, taking lessons from the Viz library in
UPS2 (`Assets/Project/Viz`). This record weighs the options and proposes slices. Nothing here
is built yet.

## What a scene has now

- Parts as elements (`box`, `sphere`, `cylinder`, `arrow`, `axes`, `grid`, `points`, `model`),
  each one three.js object, its properties expressions. Good for a scene graph made in the
  editor: a robot cell, a TF tree, a model with joints.
- `points` draws a list as dots, now with a colour and a size each.
- `canvas` with `webgl2` hands code raw WebGL, on its own canvas, outside any scene.

What it lacks is a way to draw many things from data in one go: a box per detection, a path
per robot trail, a label per part, a mesh made from numbers. `repeat` on a part makes one
three.js object per item, one draw call each, which stops being cheap at a few hundred.

## What Viz teaches

- **Immediate mode.** Code says what to draw this frame, `Draw.Point(at, 0.02, red)`, and that
  is all it shows. No objects to make, keep and free.
- **Batches by style.** Every call with an equal style lands in one GPU draw. A call costs an
  array append, so a million points is one draw.
- **Four families.** Points (disc, ball, ring), lines (flat ribbons with joins and caps, or
  solid tubes: capsule, cylinder, cone), quads (rect, rounded, frame, box, image), and solids
  made of several parts unioned per pixel so they read as one shape (an arrow, a gizmo).
- **Sizes in metres or pixels**, and a least size in pixels, so a far cloud never vanishes.
- **Shapes cast per pixel** on a quad or a box rather than built of triangles: a ball, a
  capsule or a rounded box is exact at any zoom and costs one small record each.
- **Looks shared by every family**: unlit, simple or lit, opaque, see through (sorted back to
  front) or glowing (additive, no sort), on top of everything, an outline in pixels.
- **Retained sets** for what changes rarely: fill once, upload only when it changed.

What does not carry over: Unity's render pipeline, shadows and C# structs. Here the drawing
runs in three.js in the screen's data worker, and code is the HMI's own language.

## Options

A. **A `draw` part.** A part whose body is code, as a canvas's is, placed by its pose in the
   scene tree so it draws in the frame of what holds it. The code calls `draw.points(...)`,
   `draw.path(...)`, `draw.box(...)` and so on, and what one run drew is all it shows. It runs
   again when what it read changes, at most once a frame, every frame while it reads
   `time.now`. Calls batch by style into one draw each in the worker.

B. **More part tags**, one per shape (`line`, `path`, `capsule`, `label`, `mesh`), with
   `repeat` for many. Seen and edited in the editor, but one object per item, so slow for
   data, and every new shape is a new tag.

C. **three.js in code**, handing draw code `THREE` and a scene. Every power, but code must make,
   keep and free objects, it runs on the page while the scene draws in the worker, and it ties
   every project to three.js's API.

**Proposed: A, with the parts kept.** Parts stay the way to build a cell in the editor, and a
`draw` part is the way to draw data. The parts and `draw` share one renderer, so a `box` part
and `draw.box` are one implementation and look alike.

## The API

Code in a `draw` part reads what any expression reads, plus `draw`. Each call takes what to
draw, then an optional style. Lengths are metres unless the style says `units: "px"`.

```js
for (const b of Found.boxes) draw.box(b.pose, b.size, { color: $red, outline: 2 });
draw.points(Scan.points, { size: 0.01, color: Scan.colors });
draw.path(Robot.trail, { width: 3, units: "px", color: $accent });
draw.label(Arm.position, `${Speed} m/s`);
```

| Call | Draws |
| --- | --- |
| `draw.point(at, style)`, `draw.points(list, style)` | dots, balls or rings. `size` and `color` take one or a list one per point, as the `points` part does |
| `draw.line(a, b, style)`, `draw.path(list, style)` | a line, or one through a list, flat or a tube, with round or flat ends |
| `draw.sphere(at, radius, style)` | a ball |
| `draw.box(pose, size, style)` | a box, its edges rounded by `round` |
| `draw.cylinder(a, b, radius, style)`, `draw.cone(...)`, `draw.capsule(...)` | the tube family between two points |
| `draw.arrow(a, b, style)` | an arrow, one solid |
| `draw.axes(pose, size)` | x, y and z in red, green and blue |
| `draw.circle(pose, radius, style)`, `draw.rect(pose, size, style)` | flat shapes in a plane, filled or as a frame |
| `draw.grid(pose, size, step, style)` | a grid |
| `draw.label(at, text, style)` | text that faces the camera, in px |
| `draw.image(pose, size, src)` | a picture on a plane, from `files/` or an import's picture |
| `draw.mesh(mesh, style)` | a mesh from numbers: `positions`, and `indices`, `normals`, `colors` if it has them |
| `draw.sdf(code, bounds, style)` | a shape given as a signed distance in GLSL, cast within `bounds` |

Style, the same words for every call where they apply:

| Key | Takes |
| --- | --- |
| `color` | a colour, or a list one per item where the call draws many |
| `size`, `width`, `radius` | metres, or px with `units: "px"`, one or a list |
| `units` | `"m"` (the default) or `"px"` |
| `look` | `"flat"` (unlit), or `"lit"` |
| `blend` | `"solid"`, `"see"` (see through, sorted), or `"glow"` (added, needs no sort) |
| `over` | true to draw over everything, as a marker that must always show |
| `outline` | px of outline, in `outlineColor` |
| `form` | for points `"dot"`, `"ball"` or `"ring"`, for lines `"flat"` or `"tube"` |

- A big value the worker keeps goes through as it is: `draw.points(Scan.points, ...)` never
  brings the cloud to the page, as the `points` part does now.
- Draw code only reads, as a canvas's does.
- Each run sends its batches to the worker as typed arrays, moved, not copied.

## The open end

- **SDFs.** `draw.sdf("return length(p) - 0.5;", bounds)` casts a ray per pixel through the
  box `bounds` and shades the surface where the GLSL gives 0. Unions, blends and repeats are
  the code's own. One shader per distinct code, compiled once.
- **Meshes.** `draw.mesh` takes any geometry made from numbers, so a heightmap, a swept
  profile or a URDF link is the code that makes its lists.
- **Not offered:** raw three.js objects or WebGL calls inside a scene. A designer needing that
  has `canvas` with `webgl2`.

## How it draws

- One three.js `InstancedBufferGeometry` and `ShaderMaterial` per family and style, holding a
  record per item: a point's place, size and colour, a segment's ends and widths, a box's
  pose, size and rounding.
- Points are quads facing the camera, cut round, or cast as a ball with its true depth.
  Tubes and boxes are cast within their bounding box, as Viz's are. A path is a ribbon of
  quads with mitred joins, in px or metres.
- See through batches are sorted back to front in the worker when the camera or the data
  moved. Glow needs no sort.
- Labels are drawn into one texture as they come and kept while used.

## Slices

1. **The `draw` part and points and lines.** The part, its code, the run and the batches to
   the worker. `draw.point`, `draw.points`, `draw.line`, `draw.path`, in m and px, flat. The
   `points` part moves onto the same batch.
2. **Solids.** Ball, box, cylinder, cone, capsule, arrow, axes, cast per pixel, flat or lit,
   with outlines. The `box`, `sphere`, `cylinder`, `arrow` and `axes` parts move onto them.
3. **Flat shapes, labels and images.** Circle, rect, grid, label, image.
4. **Meshes.**
5. **SDFs.**
6. **Looks.** See through with sorting, glow, over.

Each slice is a branch with a scenario that draws it and checks pixels, as design-scene does.

## Open questions

- A `draw` part in the scene tree (proposed), or draw code on the scene itself?
- Move the existing parts onto the new renderer (proposed, one implementation), or leave them
  on three.js's own objects?
- Is GLSL the right open end for SDFs and custom looks, or should it be an HMI function the
  shader is made from?
- Should a drawn item answer a tap, saying which call and which item it was? Left for after
  slice 2.
