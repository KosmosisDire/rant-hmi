# Math

Pages, handlers and computed values share one math library (`client/src/lang/math.js`). The
backend runs the same file.

## Functions

[reference.md](reference.md#code) lists every function and name code reads, and where. Angles
are in radians, and the natural log is `ln`, since `log` writes to the handler's log.

A project's own name hides one of these, so no import or variable may take one. A
component's input may, as a knob's `min` and `max`: the plain name is the input, and a call
such as `max(a, b)` is always the function.

## Time

`time.now` is the clock in ms since 1970, as `Date.now()` gives it. What a screen shows with it
moves each frame, and only while something shows it:

```js
Math.floor(time.now / 500) % 2 ? $red : $panel     // on and off each half second
(time.now / 1000 * Belt.speed) % 4                // a slat moving along the belt
new Date(time.now).toLocaleTimeString()            // the screen's clock
```

- Every value drawn in one frame reads the same time, so things move together.
- Code on the system reads the time when it runs. A computed value or a condition there is
  worked out as its other values change, never by the clock alone.

## The link

`link` is the screen's link to the system. Only what runs on a screen reads it: an element's
properties and a component's handlers.

- `link.open`: true while the screen's socket to the system is up.
- `link.webrtc`: true while its WebRTC connection is open too.
- `link.pingMs`: the round trip in whole ms, smoothed, as the status bar shows it. Null before
  the first one and while the socket is down.

```js
link.open ? "" : "No link to the system"          // a banner's text
link.pingMs === null || link.pingMs > 200 ? $amber : $green
```

- The system's code has no `link`, since it serves every screen. Its `Hmi/Clients` topic lists
  each screen's link ([status.md](status.md)).
- A token, an input's default and a variable's start read the same on every screen, so they
  cannot read it either.

## Keys and gamepads

What a screen draws reads its own input too, as `link` is read. Handlers hear it as events
([files.md](files.md)).

- `keys` holds each key held, true by what it types and by where it sits: `keys.a`,
  `keys.KeyA`, `keys.Space`, `keys.Shift`. A key typed into a field is held by none.
- `gamepads[0]` is the first pad, null where none is: its `name`, `lx`, `ly`, `rx`, `ry` from
  -1 to 1 with each y up, `lt` and `rt` from 0 to 1, every axis in `axes`, and `buttons`, each
  true while down, as `buttons.south`. They are as the pad gives them, with no deadband.

```js
keys.Space ? $amber : $panel                        // a lamp lit while Space is held
gamepads[0] ? gamepads[0].lx * 10 : 0              // a dot that follows the left stick
```

## Vectors, quaternions and poses

A value is one by its fields, so values from the mesh need nothing done to them:

- 2D vector: `{ x, y }`
- 3D vector: `{ x, y, z }`
- quaternion: `{ x, y, z, w }`
- pose: `{ position, orientation }`

`+ - * /` work on them as on numbers:

```js
(Goal.position - Pose.position).length()
Ft.force * 2
Pose.orientation * vec(1, 0, 0)   // a quaternion turns a 3D vector
Pose * vec(0, 0, 0.1)             // a pose moves a point
Pose * Tool                       // poses combine
"at " + vec(1, 2)                 // "at (1, 2)"
```

- Vectors add and subtract one of their own size. They multiply and divide by a number, or by a
  vector of their size, part by part.
- A 2D and a 3D vector never mix: the code stops and says so.

## Colours

A colour is text such as `"#2a6fd6"`, or `"#2a6fd680"` with its alpha, and a bare `#2a6fd6` in a
page reads as one. Theme tokens are colours too.

```js
#224493.lighten(0.2)              // a fifth of the way to white
$accent.darken(0.3)
$accent.alpha(0.15)               // see through, as a selection's tint
$panel.fade(0.5)                  // its alpha halved
$accent.mix($red, 0.5)            // halfway to another colour
#229834 * 1.2                     // brighter, and * 0.8 darker
$text * $accent                   // each channel by the other's
```

- `lighten`, `darken` and `mix` go through OKLab, where an even step looks even and a hue holds.
- A number times a colour scales its red, green and blue, its alpha kept.

## Methods

| Value | Methods |
| --- | --- |
| vector | `length() normalized() dot(v) cross(v) distance(v) lerp(v, t) equals(v)` |
| quaternion | `rotate(v) inverse() normalized() euler() equals(q)` |
| pose | `apply(v) inverse()` |
| colour | `lighten(t) darken(t) alpha(a) fade(k) mix(c, t)` |

- `euler()` gives `{ roll, pitch, yaw }` in radians.
- A 2D `cross` is a number: how far the second turns from the first.

## Good to know

- `==` compares two vectors as the same value only when they are one value. Use `a.equals(b)`.
- After a `?.`, wrap the chain before a method: `(Ft?.force).length()`.
