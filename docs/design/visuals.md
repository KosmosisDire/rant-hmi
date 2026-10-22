# Visuals

A design record for item 28: a canvas that code draws on, built in views for Rant's standard
types, and 3D through three.js. Written for review, with the options weighed and why each
choice was made.

## The ask

The user's words, as they left on 2026-10-22:

> We do still need to set up a way to access a canvas + opengl context on the canvas this
> could be used for various more complex visualizations. And on that note we should create a
> built in visualization for most of the major data types built in to rant including arrays of
> those types like the explorer has but less focused on debugging and more focused on GUI HMI
> user interface. We should not go too far outside the box here though or do anything crazy or
> visually complex. Ideally we would also be able to share code between them since there would
> likely be overlap but I am not sure we have the infrastructure for that yet. Also for 3D
> stuff, to avoid creating our own whole 3d renderer we should probably do something like
> include three.js and make a binding for it the user can use to create visualizations. I am
> thinking for stuff like TF trees, robot digital twins, showing maps, point clouds, rviz type
> stuff. Or like foxglove has.

Three parts:

1. A canvas with a WebGL context, for what elements cannot draw.
2. Built in views for most standard types and lists of them, made for operators, plain.
3. 3D through three.js, with a binding a designer builds views with.

## What holds the design

The HMI's settled rules:

- UI is HTML, CSS and SVG, never a vocabulary of our own. A widget built into the renderer is
  a defect: the old closed set of primitives kept forcing special cases.
- Every built in component is made by hand in the editor. The build scenarios drive the
  editor and `--library` keeps what they make.
- A smart newcomer builds any UI with little documentation, and completion shows the options
  before anything is typed.
- Every value is an expression, and what a screen draws follows what it reads.
- 3D is z up, as Rant's frames are settled.
- One way to do each thing.

## Today

- Elements: frame, text, field, media, diagram (`svg` holding shapes), markup (SVG from code),
  instances and groups.
- Markup lets code draw, as SVG text. Fine for tens of shapes, slow for thousands, no WebGL.
- The library holds Button, Dropdown, Gauge, Joystick, Joystick1D, Knob, ModeSwitch, Plot,
  Readout, Slider and Toggle. Each takes numbers, true or false, or text. None takes a Pose, a
  JointState or a list of points.
- A screen knows each import's type, but a component's inputs have none.
- Code is shared through the math library, the same on screens and the system: `vec`,
  `fromEuler`, `lerp`, `mix`, and methods and operators on vectors, quaternions and poses
  (`q.euler()`, `pose * pose`). And by nesting components. A project cannot write a function
  once and call it from many places.

## Part 1: a canvas

### Options

A. **A `canvas` element whose code draws.** Its `draw` code runs on the screen with the
   canvas's context, again whenever what it reads changes, at most once a frame.
B. **Hand the canvas to a handler.** A start event gives code the context to keep. Handlers
   run on events, not on values, so the code would have to watch values itself.
C. **Components written in JavaScript.** A module per component with its own mount and
   update. A second way to make components, against the dogfood rule.

**Chosen: A.** It is how markup works already: code that gives what is drawn, run again as
its values change. A canvas is HTML, so nothing of our own is added to learn.

### How it works

- `context` is `"2d"`, the default, or `"webgl2"`.
- `draw` is code, statements, written as the tag's body as markup's code is. It reads what any
  expression reads, and:
  - `ctx` with `"2d"`, `gl` with `"webgl2"`: the context, by the names every tutorial uses.
  - `width` and `height`: the canvas's size in units.
  - `keep`: an object that lasts as long as the canvas, for what code makes once, as
    `keep.program ??= ...`.
- In 2D one unit is one, as a diagram without a view box draws, and the canvas is cleared
  before each draw. WebGL starts each draw with its viewport the whole canvas, and the code
  clears it.
- The canvas fills the element's box at the screen's pixel ratio, and draws again when the
  box changes size.
- Code that reads `time.now` draws every frame, as an expression reading it updates.
- Draw code only reads: a write to a name throws, as drawing must never change state.
- Where the code throws, the editor marks the element and says why, as for any property.
- A lost WebGL context empties `keep` and draws again once the context is back.
- Handlers work as on any element: a press or a drag gives `p.x` and `p.y`.

## Part 2: built in views

### What each type shows

