# Math

Pages, handlers and computed values share one math library (`client/src/lang/math.js`). The
backend runs the same file.

## Functions

| Name | Gives |
| --- | --- |
| `sqrt abs sign min max` | as `Math` has them |
| `round floor ceil trunc` | a whole number |
| `pow exp ln` | powers and the natural log. `log` stays the handler's logging |
| `sin cos tan asin acos atan atan2 hypot` | in radians |
| `degrees(r) radians(d) PI` | turning between the two |
| `clamp(x, low, high)` | `x` kept between the two |
| `lerp(a, b, t)` | from `a` toward `b`, numbers or vectors |
| `vec(x, y)`, `vec(x, y, z)` | a 2D or 3D vector |
| `fromEuler(roll, pitch, yaw)` | a quaternion, in radians |
| `mix(a, b, t)` | a colour from `a` toward `b` |

A project's own name hides one of these, so no import or variable may take one.

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
