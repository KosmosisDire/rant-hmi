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
- The ramp is turbo, as robotics tools colour intensity and height.
- A cloud's `rgb` or `rgba` field colours it when `color` is left out, packed as PCL packs it.
- `floor`, not "floor grid": a tag is one word.

## How it stays fast

The page never holds a cloud. Each list in an import's value already stays in the data worker
under a ref, and the page holds a stand in of its length (`data-paths.md`). The page reads a
cloud's small parts, its fields, step and origin, and hands the worker the ref of its bytes.

- The worker reads a new cloud in one pass into a positions array, and colours or ramp values
  when shown, computing the bounds on the way, as three.js should be given them.
- It reads x, y and z straight from the bytes as 32 bit floats when they are, a word at a time,
  and through a DataView for any other kind.
- Buffers are kept while the count holds, and written in place, so a lidar at 10 Hz makes no
  garbage and no new GPU buffer.
- A 2D grid is one texture on one square, a pixel a cell. A 3D grid is one instanced mesh of
  cubes, an instance per cell in range.
- A mesh's triangles go to the GPU as they come, an index of 32 bit numbers.
- Nothing is read again unless the value it came from is new.

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