The explorer shows every type for debugging, as a picture that changes over time. An HMI
shows it to an operator: the reading, at a glance, in the theme's look.

| Type | The explorer | The HMI |
| --- | --- | --- |
| number | a plot over time | Readout, Gauge, Plot (there now) |
| true or false | a state | Lamp |
| enum | a state | Readout of the option's name |
| text | text | Readout |
| Timestamp, Duration | time | Readout through `Date` |
| Float2, Double2, Int2, Pose2D, Transform2D | an arrow or a marker in a plane | Position, a marker in a plane with its reading |
| Float3, Double3, Int3, Quaternion, Pose, Transform | a 3D picture | Pose, x y z and roll pitch yaw as numbers. In 3D, axes |
| Twist, Wrench | arrows | Pose's numbers for each half. In 3D, arrows |
| JointState with JointNames | joints | Joints, a bar per joint with its name and angle |
| Color | a swatch | Swatch |
| GeoPoint | a point | Readout of lat and lon |
| number list | bars | Bars |
| true or false list | cells | Lamps, a Lamp per item |
| list of 2D points or poses | an overlay | Position, all in one plane |
| list of 3D points | an overlay | a 3D scene's points |
| list of structs, matrix | a table | Table |
| Image, VideoFrame, ExternalVideoStream | a picture, a video | media (there now) |

### How a view reaches a designer

A. **An element that draws any value by its type**, as the explorer's visuals do. A widget
   in the renderer, closed to the designer, against the rules.
B. **Components in the library, made in the editor.** Each takes the value as an input, as
   Gauge does. A designer places one, binds it, restyles it or copies it into one of their own.
C. **B with typed inputs.** A component's input says the types it takes,
   `<prop name="value" type="Pose Transform"/>`, so the editor can offer the views that show
   an import, and later complete its fields.

**Chosen: B, then C.** B gives every view now with nothing new in the renderer. C makes the
editor match a view to an import as the explorer does, and is its own slice after B.

### Typed inputs

Four questions: how an input says what it takes, how a type is named, where the editor offers
a view, and what of the library is typed.

**How an input says its types.**

A. **`type` on `<prop>`**, names apart by spaces as `class` lists them:
   `<prop name="value" default="0" type="number"/>`.
B. **A type expression**, `Pose | Transform`. A small language of its own to learn and parse.
C. **Worked out from the component's code**, from what it reads of the input. Hidden, and
   wrong once code guards a field it may lack.

**Chosen: A.** One attribute, read as plainly as a class list.

**How a type is named.** A screen sees an import's Rant type: `f64`, `Pose`, `f64[]`, as the
Data screen shows it.

A. **Rant's names only.** Gauge would list every number kind, ten of them.
B. **The math library's shapes**, `vec2`, `quat`, `pose`. Not what the Data screen shows, and
   Rant's `Double2` and `Float2` would read the same.
C. **Rant's names and kinds, and `number` for any number.** **Chosen.** A value answers to:
   - its type's name, as `Pose`, `Color` or an enum's `Mode`;
   - its kind: `bool`, `string`, `enum`, `struct`, or its number kind, as `f64`;
   - `number`, for any number kind;
   - for a list, each of its items' names with `[]`, as `Pose[]` or `number[]`, fixed or not.

An input with no type says nothing of what it takes. It still takes any value, and the editor
offers it for nothing. Names are spelled as code is: a letter, then letters, digits or `_`,
then `[]` for each list around it.

**Where the editor offers a view.**

A. **The Data screen's import**, a list of views to place. It places on a page from another
   screen.
B. **Dropping an import on the page.** The Design screen lists no imports, so it needs a pane
   of its own.
C. **The Design screen's add menus**, beside Place a component: Show an import, then the
   import, then the views that take it. A struct's fields follow its own views, each with
   theirs, so `Conveyor.speed` gets a Readout and `Conveyor.running` a Lamp.
D. **An instance's input field**, its completion ranking the values that fit first. The other
   way round, from a view to a value.

**Chosen: C.** Placing already lives in these menus, and a submenu per field walks a struct as
the Data screen's tree does. D is left for when completion learns the fields' types too.

The view placed is the component with the input that takes the value set to its path, as
`value="Conveyor.speed"`, where the menu was opened, as Place a component places it. The first
input whose type fits takes it. A two way input is offered only for a variable imported to
write, since writing anything else fails.

