---
name: hmi
description: The Rant HMI, screens for machines designed in a browser editor and run by a native backend. Use when a project is an HMI project (hmi.toml, pages/*.html, components/*.html), or the user asks to make or change an HMI.
---

# Rant HMI

The package `hmi` makes screens for machines: pages designed in a browser editor and run by a
native backend that is the Rant node and runs their logic. A project is a folder of plain text
files, and you may write them directly. This skill is a guide. Fetch the docs, plain text,
for anything it leaves out:

| page | fetch it for |
|---|---|
| https://docs.rantlib.dev/hmi-start.md | running it, a first screen in the editor |
| https://docs.rantlib.dev/hmi-project.md | the files, objects and their members, logic, settings, theme tokens |
| https://docs.rantlib.dev/hmi-pages.md | every element and property: layout, text, media, shapes, canvas, scenes, style, state |
| https://docs.rantlib.dev/hmi-components.md | the component file, input types, the standard components and their inputs |
| https://docs.rantlib.dev/hmi-events.md | every event, its settings and what its `p` holds |
| https://docs.rantlib.dev/hmi-code.md | every name and function code reads, tasks, vectors, poses, colours |
| https://docs.rantlib.dev/hmi-deploy.md | https, firewalls and WebRTC, apps for a device |
| https://docs.rantlib.dev/hmi-status.md | `Hmi/Status`, `Hmi/Clients`, `Hmi/Problems`, the warnings on the HMI node's Rant status |

## Set up

| goal | command |
|---|---|
| install | `rant install hmi` |
| run a project | `rant run Hmi project=line-hmi`, a folder counted from where you run it. An empty folder becomes a new project. `port=N` and `bind=IP` set where it listens, 6739 on every address by default |
| open it | `http://localhost:6739` designs it, `http://localhost:6739/run` is an operator's screen |
| check an edit | `rant log Hmi -n 20` names a refused file and the reason |
| see what is wrong | `curl http://localhost:6739/problems` gives every screen's problems as JSON |
| stop it | `rant stop Hmi` |
| at every boot | `rant enable Hmi project=...`, `rant disable Hmi` |

- There are no logins yet: whoever reaches the port can change the project and press its
  buttons. Use `bind=127.0.0.1` on a shared network, or put access control in front.

## Workflow

1. Find the entities: `rant ls entities`, then `rant info <name>` for a type and its fields.
2. Write one object per machine in `objects/<Name>.html`, in a folder under `objects/` if the
   project groups them, as `pages/` and `components/` may. A folder is never part of a name.
   Name only the entities the HMI
   uses, and give `intent="write"` only to what it must change.
3. Build pages from the standard components in `components/`, laid out with frames.
4. Add handlers for what operators do, and logic in an object for what must happen with no
   screen open.
5. After each edit, read `rant log Hmi` and `/problems`.

```html
<object name="Line" mesh="Line1">
  <variable name="Speed" entity="Speed"/>
  <variable name="Target" entity="Target" intent="write"/>
  <function name="Start" entity="Start"/>
  <var name="mode" start='"Auto"' per="hmi"/>
  <record name="speedHistory" source="Speed" every="100" keep="600"/>
</object>
```

```html
<page name="Overview" size="128x72">
  <div id="e1" name="Line panel" x="2" y="2" w="32" h="hug" style='layout: "down"; gap: $space; padding: $spaceLarge; background: $panel; border-radius: $radiusLarge'>
    <span id="e2" name="Title" w="hug" h="hug" style="color: $dim">"Line 1"</span>
    <Readout id="e3" name="Speed" w="fill" h="8" label='"Speed"' value="Line.Speed" unit='"m/s"' digits="2"/>
    <Slider id="e4" name="Target" w="fill" h="5" value="Line.Target" max="2"/>
    <Button id="e5" name="Start" w="fill" h="6" text='"Start"' fill="$green" holdMs="600">
      <on event="confirm">
        await Line.Start();
      </on>
    </Button>
  </div>
</page>
```

- Every element has an `id` of its own in its file. Keep the ids of what exists and give
  what you add the next free one.
- Every value but `id` and `name` is an expression: `Line.Speed * 10`, text in quotes,
  `$accent` a token. Put a value holding double quotes in single quotes.
- Pages and other objects read `Line.Speed` and call `await Line.Start()`. The object's own
  code reads its members bare.
- Mesh members are PascalCase and the HMI's own state camelCase, so the two never look alike.
  No object, import or enum takes a standard type's name, as `Pose`.

## What the HMI does, what you write

The HMI does these by itself. Never build them:

- Live values: every value redraws as it changes, on every screen. Write no polling, timers
  or refresh code.
- Missing data: an element showing a value not known yet draws hatched, a scene part draws as a
  grey ghost or not at all, and a handler that reads or calls one stops. `Hmi.Status.missing`
  lists the mesh members not on the mesh.
  `a ?? b` gives b while a is unknown, and `await Arm.Stop?.()` skips the call while Arm's
  node is off the mesh, so code that can go on without a member says so with `??` or `?.()`.
- Where code runs: write no client and server split.
- Connections: a screen reconnects by itself. Video plays as H264 when rant-transcoder runs
  on the camera's host, else as the pictures come. Write no player or reconnect code.
- A screen that drops: the HMI lets go of all it held, so its `release` handlers run with
  `p.lost`. Write no watchdog.
- Writing back: a bindable input bound to a writable name writes it, and a refused write says
  why.
- Theme: each screen follows its device's light or dark setting through the tokens. For a
  switch in the app, a handler calls `theme.toggle()` or `theme.set("light")`, and that device
  keeps the choice.
- Phones: a phone held upright lays a page out again for its width, never zoomed. Build no
  phone layout.
- Files: a saved change reaches every screen. A file with a mistake is refused and the last
  good one stays.
- Records sample and logic runs on the backend, whether a screen is open or not.
- Geometry: `math` holds Rant Math in all code, a page's and the system's: poses, axes, shapes,
  fits, cameras, images and point clouds, as `math.poseInverse(p)`. A value of a standard type
  takes its calls as methods and operators, as `p.inverse()` and `p * v`. Write none of that by hand.
- Standard types: each one's name makes a value of it from all its fields, as
  `Cylinder({ axis, radius })`, needed where two types share their fields, as a Capsule and a
  Cylinder do. A Float or Int vector takes its own type's methods, then its Double one's.

You write the rest: objects, pages, components, tokens, handlers, logic, and the safety
choices below.

## Designing components

- Use a standard component before writing one. Changing a project's copy changes every
  instance of it.
- One job and the fewest inputs that do it: what an instance must say (`value`, `text`,
  `min`, `max`, `unit`, `options`) and a few look inputs. Add more only when asked.
- Every look input defaults to a token (`fill` `$panel3`, `colour` `$accent`, `textColour`
  `$text`, `radius` `$radius`), so the component follows the theme until an instance sets
  its own. Work states out from those: `fill.darken(0.15)` pressed, `colour.alpha(0.15)` a
  tint.
- Name inputs and events as the standard ones do: `value`, `min`, `max`, `step`, `unit`,
  `digits`, `text`, `label`, `labels`, `icon`, `options`, `fill`, `colour`, `textColour`,
  `textSize`, `radius`, and `change` with the new value, `confirm`, `move`.
- A control that holds a value has one `value` input with `bindable="true"`. Its code sets
  `value`, then sends `change` with it. An instance bound to a writable name writes back to
  it. One bound to the machine's state shows it, and its `change` handler asks the machine,
  so the screen shows what the machine reports, not what was pressed.
- Give a view's main input a `type`, as `type="number"` or `type="Pose"`, so the editor
  offers it for members of that type.
- A component never names an object. Data comes in through inputs and actions go out as
  events, so one component serves any machine and the page decides what a press does.
- `sizing="fill"` for what stretches (buttons, cards, bars, plots). Leave it out for a drawing
  that must keep its shape, as a dial, which then scales whole.
- Name each part for its role in camelCase (`track`, `thumb`). Give every press a visible
  response through the part's `pressed`.
- Made for touch: targets at least 4 units high, nothing shown only on hover, `outside`
  closes what a press opened.
- A part of a 3D scene placed many times, as a cell or a gizmo, is a component with
  `space="3d"` holding parts. Its instance goes in a `<scene>` with a `pose` and its inputs.
  Its parts' handlers read `p.ray`, a Ray in the instance's own frame, and `p.point`, so a drag
  along an axis is `p.ray.closestRay({ origin, direction }).b`.

## Designing pages

- One top level frame per panel, holding its title and its controls, so each panel stays
  whole when a phone lays the page out again.
- Lay out with frames: `layout`, `gap`, `padding`, `w="fill"`, `h="hug"`, and a repeated part
  for a list. `align` sets what a frame holds, or a text's lines, at one of nine points, as
  `"center left"`. Keep `x` and `y` for what sits on its own, as a marker over a picture.
- A small part that shows only at times takes `visible` in its style, as `visible: Line.fault`.
  Hidden, it reads nothing, so a hidden camera streams nothing.
- Whole panels that take turns in one place are pages of their own, each sized to the place, in
  a `<view page='source == "Twin" ? Pages.Twin : Pages.Camera'/>`. Each is edited alone, and
  only the one shown is drawn. Two views of one page keep their own state. A view shows a web
  page too, as `page='"https://grafana.local/d/line1"'`, where the site allows framing.
- Chrome, a header and a nav round every page, is a Shell page whose `<view page="section"/>`
  shows the page a `<var name="section" start='"overview"'/>` names, the nav setting
  `section = Pages.Camera`. The address at `/run` follows it, as `/run/shell/camera`, and Back
  undoes each change. A page with no chrome is opened alone, `/run/kiosk`.
- Name each page as `Pages.Camera` wherever code opens it or a view shows it, never
  `Pages[name]`, so the editor links the pages. A tab bar takes `[Pages.A, Pages.B]` as options, and
  their names as `labels`.
- Read the project's `data/theme.toml` and use its tokens: `$ground` the page, `$surface` and
  `$panel` cards, `$panel2` and `$panel3` what sits on a card, `$text`, `$dim` and `$faint`,
  the `space`, `radius` and `text` sizes. Change the look there, never element by element,
  and add a token for any colour that means something new.
- Colour means state, the same on every page: `$green` running or good, `$amber` waiting or a
  warning, `$red` a fault or stop, `$accent` selected, with their `Bg` tokens behind them.
  Always with words beside it, never colour alone.
- Show state first: the machine's mode and faults where the eye lands, values large with
  their units, actions below them.
- Safety:
  - An action that moves a machine takes a hold to confirm, as `holdMs="600"`.
  - Jogging runs only while pressed: `press` starts it and `release` stops it, which a
    screen that drops runs too. Never a toggle for motion.
  - A control that cannot always act takes `enabled` in its style, as `enabled: Line.Ready`,
    so it is dimmed and takes no presses while it cannot, with the reason in words nearby.
- Keep logic in objects where it fits: a `<computed>` for a derived value, a `<record>` for a
  plot's history, an `<on>` with `every`, `when` or `change` for what must happen with no
  screen open. Page handlers are for what an operator does.
- To show a PointCloud, LaserScan, Path or Polyline, give it whole to a `points` part in a
  `<scene>`, as `points="Cell.Cloud"`, with `joined="true"` for a line, or `shape='"sphere"'`
  (`"dot"`, `"square"`, `"sphere"`, `"box"`) for lit dots. A Mesh goes to a `mesh`
  part and a Grid to a `grid` part. The GPU reads their bytes, so never unpack them in a
  computed value or a canvas. `field='"intensity"'` colours them from blue to red, and
  `range="[0, 255]"` sets its ends and hides what falls outside. A `floor` draws ground lines.
- A scene's parts take taps and drags as any element does, as a box picked by a tap. The scene
  hears only what its parts do not take, so a part with only a `tap` leaves drags to the camera.
- A choice for the machine is a `<var>` with `per="hmi"`. An operator's own, as a jog mode or
  a picked tab, is a `<var>` each screen keeps.
