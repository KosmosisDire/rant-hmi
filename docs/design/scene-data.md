# Rant's data in a scene

Asked 2026-10-30, once Rant 0.0.39 gave point clouds, meshes and grids standard types: make
it easy to show them in a scene, and fast.

## What a scene had

`points` drew a list of x, y and z points. Odometry, a detection's box and a ray already show
through code (`pose="Robot.Odom.pose.pose"`, a box's `pose` and `size` from `bounds`, an arrow
from `origin` along `direction`). What no part read:

- PointCloud: points packed as bytes in the PCL layout, a field list saying where each value
  sits.
- Mesh: a PointCloud of vertices and a list of triangles.
- Grid: one block of bytes per field, a number per cell.
- LaserScan: ranges by angle. Path and Polyline: a list of poses or points.

## Decisions

The user's, 2026-10-30:

- **`points` takes them** (over a part per type): a PointCloud, a LaserScan, a Path or Path2D,
  a Polyline or Polyline2D, as well as a list. `joined` still picks dots or a line.
- **`grid` draws a Grid**, and the floor lines it drew become `floor`.
- **`field` and `range` colour by a value** (over low and high colours, or code alone): `field`
  names a number each point or cell has, `range` its low and high ends, the data's own when left
  out. Colours run along one ramp, and a value outside `range` is not drawn, so a map's
  unknown -1 cells stay empty.
- **A `mesh` part** draws a Mesh.
- **Fast**, asked while planning.

Claude's:

- A value is known by its shape, as `joints` knows a JointState: a PointCloud has `fields`,
  `point_step` and `data`, a LaserScan `ranges` and `angle_step`, a Path `poses`, a Polyline
  `points`.
- Every point has `x`, `y` and `z` for `field`, so height is `field="z"`. A cloud's points have
  its own fields too, a list's its records' numbers, a scan's `range` and `intensity`.
- The ramp is turbo, as robotics tools colour intensity and height, from its tenth to its ninth
  tenth, blue to dark red: its ends are near black and vanished on a dark scene.
- A cloud's `rgb` or `rgba` field colours it when `color` is left out, packed as PCL packs it.
- `floor`, not "floor grid": a tag is one word.

## How it stays fast

A big value comes through the data worker, which keeps each list in it under a ref and hands the
page a stand in of its length (`data-paths.md`). A cloud's `data` is bytes, not a list, and bytes
went to the page whole and were not kept. Now the worker keeps a value's bytes too and hands the
page a copy marked with their ref. A value of bytes and no lists still goes whole, as before, so
a picture or a video frame reads as it did, and only lists make a value far. The copy is made in
the worker, off the page's thread. The page reads a cloud's small parts and hands the worker
the ref of its bytes, which the worker reads beside the fields that hold them.

A small value comes on the page's own socket and has no ref. Its points are laid out on the page
by the same readers (`net/spread.ts`, no three.js in it) and sent to the worker as arrays, as a
small list's points always were.

- The worker reads a new cloud in one pass into a positions array, and colours or ramp values
  when shown, computing the bounds on the way, as three.js should be given them.
- It reads x, y and z straight from the bytes as 32 bit floats when they are, a word at a time,
  and through a DataView for any other kind.
- Points that are not finite, and those outside `range`, are left out in that pass, so they cost
  the GPU nothing.
- A part keeps its arrays and its GPU buffers, written in place while the count fits and only
  made again when it grows, so a lidar at 10 Hz makes no garbage and no new buffer.
- A 2D grid is one texture on one square, a pixel a cell. A 3D grid is one instanced mesh of
  cubes, an instance per cell in range.
- A mesh's triangles go to the GPU as they come, an index of 32 bit numbers.
- Nothing is read again unless the value it came from is new.

Points with no z now lie at z 0, so a Path2D, a Polyline2D and a list of Double2 draw.
`run-big-import-edit` read a cloud without z to see the page sent fewer fields, and expected the
scene to refuse it. It now checks that they draw flat.

## Steps

1. `grid` becomes `floor`.
2. `points` takes a PointCloud, LaserScan, Path and Polyline, and `field` and `range`.
3. `mesh`.
4. `grid` for a Grid.

Each step has a scenario drawing it from the demo line, which publishes a cloud, a scan, a
path, a mesh and a map.

## Later

The `draw` part (`draw.md`), not built, would draw from the same readers: a cloud, a mesh and a
grid read once in the worker, whichever part or call draws them.