**What of the library is typed.** The inputs that show a value, so a view placed for an import
shows it with nothing else set:

| Component | Input | Type |
| --- | --- | --- |
| Readout | `value` | `number string enum` |
| Gauge, Bar | `value` | `number` |
| Knob, Slider | `value` (two way) | `number` |
| Lamp | `value` | `bool` |
| Toggle | `value` (two way) | `bool` |
| Swatch | `value` | `Color string` |
| Pose | `value` | `Pose` |
| Position | `value` | `Double2 Float2 Int2 Pose2D`, and each with `[]` |
| Bars | `values` | `number[]` |
| Joints | `state` | `JointState` |
| Table | `rows` | `struct[]` |

Dropdown and ModeSwitch stay untyped, as they need their options set to show an enum. Plot
takes a record, not an import. Inputs such as `labels` or `min` stay untyped, so a list of
names is never offered Joints.

Left for later: screen variables and computed values have no type of their own, so only
imports are offered views, and completion does not yet rank what fits.

### Sharing code

What the views share: a quaternion read as roll, pitch and yaw, a number with its unit and
digits, a bar between two limits, a point placed in a plane.

1. **Nesting.** A view holds instances of smaller ones: Joints a bar per joint, Pose its
   readings. Works today.
2. **The math library.** What every view computes the same way, as `q.euler()`. Works today,
   for math general enough to be the HMI's own.
3. **Project functions.** Functions a project writes once, as a file every expression reads.
   This is the infrastructure the user sensed is missing: a file, its editor, completion,
   renames, and running the same on screens and the system.
4. **With the explorer.** The explorer is C++ over RmlUi and the HMI TypeScript over the DOM,
   so no drawing code can pass between them short of carrying one inside the other. The
   explorer's web build is a whole wasm app. What they share is the table above: which type
   gets which kind of view.

**Chosen: 1 and 2.** The views need nothing more. 3 is worth an item of its own, asked of the
user below.

## Part 3: 3D through three.js

### Options

A. **Our own renderer.** Ruled out by the user.
B. **three.js in a canvas's code.** A context that hands draw code `THREE`, a scene and a
   camera. Every power three.js has, but code must build its scene once and change it after,
   the editor sees nothing inside, and every view starts from nothing.
C. **A scene element holding 3D parts as elements.** As a diagram holds SVG shapes, a scene
   holds parts, each one three.js object with its properties expressions. The binding is the
   map from element to object, as react-three-fiber does for React. The layers show the scene
   graph, nested parts make a TF tree, `repeat` makes a part per item, the inspector edits a
   part with completion, and values move parts with no code.
D. **C with all of three.js.** Each class a tag, geometry and material child elements, as
   react-three-fiber does. Open to everything, but a box is three elements deep, names clash
   with ours (`group`, `line`, `text`, `points`), and the designer must learn three.js.

**Chosen: C**, with parts that each map to one three.js object and take Rant's types as they
come from the mesh. A canvas with `"webgl2"` stays the way to draw anything else.

### The parts

Lengths are metres, z is up, and a part is placed by `pose`: a Pose, its position and
orientation each optional, as `pose="Base"` for a Pose import or
`pose="{ position: vec(0, 0, 1) }"`. A pose counts from what holds the part.

| Tag | three.js | Is | Its own properties |
| --- | --- | --- | --- |
| `scene` | renderer, scene, camera, lights | the 3D view, placed and sized as a frame | `target`, `yaw`, `pitch`, `distance` |
| `anchor` | Group | places what it holds by its pose, as a TF frame. Draws nothing | |
| `axes` | AxesHelper | a frame's x, y and z, red, green and blue | `size` |
| `box` | Mesh, BoxGeometry | a box centred on its pose | `size` (a vector), `color`, `opacity` |
| `sphere` | Mesh, SphereGeometry | a ball | `radius`, `color`, `opacity` |
| `cylinder` | Mesh, CylinderGeometry | a cylinder along its z | `radius`, `length`, `color`, `opacity` |
| `points` | Points, or Line | a list of points as dots, or one line through them | `points`, `size`, `joined`, `color` |
| `grid` | GridHelper | a square grid on its xy plane | `size`, `step`, `color` |
| `arrow` | ArrowHelper | an arrow from its pose | `vector`, `color` |
| `model` | GLTFLoader | a glTF file, its named nodes moved by `joints` | `src`, `joints` |

