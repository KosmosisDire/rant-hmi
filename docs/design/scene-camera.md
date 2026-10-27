# Moving a scene's camera

Asked 2026-10-27: pan a scene's camera with the middle button or two fingers. The user then
chose handlers over gestures built into the scene: a new scene starts with handlers that
move its camera, which the designer may change or remove, and the HMI brings enough of the
mouse and of touch for a designer to write them alike.

## What was missing

- A press began only for the left button, so a middle drag reached no handler.
- A press brought where it was, not which button or which keys were held.
- A scroll from a wheel and one from two fingers came alike, so a scene could not let fingers
  slide it while the wheel zoomed.
- Code had no size of the element to turn a move into metres by.

## Options

A. **Gestures built into the scene.** Least for the designer to write, but a second way to
   move the camera, state hidden per screen, and in the way of a designer's own drag. The
   visuals record left it out for that, and the user chose handlers again.

B. **Handlers the scene starts with.** The camera stays a matter of properties and handlers,
   as everything else that moves is. Chosen.

For where the view lives:

- **A variable each screen keeps**, on a page, and a component's own variable inside a
  component. Chosen. Other parts may read and set it too, as a button for a top view.
- A page's own variable. Pages have none by a settled rule, only components do.

## Decisions

- **`button` filter** on tap, press, release, hold, repeat and drag: `left` when left out, as a
  finger and a pen's tip press, `middle`, `right`, or `any`. A filter left out takes its
  default, which is `any` for every other filter. A filter set to its default is left out of
  the file, so two handlers never mean the same.
- **What a press brings** gains `button`, `shift`, `ctrl`, `alt`, and the element's `w` and `h`
  as its own x and y count. A drag keeps the button it began with.
- **`from` filter** on scroll and zoom: `wheel` (a mouse wheel, a trackpad's glide and pinch)
  or `fingers` (a touch screen). A wheel no scroll handler takes zooms, as before, so a scene
  whose scroll takes only fingers zooms by the wheel.
- **A new scene's view** is `sceneView`, or the scene's name before `View`, starting at the
  camera's defaults: `{ target, yaw, pitch, distance }`. Its camera properties read its fields.
- **Its handlers.** A drag with any button turns round the target with the left and slides
  with any other or Shift, a scroll from fingers slides, and a zoom divides the distance by its
  factor. A slide moves the target across and up the screen as far as the pointer went at the
  target's distance (the camera sees `2 tan(PI / 8)` of its distance across its height). A
  full turn takes the scene's width, half a turn its height, and the pitch stays within 1.5.
- **Two copies of the slide**, one in the drag and one in the scroll, since a project has no
  functions of its own yet.

## As built

- `server/src/events.rs`: `MOUSE` and `FROM`, `SettingInfo::takes`, `ANY` written to events.ts.
- `Handler::takes` and the client's `takes` read each filter's default. `Handler::set` leaves
  out a filter set to its default.
- `client/src/page/pointer.ts`: `w` and `h` in what a pointer brings, `buttonOf`, `keysHeld`.
- `client/src/page/scroll.ts`: what moved it, and the browser keeps fingers only off an
  element whose wheel handlers take no fingers.
- `client/src/screens/design/add.ts`: `addScene` and its handlers.
- Found on the way: the scene sent its worker what it read as it was, and a value from the
  store cannot be sent, so a camera or a pose read from a variable failed. It now sends plain
  copies.
- The reference names the two `button` filters by their senders.
