# 3D components and picking

Asked 2026-11-10: components made of 3D parts, placed in a scene many times with inputs of
their own, as prefabs of a 3D scene are. The user then asked that every 3D part take events,
as a gizmo that moves a robot's end effector, a box tapped to select it, or a 3D hold button,
and that 3D components send events of their own.

## What was missing

- A component was always a page: its parts are page elements and an instance a box.
- A scene held only 3D parts, so an instance in one was refused.
- A 3D part took no events. A press on a scene was the scene's alone.

## Options

How a component says it is 3D:

A. **An attribute**, `space="3d"`, chosen when it is made. Chosen by the user.
B. From what it holds. An empty component would have no kind, and a first part would set it.

How its board shows in the Design tab, where scenes stand still:

A. **A scene the editor turns** by a drag on the board, with a floor and axes of the editor's
   own, the view never saved. Chosen by the user.
B. A camera saved in the component, set in the inspector, the board still.

How a hit is found:

A. Three.js's raycaster on the CPU. Points, voxels and dots are drawn by shaders of our own, so
   it would miss what the screen shows, and a million points cost a pass of their own.
B. An id texture drawn with every frame, as the user put it. WebGL2 cannot multisample an
   integer target, so it cannot ride along the main pass, and it would cost every frame.
C. **An id pass drawn only when a pointer needs a hit**, one pixel under it, through each part's
   own shaders. What is hit is what shows, and a frame no pointer needs costs nothing. Chosen.

Whether a scene still hears an event a part takes:

A. **A part takes it.** Per event: the scene hears an event only when no 3D part under the
   pointer, nor what holds it, handles it. A box with only a tap still lets a drag turn the
   camera. Among parts, events go out to what holds them as on a page. Chosen by the user.
B. Both hear it, as on a page, and the scene's handlers skip a press on a part themselves.

## Decisions

- A 3D component holds 3D parts only, and goes only in a scene or an anchor. A 2D one never
  goes in a scene.
- An instance in a scene is a part: a `pose`, its inputs, and `repeat`. Its parts count from
  its pose, as an anchor's do. One whose pose is unknown draws nothing.
- "Convert to component" on 3D parts makes a 3D component.
- A 3D event brings what a 2D one does that still means something, as `on`, `inside`,
  `button` and the keys, and `ray`, a Ray from the camera through the pointer, `point`, where
  it hit, and `index`, the point of a `points` part hit.
- `ray` and `point` count in the frame of the file the handler is in: the scene's on a page,
  the instance's in a component. A component never knows where it was placed, so a Gizmo
  sends positions in its own terms.
- `x`, `y`, `angle`, `w`, `h`, `dx` and `dy` on a 3D part measure its scene's box, so a turn
  by a drag reads as it does on the scene.
- A 3D component keeps its `size` as the size of its board in the Design tab, and takes no
  `sizing`, since it has no box to fit.

## As built

1. **Backend.** `Interface.space`, `"2d"` or `"3d"`, written `space="3d"`. Where an element goes
   is `Element::home`, its component's space for an instance, and a page's own is `Page::home`.
   Every edit that places an element checks by them. A 3D instance writes every property as
   an attribute. `IN_SCENE` in `events.rs` lists what a 3D event brings besides.
2. **Drawing.** `PartView` in `client/src/page/scene.tsx` draws an instance as an anchor at its
   pose, holding its component's parts read in the component's scope. The worker needed
   nothing new. A part drawn inside an instance lists no robots in the editor, since its id
   is the component's. Scenario `design-scene-component`.
3. **Picking.** Every material in a scene is wrapped once, in `pickable` in `net/draw.ts`: its own
   main runs, and while `PICKING` is on a fragment it keeps writes its part's number, the point
   or cell it shows and its depth into one float pixel. No two parts share a material, so the
   part is the material's uniform: a model copies its file's materials and keeps a ghost of its
   own. A pick draws the scene again through a view offset of one pixel, the dots sized for it.
   The worker tells the page its camera as it moves, and the page works out the ray through any
   pointer from it at once, while the point and the part come from the pick a frame late.
   `usePress` takes a `Place`, which measures a 3D part's press across its scene, and a `Gate`,
   with which a scene's press waits for the pick and skips what a part takes. A pick happens only
   on a scene with a part that takes the pointer. Scenario `run-scene-picking`.

   Found on the way: the canvas takes no pointer events, so the scene listens on its own
   element as the press goes down. A press always begins with a drag of 0, so a click on a part
   without a drag handler turns the scene's drag once, as on a page.

   Left for later: a part's `outside` is a press outside its scene, a wheel and two fingers stay
   the scene's, and a mesh does not say which triangle a pick met.

## Open

- Parts kept one size on the screen, as a gizmo's handles are.
- Parts drawn over all others.