- Only `scene` and `anchor` hold parts, as only `svg` and `g` hold shapes.
- `color` takes any colour the page takes, tokens too. Unlit parts would read flat, so the
  scene lights them from above and from the camera.
- A scene's background is its CSS `background`, as any element's. The 3D draws over it.
- The camera orbits `target` (the origin when left out): `yaw` turns it about z from +x,
  `pitch` raises it, `distance` sets how far. A designer turns it with handlers and screen
  variables, as the map view pans a picture:
  `yaw = yaw - p.dx * 0.01` on drag, `distance = distance / p.factor` on zoom.
- `points` takes a list of vectors, as a Double3 list from the mesh gives. `joined` draws one
  line through them instead, as a path.
- `joints` takes `{ name: angle }`: each named node of the model turns about its own z, or by
  a pose, `{ name: { orientation: ... } }`, from where the file puts it.
- three.js loads only on a screen that shows a scene, as its own file, so pages without one
  pay nothing for it.

Considered and left for later:

- **Orbit by default** with no handlers. Simple to use, but a second way to move the camera,
  hidden state per screen, and in the way of the designer's own drag. Asked below.
- **Picking a part on the artboard** by where the pointer meets it. Parts are picked in the
  layers at first, and the artboard rings the scene.
- **Handlers on parts**, pressing a box in the scene.
- **Labels, images on planes for maps, and URDF robots.** Each fits the same pattern.
- **A project's own files**, as a model, served from a folder of the project. A model takes a
  URL for now.

### Naming

`anchor` and not `group`, `frame` or `node`: an HMI group has no place of its own, a frame
is the HMI's word for a `div`, and a node is a Rant program. `points` and not `line`, since
the SVG `line` is taken, and one list of points shown two ways is one part.

## Slices

1. **Canvas.** The `canvas` element, its file form, the inspector and add menu, docs and a
   scenario. Built first: the smallest piece, and the way to draw anything the rest cannot.
2. **Scene.** `scene`, `anchor`, `axes`, `box`, `sphere`, `cylinder`, `points` and `grid`,
   three.js loaded lazily, the inspector, docs and a scenario. Then `arrow` and `model`.
3. **Views.** Lamp, Bars, Joints, Pose, Position, Swatch and Table, each built in the editor
   by a build scenario and kept in the library.
4. **Typed inputs.** `type` on an input, and the editor offering the views that show an
   import.

## With the phone layout

Item 27 is on its own branch. When both are in, a canvas and a scene narrow as a picture
does, their height kept in proportion.

## Open questions for the user

- Should a scene orbit by default when it has no drag handler? Chosen: no, the designer adds
  the handlers, as with the map view.
- Should a project write functions once and call them everywhere, a file of its own? Chosen:
  not in this item.
- Draw code only reads. Should it be able to set a screen variable, as a measured size?
  Chosen: no.

## As built

### Slice 1, the canvas

Built as Part 1 says. A drawing's fault reads `draw: ...` on the canvas, and a screen with no
such context says so under `context`.

### Slice 2, the scene

- **One table of parts.** `client/src/page/parts.ts` holds each part's own properties and the
  code each takes when left out. The scene draws from it and the inspector builds each part's
  fields from it, so a field's placeholder is the default it stands for.
- **Where an element goes.** The backend gives each tag a home: on a page, in a diagram or in a
  scene. That one rule decides what holds what, what grouping makes (`group`, `g` or `anchor`)
  and that a shape's or a part's every property is an attribute. The client mirrors it in
  `homeOf` and `holds`.
- **A value that cannot be read gives way to the default**, as CSS drops a value it cannot
  take, and the scene's title lists each part's faults by its name. A part with a value not
  known yet draws nothing and hatches the scene.
- **Shared with the canvas and the page.** Drawing once a frame at the pixels covered lives in
  `page/drawing.ts`, and repeating in `page/repeat.tsx`, so parts repeat as elements do.
- **three.js 0.186** is its own file, about 158 kB zipped, fetched with the first scene a
  screen shows. A scenario checks that no page without one fetches it.
