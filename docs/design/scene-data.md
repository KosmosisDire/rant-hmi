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
- **Read on the GPU**, asked once the four steps were built: a value's bytes go to the GPU as
  they came and the shader reads its numbers, over reading them in the worker into arrays. On
  this branch, before review.
- **A mesh with no normals is lit smooth**, its normals summed on the GPU, over facets or a sum
  on the CPU.
- **Voxels by marching rays** through them, kept only if they draw faster than cubes.

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
- A fault about `field` is the field's own, `cloud: field: the cloud has no number field nope`.
- A mesh keeps every vertex, as its triangles count them, and leaves out a triangle with a
  vertex outside `range`. Its normals are its `normal_x`, `normal_y` and `normal_z` fields, as
  PCL names them, or else worked out from the triangles round each vertex, each by its area.
- A line through points breaks where one is not drawn, where it was joined across before: a
  segment reads both its ends, so one left out takes both its segments.
- A cloud's points over 255 bytes apart say so, as WebGL reads a vertex's numbers no further.
- A mesh is lit from both sides, as a scanned surface is seen from under it too. `mesh="null"`
  draws none, as a model's `src=""` does.
- A grid's `field` names one of its fields, its first when left out, as a map's occupancy
  usually is. The page knows the names, so it says when there is no such field.
- A flat grid is a picture, unlit so its colours read true, a cell a square with no blending
  between them, and drawn a little behind its plane so a `floor` on it still shows. A deep grid
  is lit cubes. A grid wider than the screen's largest texture says so rather than draw wrong.

## How it stays fast

A big value comes through the data worker, which keeps each list in it under a ref and hands the
page a stand in of its length (`data-paths.md`). A cloud's `data` is bytes, not a list, and bytes
went to the page whole and were not kept. Now the worker keeps a value's bytes too and hands the
page a copy marked with their ref. A value of bytes and no lists still goes whole, as before, so
a picture or a video frame reads as it did, and only lists make a value far. The copy is made in
the worker, off the page's thread. The page reads a cloud's small parts and hands the worker
the ref of its bytes, which the worker reads beside the fields that hold them.

A small cloud or scan comes on the page's own socket and has no ref. The page sends its bytes
and numbers as they came, and the worker reads them as it reads a big one. A list is laid out on
the page as each point's x, y and z.

Points are read on the GPU (`net/spread.ts` says where each number sits, `net/draw.ts` reads it):

- A cloud's bytes, a scan's ranges and a list's columns go to the GPU as they came, a buffer
  each. The shader reads each number by its kind, offset and stride, four bytes at a time as
  WebGL hands them, eight for F64, I64 and U64, at any offset. Every ScalarKind draws as its F32
  twin does, pixel for pixel.
- A scan's returns are placed by their beam's angle in the shader.
- Points that are not finite, and those outside `range`, are put past the far plane by the
  shader. Each costs a vertex, which is nothing to a GPU at 1M.
- `range` is a uniform, so a new one draws again with nothing read. A new `field` reads another
  offset of the same bytes.
- A `range` left empty takes the values' own ends, read on the CPU once a value: the one read
  left, 5 ms for 1M points.
- A line is drawn as segments, an instance each that reads a point and the next.
- New bytes of the same layout and length are written into the buffer they replace, so a lidar
  at 10 Hz makes no new one.
- A 2D grid is one texture on one square, a pixel a cell. A 3D grid is one instanced mesh of
  cubes, an instance per cell in range.
- A mesh's triangles go to the GPU as they come, an index of 32 bit numbers.
- Nothing is read again unless the value it came from is new.

A mesh never comes as code, only from the mesh, so a small one's vertices, bytes and triangles
go to the worker as they came, and it reads them as it reads a big one. A grid is the same. Its
fields are records with names, never a list the worker marks, so even a big one comes to the
page whole, its bytes copied and marked. The page picks the field and hands the worker that
field's ref, and the worker reads the grid's other numbers beside it, from the same value. Points may be written in
code, which only the page reads, so a small cloud is laid out there instead. three.js takes a
vertex's colour as linear light, so a mesh's sRGB colours go through a table of 256.

Measured in Chrome on an RTX 4080 laptop GPU: the worker's time from a new value to its draw
sent, which holds back every scene and the values coming in, before and after reading on the GPU,
and the frame after, all medians of 10:

| Value | Before | After | Frame |
| --- | --- | --- | --- |
| A cloud of 1M points, x, y and z, 16 bytes a point | 15 ms | 2 ms | 2 ms |
| The same along the ramp by intensity, its own ends | 66 ms | 10 ms | 5 ms |
| The same cut to a range | 47 ms | 4 ms | 8 ms |
| A cloud of 1M points in its own rgb, 32 bytes a point | 64 ms | 9 ms | 7 ms |
| A scan of 128 by 1024 | 15 ms | 0.5 ms | 4 ms |

The cloud of 32 bytes a point is the bytes going to the GPU, which Chrome copies past 16 MB only
as fast as its GPU process takes them.

Measured in Node, reading from the bytes into what the GPU is given:

| Value | Time |
| --- | --- |
| A mesh of 1M vertices and 2M triangles, its normals worked out | 54 ms |
| The same along the ramp by z, cut to a range | 67 ms |
| A map of 2000 by 2000 I8 cells, cut to a range | 15 ms |
| The same of F32 cells, the values' own ends | 26 ms |
| Voxels of 200 by 200 by 100, a tenth in range, each a cube's matrix and colour | 14 ms |

Points with no z now lie at z 0, so a Path2D, a Polyline2D and a list of Double2 draw.
`run-big-import-edit` read a cloud without z to see the page sent fewer fields, and expected the
scene to refuse it. It now checks that they draw flat.

## Steps

1. `grid` becomes `floor`.
2. `points` takes a PointCloud, LaserScan, Path and Polyline, and `field` and `range`.
3. `mesh`.
4. `grid` for a Grid.
5. Points read on the GPU.
6. A flat grid as its field's bytes in a texture.
7. A mesh read on the GPU, its normals summed there.
8. Voxels by marching rays, kept only if faster than cubes.

Each step has a scenario drawing it from the demo line, which publishes a cloud, a scan, a
big path of 64 bit poses, a small turning box and rolling ground as meshes, a map of the scan's room, big, and a
ball as voxels, small. The scenarios count the
scene's pixels of each colour with the designer's `count` and `sees`.

## Later

The `draw` part (`draw.md`), not built, would draw from the same readers: a cloud, a mesh and a
grid read once in the worker, whichever part or call draws them.
