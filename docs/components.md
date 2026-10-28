# Components

A component is a part made once and placed many times, as a gauge or a button. Its file is a
page with an interface first.

```html
<component name="Meter" size="24x16" sizing="fill">
  <prop name="value" default="0" type="number"/>
  <prop name="colour" default="$accent"/>
  <event name="change"/>
  <var name="peak" start="0"/>
  <span id="e1" name="reading" w="22" h="4" style="color: colour">value + "%"</span>
</component>
```

| Tag or attribute | Takes |
| --- | --- |
| `name` | its name in PascalCase, the tag an instance is written with |
| `size` | its size in units, as `24x16` |
| `sizing` | `fill` to lay it out in each instance's box, or `scale`, the default, to draw it whole scaled to the box |
| `<prop>` | an input an instance sets: `name`, `default`, `type` ([Input types](#input-types)), and `bindable="true"` to write back to what the instance binds it to |
| `<event>` | an event its code sends with `emit(name, value)`: `name` |
| `<var>` | each instance's own state on each screen: `name`, `start` as JSON |

Inside it, code reads its inputs and vars by name, and each part's `pressed`, `hovered` and
`heldFor` in ms by the part's name, `root` for the whole: `thumb.pressed ? $accent : $panel`.

## Placing one

```html
<Meter id="e3" name="Load" x="2" y="2" w="24" h="16" value="Line.Load">
  <on event="change">
    Line.Target = p;
  </on>
</Meter>
```

- Its inputs are attributes.
- The rest is CSS on its box, in `style`.
- A bindable input given a name, as `value="target"`, writes to that name when the component
  sets it.
- `<on event="change">` hears what the component sends, with the value in `p`.

## Input types

An input's `type` lists the types it takes, apart by spaces, as `type="Pose"` or
`type="number string"`. The editor then offers the component for each mesh member of one of
those types.

| Type | Takes |
| --- | --- |
| `number` | any number |
| `bool`, `string`, `enum`, `struct` | any of that kind |
| `f64`, `u8` and the other number kinds | that kind only |
| `Pose`, `Color`, an enum's name | that type, by its name on the mesh |
| any of these with `[]` | a list of it, as `number[]` or `Pose[]` |

## Standard components

A new project starts with these in `components/`. Each is a component like any other, so open,
restyle or copy it.

Views show a value:

| Component | Shows | Inputs |
| --- | --- | --- |
| `Readout` | a number with its unit, or text | `value` (number, string, enum), `label`, `unit`, `digits` |
| `Gauge` | a number on an arc | `value` (number), `min`, `max`, `unit`, `digits`, `alarm` |
| `Bar` | a number between two limits, filled from zero | `value` (number), `min`, `max` |
| `Bars` | a list of numbers, a bar each | `values` (number[]), `labels`, `min`, `max`, `unit`, `digits` |
| `Plot` | a record over time | `values`, `min`, `max`, `seconds` |
| `Lamp` | true or false | `value` (bool), `label` |
| `Joints` | a JointState's angles in degrees | `state` (JointState), `names` |
| `Pose` | a Pose's position, roll, pitch and yaw | `value` (Pose), `digits`, `angleDigits` |
| `Position` | 2D points or poses on a plane, y up | `value` (Double2, Float2, Int2, Pose2D, or a list), `min`, `max` |
| `Swatch` | a colour | `value` (Color, string), `label` |
| `Table` | a list of structs or lists | `rows` (struct[]), `columns`, `digits` |

Controls take input:

| Component | Does | Inputs | Sends |
| --- | --- | --- | --- |
| `Button` | a press, or a hold of `holdMs` | `text`, `holdMs` | `confirm` |
| `Toggle` | sets true or false | `value` (bool, bindable) | `change` |
| `Slider` | sets a number | `value` (number, bindable), `min`, `max`, `step` | `change` |
| `Knob` | sets a number | `value` (number, bindable), `min`, `max` | `change` |
| `Dropdown` | picks one of a list, showing `rows` at once | `value` (bindable), `options`, `rows` | `change` |
| `ModeSwitch` | picks one of a few side by side | `value` (bindable), `options` | `change` |
| `Joystick` | a stick | `travel`, `repeatMs` | `move` as it moves and `held` every `repeatMs`, each `{ x, y }` from -1 to 1, y up, then zeros on release |
| `Joystick1D` | a stick along one axis | `reach`, `repeatMs` | `move` and `held`, as `{ x }` |

Each also takes look inputs, as `fill`, `colour`, `textColour`, `textSize` and `radius`, each a
theme token when left out.
