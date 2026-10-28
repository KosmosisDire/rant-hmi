# Code

Code is JavaScript. A property's value is an expression, as `Line.Speed * 100`. A handler, an
object's `<fn>` and logic, and a canvas's draw are statements.

## Names

| Name | Is |
| --- | --- |
| `Line` | an object, by its name |
| `Line.Speed` | a member of it. The object's own code reads it bare, as `Speed` |
| `$accent` | a theme token |
| `JobState` | a mesh enum, by its type's name. `JobState.options` lists the names it takes |
| `p` | in a handler, what its event brings ([Events](events.md)) |
| `index`, `item` | in an element with `repeat`, its copy's number and item |
| `expanded` | a `<var>` on the element or what holds it |
| `value` | in a component, an input or a `<var>` |
| `thumb.pressed` | in a component, a part's `pressed`, `hovered` and `heldFor` in ms, by the part's name. `root` is the whole |

## Actions

Handlers, functions and logic act with these:

| Code | Does |
| --- | --- |
| `Line.Speed = 0.5` | sets a member or state, as `jog[index] = 1` sets one item |
| `await Line.Reset()` | calls a function and gives its answer |
| `Line.Jog.send({ x: 1, y: 0 })` | sends on a topic |
| `await Line.Fill(5, (p) => { filled = p })` | runs a task. The last function takes each progress update |
| `run.cancel()` | stops the task call `run`, as `const run = Line.Fill(5)` gave it |
| `Line.Fill.cancel()` | stops every call of the task |
| `await open(Pages.Confirm)` | opens a page and gives what it passes to `close(answer)` |

A stopped task call fails with `e.status` `"cancelled"`.

## Functions and values

<!-- names: written by the backend's tests from client/src/lang/api.js -->

### Read everywhere

| Name | Is |
| --- | --- |
| `sqrt(x)` | square root |
| `abs(x)` | without its sign |
| `sign(x)` | -1, 0 or 1 |
| `min(...values)` | the least |
| `max(...values)` | the most |
| `clamp(x, low, high)` | x kept between low and high |
| `lerp(a, b, t)` | from a toward b by t, numbers or vectors |
| `round(x)` | the nearest whole number |
| `floor(x)` | the whole number at or below |
| `ceil(x)` | the whole number at or above |
| `trunc(x)` | the whole part |
| `pow(x, y)` | x to the power y |
| `exp(x)` | e to the power x |
| `ln(x)` | natural log |
| `sin(radians)` | sine |
| `cos(radians)` | cosine |
| `tan(radians)` | tangent |
| `asin(x)` | in radians |
| `acos(x)` | in radians |
| `atan(x)` | in radians |
| `atan2(y, x)` | the angle of y and x, in radians |
| `hypot(...values)` | the length of its arguments |
| `degrees(radians)` | radians as degrees |
| `radians(degrees)` | degrees as radians |
| `PI` | half a turn, in radians |
| `vec(x, y, z?)` | a 2D or 3D vector |
| `fromEuler(roll, pitch, yaw)` | a quaternion from roll, pitch and yaw in radians |
| `mix(a, b, t)` | a colour from a toward b by t |
| `time` | the clock |
| `time.now` | ms since 1970, moving where it shows |

### Read in a page's handlers

| Name | Is |
| --- | --- |
| `notify(text)` | tell this screen |
| `log(...values)` | write to the log |
| `sleep(ms)` | wait ms |
| `open(page, options?)` | open a page, its answer when it closes |
| `close(answer?)` | close the top page |
| `Pages` | each page by name, to open |

### Read in a component's handlers

| Name | Is |
| --- | --- |
| `emit(event, value?)` | send an event out |

### Read in what a screen draws and a component's handlers

| Name | Is |
| --- | --- |
| `link` | this screen's link to the system |
| `link.open` | true while the screen reaches the system |
| `link.webrtc` | true while its WebRTC connection is open too |
| `link.path` | the way values, pings and actions go, "channel" on WebRTC or "socket" |
| `link.pingMs` | the round trip in ms, smoothed, null before one |
| `keys` | the keys held, each true by what it types or where it sits, as keys.a or keys.KeyA |
| `gamepads` | the gamepads, gamepads[0] the first, null where none is |

### Read in what a screen draws, a page's handlers and a component's handlers

| Name | Is |
| --- | --- |
| `theme` | this screen's light or dark mode, which picks each token's value |
| `theme.mode` | "dark" or "light", as the screen draws now |
| `theme.set(mode)` | draw in "dark" or "light", or "device" to follow the device's own, kept on the device |
| `theme.toggle()` | draw in the other mode, kept on the device |

### JavaScript's own

| Name | Is |
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

## Time

`time.now` is the clock in ms since 1970. What a screen shows with it moves each frame:

```js
Math.floor(time.now / 500) % 2 ? $red : $panel     // on and off each half second
(time.now / 1000 * Belt.Speed) % 4                // a slat moving along the belt
new Date(time.now).toLocaleTimeString()            // the screen's clock
```

## Keys, gamepads and the link

What a screen draws reads its own keys, gamepads and link:

```js
keys.Space ? $amber : $panel                       // lit while Space is held
gamepads[0] ? gamepads[0].lx * 10 : 0             // follows the left stick
link.open ? "" : "No link to the system"          // a banner's text
```

`gamepads[0]` holds `name`, `lx`, `ly`, `rx`, `ry` from -1 to 1 with each y up, `lt` and `rt`
from 0 to 1, every axis in `axes`, and `buttons`, each true while down, as `buttons.south`.

## Vectors, quaternions and poses

A value is one by its fields, so values from the mesh need nothing done to them:

| Value | Fields |
| --- | --- |
| 2D vector | `{ x, y }` |
| 3D vector | `{ x, y, z }` |
| quaternion | `{ x, y, z, w }` |
| pose | `{ position, orientation }` |

`+ - * /` work on them as on numbers:

```js
(Goal.position - Robot.Pose.position).length()
Ft.force * 2
Robot.Pose.orientation * vec(1, 0, 0)    // a quaternion turns a 3D vector
Robot.Pose * vec(0, 0, 0.1)              // a pose moves a point
Robot.Pose * Tool                        // poses combine
"at " + vec(1, 2)                        // "at (1, 2)"
```

Vectors multiply and divide by a number, or part by part by a vector of their size.

## Colours

A colour is text such as `"#2a6fd6"`, or `"#2a6fd680"` with its alpha. A bare `#2a6fd6` reads
as one, and tokens are colours too.

```js
$accent.lighten(0.2)           // a fifth of the way to white
$accent.darken(0.3)
$accent.alpha(0.15)            // see through, as a selection's tint
$panel.fade(0.5)               // its alpha halved
$accent.mix($red, 0.5)         // halfway to another colour
#229834 * 1.2                  // brighter, and * 0.8 darker
```

## Methods

| Value | Methods |
| --- | --- |
| vector | `length()` `normalized()` `dot(v)` `cross(v)` `distance(v)` `lerp(v, t)` `equals(v)` |
| quaternion | `rotate(v)` `inverse()` `normalized()` `euler()` `equals(q)` |
| pose | `apply(v)` `inverse()` |
| colour | `lighten(t)` `darken(t)` `alpha(a)` `fade(k)` `mix(c, t)` |

- `euler()` gives `{ roll, pitch, yaw }` in radians.
- A 2D `cross` is a number: how far the second turns from the first.
- `a.equals(b)` compares two vectors or quaternions.
