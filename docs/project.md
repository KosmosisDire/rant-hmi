# Project

A project is a folder of plain text files.

```
hmi.toml                 settings
objects/<name>.html      an object: what it uses on the mesh, its state and its logic
data/theme.toml          the theme's tokens
pages/<name>.html        a page
components/<name>.html   a component
files/                   models, pictures and fonts that pages load
```

A page or component file is named by its name in small letters and dashes: the page
`Robot cell` is `pages/robot-cell.html`.

## Objects

An object stands for one thing the HMI works with, as a line or a robot. It names what that
thing offers on the mesh, the state the HMI keeps for it, and its logic.

```html
<object name="Line" mesh="Line1" note="The packing line">
  <variable name="Speed" entity="Speed" intent="write"/>
  <topic name="Lidar" entity="/Lab/Lidar" rate="5"/>
  <function name="Reset" entity="Reset"/>
  <task name="Fill" entity="Fill"/>
  <var name="mode" start='"Auto"' per="hmi"/>
  <computed name="speedPercent" get="Speed * 100" target="Speed" set="v / 100" unit="%"/>
  <record name="speedHistory" source="Speed" every="100" keep="600"/>
  <fn name="restart" takes="speed">
    await Reset();
    Speed = speed;
  </fn>
  <on id="h1" name="Too fast" when="Speed > 1.5" for="2000">
    notify("The line runs too fast");
  </on>
</object>
```

Code elsewhere reads `Line.Speed` and calls `await Line.restart(1)`. The object's own code
reads its members bare, as `Speed`.

| Attribute | Is |
| --- | --- |
| `name` | its name, in PascalCase |
| `mesh` | the mesh path its members' entities count from, as `Line1`. Left out, they count from the mesh's root |
| `note` | what it is, for the editor |

### Members

Each member has a `name` of its own in the object. Mesh members are named in PascalCase, the
rest in camelCase.

| Member | Attributes | Is |
| --- | --- | --- |
| `<topic>` | `name`, `entity`, `intent`, `rate` | a topic on the mesh |
| `<variable>` | `name`, `entity`, `intent` | a variable on the mesh |
| `<function>` | `name`, `entity` | a function on the mesh |
| `<task>` | `name`, `entity` | a task on the mesh |
| `<var>` | `name`, `start`, `per` | state the HMI keeps |
| `<computed>` | `name`, `get`, `target`, `set`, `rate`, `unit`, `note` | a value worked out from others |
| `<record>` | `name`, `source`, `every`, `keep` | a value's history |
| `<fn>` | `name`, `takes` | a function of the object's own |
| `<on>` | see [Logic](#logic) | logic |

| Attribute | Of | Takes |
| --- | --- | --- |
| `entity` | mesh members | the entity, from the object's `mesh`, or from the mesh's root when it starts with `/`. Name it as `rant ls entities` shows it |
| `intent` | topics, variables | `write` to set the variable or send on the topic. Read only when left out |
| `rate` | topics | the most values a second it takes, best effort |
| `start` | `<var>` | its first value, as JSON: `'"Auto"'`, `0`, `[]` |
| `per` | `<var>` | `hmi` for one value every screen shares. Left out, each screen keeps its own |
| `get` | `<computed>` | an expression, as `Speed * 100` |
| `target`, `set` | `<computed>` | the member a write to it sets, and to what: an expression of the new value `v`. Left out, it is read only |
| `rate` | `<computed>` | the most times a second it is worked out, from 1 to 30, and 30 when left out. Each time may run as long as the time between two |
| `unit`, `note` | `<computed>` | the unit shown after its value, and what it means |
| `source` | `<record>` | the expression it samples |
| `every`, `keep` | `<record>` | how often it samples in ms, and how many seconds it keeps each sample. It reads as a list of `{ t, v }`, oldest first |
| `takes` | `<fn>` | the names of what a call passes, in order. Its body gives back what it returns |
| `local` | every member | `true` to keep it to the object's own code. Pages and other objects read only the rest |

### Logic

An `<on>` in an object runs its code whether or not a screen is open. Each has an `id` unique
across the project, a `name`, and one of these:

| Attribute | Runs its code | `p` holds |
| --- | --- | --- |
| `every="1000"` | every so many ms | nothing |
| `when="Speed > 1.5"` | as the condition turns true, or with `for="2000"` once it has held that long. `rate` sets how often it is judged, as a `<computed>`'s does | nothing |
| `change="Speed"` | when a member changes | `value` and `previous` |
| `start=""` | once, as the HMI starts | nothing |
| `screen="connects"` | when a screen connects | `screen`, its number |
| `screen="leaves"` | when a screen is lost | `screen` |

`start` and `screen` logic go only in the `Hmi` object.

### The Hmi object

Every project has `Hmi`. It holds what is about the HMI as a whole:
logic on starting and on screens, state for the whole HMI, and the HMI's own status as
`Hmi.Clients`, `Hmi.Status` and `Hmi.Problems` ([Status](status.md)).

## Settings

`hmi.toml`:

```toml
name = "Line"
start = "overview"
```

| Key | Takes |
| --- | --- |
| `name` | the project's name |
| `start` | the page screens open on, by its file name. The first page when left out |
| `[[ice]]` | a STUN or TURN server for WebRTC ([Deploy](deploy.md#networks)) |

## Theme

Each `[[token]]` in `data/theme.toml` is a value pages read as `$name`:

```toml
[[token]]
name = "accent"
dark = "#ff8800"
light = "#0088ff"
```

| Key | Takes |
| --- | --- |
| `name` | its name, in camelCase |
| `dark` | its value in dark mode: a colour, a number or text. It may read other tokens and the [math](code.md#colours), as `$accent.alpha(0.15)` |
| `light` | its value in light mode. Left out, the dark value is used, worked out with the light tokens |

A handler switches its screen between them with `theme.toggle()` or `theme.set("light")`.

A new project starts with these tokens:

| Kind | Tokens |
| --- | --- |
| Backgrounds | `ground` the page, `surface` and `panel` cards, `panel2` and `panel3` what sits on a card |
| Lines | `border`, `border2` |
| Text | `text`, `dim` labels, `faint` hints, `onFill` text on a coloured fill |
| State | `green` running or good, `amber` waiting or a warning, `red` a fault or stop, `accent` selected, each with a `Bg` token to go behind it |
| Colours | `gray`, `blue`, `purple` |
| Corners | `radiusSmall`, `radius`, `radiusLarge`, `radiusPill` |
| Spacing | `spaceSmall`, `space`, `spaceLarge` |
| Text sizes | `textSmall`, `textSize`, `textLarge` |

## Files

A model, a picture or a font goes in `files/`, and a page names it by its path from the
project: `src="files/cell/arm.glb"` on a model, `src="files/logo.png"` on media,
`background: "url(files/plan.png)"`.