- **A new scene holds a floor grid and its axes**, so it shows which way it looks.
- **Light** comes from the sky and from the camera, on Lambert materials.
- **`arrow`** points along `vector` from its pose, as long as it is.
- **`model`** loads a glTF file once per URL, shared by every part showing it. A glTF file is y
  up by its standard, so a model stands it up at its root. `joints` turns a named node by an
  angle about its own z, or moves it by a pose, from where the file puts it. Names match as
  the loader spells them, spaces as underscores.
- **Editor.** A picked part rings its scene, with no grips. The inspector shows a Camera
  section on a scene and each part's fields, and Add part, which shares one component with Add
  shape. The menu on a scene or a part adds parts. Layers, grouping and pasting follow the
  home rule.

Left for later, as Part 3 says: picking parts on the artboard, handlers on parts, labels,
pictures on planes, URDF, and serving a project's own files for models. A model takes a URL.

Choices worth a second look:

- Falling back to the default on a fault, rather than keeping the last value that read.
- Turning every glTF file z up, which suits files made to the standard.
- An angle in `joints` turns about the node's own z. Another axis takes the pose form.
- A model that failed to load stays failed until the screen reloads.

### Slice 3, the views

- **Eight new standard components**, each made in the editor by a build scenario and kept with
  `--library`: Lamp, Swatch and Pose in `build-readings`, Bar, Bars and Joints in
  `build-bars`, Position in `build-position` and Table in `build-table`. The reference lists
  every standard component and what it shows.
- **Shared by nesting.** Bars holds a Bar per number with its label and reading, Joints holds
  Bars of a JointState's angles in degrees, Pose a Readout per number in two rows, and Swatch a
  Readout for its words. A view is built in the same scenario as the views it holds, since
  each worker of the suite keeps a project of its own. So Readout moved from `build-dials` to
  `build-readings`.
- **Shared through the math library.** Pose reads roll, pitch and yaw with `q.euler()`, and
  Joints and Pose turn radians with `degrees`. Nothing new was needed.
- **Readout reads text too**, so it shows an enum's option or a time through `Date`, and
  leaves out the space when it has no unit.
- **Bar fills from zero toward its value**, so a signed value such as a joint angle grows
  either way from the middle, and a plain level from the left.
- **Position is y up**, as a physical frame is, through a view box turned over. It takes one
  2D point or pose, or a list, and draws a heading only for a pose.
- **Table** takes its columns from the first row unless `columns` names them. A cell repeats
  inside a repeated row, reading the row in its `repeat` before its own `item` takes the name.
  Rows scroll inside the table.
- **A list of one view**, as Lamps, is that view placed with `repeat`, with no component of
  its own.
- Test components that were named Lamp, Bar or Meter took other names, so a suite worker
  never makes two of one name.
- The user's demo gets the new components once this branch is merged, as the library rule
  says, and not before.

Choices worth a second look:

- Joints shows every joint in degrees, so a sliding joint's metres read as degrees too.
- Position reads out a single value, and only a count for a list.
- Bar lies flat only. Bars lays its bars out as rows, which also fits long labels.
- A unit follows its number after a space, so an angle reads `90.0 °`.
- Table writes whole numbers as they are and others to `digits`, and a struct in a cell as
  JSON.

### Slice 4, typed inputs

Built as Typed inputs in Part 2 says.

- **The input's `type`** is kept by the backend apart by single spaces, and a word that is no
  type is refused, on an edit and when a file loads. The rule is in `rules.rs` with the other
  name rules, and the editor's field reads the same pattern from `rules.ts`.
- **The inspector** gives each input a Type field below its Default. Completion offers the kind
  words before anything is typed, then every type the mesh names.
- **Matching** lives in `client/src/state/types.ts`: the names a Rant type answers to, and the
  components whose input takes it. Completion and the menu both read it.
- **Show an import** sits in the layers bar's + and in the right click menus, beside Place a
  component, and places at the same spot. An import lists its own views, then each field with
  views of its own, as deep as the struct goes. A function or a task is never listed.
- **The library** is typed by its build scenarios through the same field, as the table in Part
  2 says, and `--library` kept it.

Choices worth a second look:

- `number` takes every integer and float kind, and the Rant kind names narrow it.
- An input with no type takes anything but is offered for nothing, so Dropdown and ModeSwitch,
  which need their options too, are never offered.
- Only imports are offered views. Screen variables and computed values have no declared type.
- Convert to component leaves the inputs it makes untyped.
