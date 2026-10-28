# Events

An element hears an event through an `<on>` inside it, holding the code to run. The code reads
what the event brings as `p`.

```html
<div id="e1" name="Jog" w="12" h="6">
  <on event="press">
    Robot.Jog = 1;
  </on>
  <on event="release">
    Robot.Jog = 0;
  </on>
</div>
```

A drag's `p.dx` and `p.dy` count as the element's own `x` and `y` do, so
`puckX = puckX + p.dx` makes an element at `x="puckX"` follow the pointer.

## Settings

A setting is an attribute of the `<on>`, an expression, as `after="800"` on a `hold`. The
tables below show each with its default.

- A filter takes only the events that bring its value, as `key="a"` or `button="right"`. One
  with no default takes any.
- `while="condition"` hears its event only while the condition is true.
- A `release`, `keyup`, `buttonup` or last `axes` that comes some other way than a let go, as
  the page closing, has `p.lost` true.

## All events

<!-- events: written by the backend's tests from server/src/events.rs -->

### Pointer

| Event | When | Settings |
| --- | --- | --- |
| `tap` | Pressed and let go on it. | `button="left"` |
| `press` | Pressed down. Ends with `release`. | `button="left"` |
| `release` | Let go, anywhere. Ends a `press`. | `button="left"` |
| `hold` | Held down a while. | `button="left"`, `after="500"` |
| `repeat` | Again and again while pressed. | `button="left"`, `every="100"` |
| `drag` | Moved while pressed. | `button="left"` |
| `outside` | A press anywhere else. |  |

Its `p` holds:

| Field | Is |
| --- | --- |
| `x` | across it, 0 to 1 |
| `y` | down it, 0 to 1 |
| `angle` | degrees around its centre, 0 up |
| `on` | the part pressed, by name |
| `inside` | true while over it |
| `button` | "left", "middle" or "right", a finger and a pen's tip left |
| `shift` | true while Shift is down |
| `ctrl` | true while Ctrl is down |
| `alt` | true while Alt is down |
| `w` | its width, as its own x counts |
| `h` | its height, as its own y counts |
| `dx` | `drag` only: how far it moved across since the last, as its own x counts |
| `dy` | `drag` only: how far it moved down since the last, as its own y counts |

`button` is one of:

| Value | Is |
| --- | --- |
| `left` | the main button, a finger or a pen |
| `middle` | the wheel pressed |
| `right` | the second button |
| `any` | every button |

### Wheel and pinch

| Event | When | Settings |
| --- | --- | --- |
| `scroll` | Scrolled over it. | `from` |
| `zoom` | Pinched or zoomed over it. | `from` |

Its `p` holds:

| Field | Is |
| --- | --- |
| `x` | across it, 0 to 1 |
| `y` | down it, 0 to 1 |
| `on` | the part under it, by name |
| `from` | "wheel" or "fingers" |
| `w` | its width, as its own x counts |
| `h` | its height, as its own y counts |
| `dx` | `scroll` only: how far across, as its own x counts |
| `dy` | `scroll` only: how far down, as its own y counts, below 0 as a wheel turns down |
| `factor` | `zoom` only: how much bigger, below 1 smaller |

`from` is one of:

| Value | Is |
| --- | --- |
| `wheel` | a mouse wheel or a trackpad |
| `fingers` | fingers on a touch screen |

### Entry

| Event | When | Settings |
| --- | --- | --- |
| `change` | A value entered. |  |

Its `p` holds:

| Field | Is |
| --- | --- |
| `value` | what was entered |

### Keyboard

| Event | When | Settings |
| --- | --- | --- |
| `keydown` | A key pressed. Ends with `keyup`. | `key`, `code` |
| `keyup` | A key let go. Ends a `keydown`. | `key`, `code` |
| `keyrepeat` | Again and again while a key is down. | `key`, `code`, `every="100"` |

Its `p` holds:

| Field | Is |
| --- | --- |
| `key` | what it types, as "a" or "Enter" |
| `code` | where it sits, as "KeyA" |
| `shift` | true while Shift is down |
| `ctrl` | true while Ctrl is down |
| `alt` | true while Alt is down |

### Gamepad

| Event | When | Settings |
| --- | --- | --- |
| `buttondown` | A gamepad button pressed. Ends with `buttonup`. | `button`, `pad` |
| `buttonup` | A gamepad button let go. Ends a `buttondown`. | `button`, `pad` |
| `axes` | A gamepad's sticks or triggers moved. Comes once more at rest, its numbers 0. | `pad`, `deadband="0.1"` |

Its `p` holds:

| Field | Is |
| --- | --- |
| `button` | `buttondown` and `buttonup` only: which, by where it sits, as "south" |
| `pad` | which pad, 0 for the first |
| `lx` | `axes` only: the left stick across, -1 to 1 |
| `ly` | `axes` only: the left stick up, -1 to 1 |
| `rx` | `axes` only: the right stick across, -1 to 1 |
| `ry` | `axes` only: the right stick up, -1 to 1 |
| `lt` | `axes` only: the left trigger, 0 to 1 |
| `rt` | `axes` only: the right trigger, 0 to 1 |
| `axes` | `axes` only: every axis as the pad gives it, down positive |

`button` is one of:

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

`pad` is one of:

| Value | Is |
| --- | --- |
| `0` | the first |
| `1` | the second |
| `2` | the third |
| `3` | the fourth |

<!-- end events -->
