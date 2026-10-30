# USD robots in scenes

Asked 2026-10-29: show USD robots in a 3D scene, Isaac Sim's assets above all, moved by
their joints. It must land before the next HMI release.

## What a robot file holds

Isaac Sim 5 saves a robot as a root file over layers in `configuration/`: the geometry in a
sublayer, the physics in a reference inside a variant, sensors and the robot schema beside
them, mostly binary. Across the robots tested:

- Links sit side by side under the default prim, each a rigid body with `visuals` and
  `collisions`, the collisions drawn only as guides.
- Joints are revolute, prismatic, fixed or plain. `body0` empty means the world. A tool frame
  may be fixed to the world from the arm's side, as UR's `ee_joint` is.
- Most geometry is instanced. Shapes (Cube, Cylinder, Sphere, Capsule) appear beside meshes.
  Normals and texture coordinates are mostly per face corner. GeomSubsets bind materials to
  faces.
- Materials are mostly OmniPBR, an MDL shader, and some UsdPreviewSurface.
- Grippers such as Robotiq's close loops with joints marked to stay out of the tree.

## Options

A. **three.js's USDLoader on the screen.** It reads one file or a usdz, with no sublayers,
   references or overs, so Isaac's layered robots fail.

B. **The backend reads the stage** with the pure Rust `openusd` crate, which composes layers,
   references, payloads, variants and instancing, and gives screens a glTF model. Chosen.

## Decisions

The user's:

- The HMI reads the robot, as B.
- `joints` takes joints by name, `{ elbow_joint: 0.5 }`, radians for a turning joint and
  metres for a sliding one, about the joint's own axis. Or a JointState, with a new `names`
  property for its JointNames, as the Joints component takes them. Without `names`, positions
  follow the robot's joints in the order the file gives.
- Colours and textures, not colours only.
- Testing on many robots, from Isaac's library, Hugging Face and others.
- glTF stays for models that do not move, as a hall or a cell's frame. It has no joints, only
  nodes, so its `joints` and `names` went: a robot is USD.
- A file of several robots, as a cell or a warehouse, stays one model. `joints` and `names`
  take each robot's under its name, and a file of one robot keeps the plain form. A robot that
  drives around a hall would need a part of its own, which this leaves for later.

Claude's:

- **The order without names** is Isaac Sim's: breadth first from the root, siblings in the
  file's order, moving joints only. A JointState Isaac publishes comes in it, and Isaac Lab
  documents it. The order the prims are written in would put Franka's fingers first.
- **The model** is a glb: a root that turns z up to glTF's y up and scales by
  `metersPerUnit` (USD's fallback 0.01), each link under it at its place at rest with its prim
  path in `extras.link`, each mesh or shape under its link. The scene's extras hold the joints
  parents first (name, kind, parent link or null, child link, axis, the joint's frame in each),
  the moving joints' names, `metersPerUnit` and the problems met.
- **Moving a link**: for a joint given a value, the child is the parent, times the joint's
  frame in the parent, times the turn or slide, times its frame in the child undone. A fixed
  joint or one given no value keeps the child where the file puts it from its parent. All 18
  robots' frames agree with their links at rest.
- **The tree**: joints between two bodies come before ones to the world, and a loop's own
  joints last, so each link takes one parent.
- **Mimic joints**: a joint given no value follows the one PhysX's mimic joint names, its
  position plus the gearing times that one's plus the offset being 0. A Robotiq 2F-85's fingers
  so close by `finger_joint` alone.
- **Robots**: joints joined through their links are one robot. It is placed at the
  PhysicsArticulationRootAPI on it, which Isaac puts on a robot's prim, its first link or its
  root joint, else at its links' common prim. It is named by the nearest prim there that is no
  link or joint, as `Nova_Carter_ROS_1`, or by that prim's path when two share a name. Joint
  names repeat across robots and inside one, as a dolly's four `revolute_joint`, so a list of
  positions maps by place, never by name.
- **Files**: only files inside the project's `files` folder are read, by a resolver that finds
  nothing outside it. A layer or texture outside it, or missing, is left out as a problem.
- **Downloads** (the user's call): a layer or texture on a web server, as NVIDIA's asset server,
  is downloaded into `files/downloaded/<host>/<path>` while the model is made, and read from
  there after. A file a download names beside it, missing there, comes from beside it on the
  server. Only USD layers and PNG or JPEG images are fetched, as nothing else is read. A
  failure is a problem, and a host that never answers is not tried again for that model.
- **Problems are warnings** on the model, which shows the rest. A model with problems is made
  again each time it is asked for, so a file added later is found.
- **Serving**: `files/<robot>.usd?as=glb` makes it on a blocking thread, keeps it until a file
  it read changes, and answers its tag with 304. A file that is no USD answers 422 with the
  reason, which the model shows as its fault.
- **Looks**: UsdPreviewSurface, and OmniPBR's colour, tint, texture, metalness, roughness and
  opacity. A bound material wins over display colour. A texture is drawn when PNG or JPEG.
- **Draw calls**: parts that move together, each showing a mesh no other part shows, are
  joined by material, and copies of one mesh on one link are its GPU instances
  (`EXT_mesh_gpu_instancing`). A see through part stays alone, as each is drawn in order of how
  far it is. Copies of a material, as each copy of a prop brings, are one. The office scene went
  from 4265 draws to 394, a warehouse from 921 to 81.
- **Packing**: meshes are packed by meshopt (`KHR_meshopt_compression`), which three.js
  decodes in WebAssembly. A position keeps 16 bits with an exponent shared per component, a
  fraction of a millimetre on a robot and a few on a hall, a normal two bytes on an octahedron
  (`KHR_mesh_quantization`), a texture coordinate 14 bits. Robots are five to six times smaller,
  as UR10e from 41 MB to 6.7 MB, and scenes about half.
- **An MDL of its own**, as the warehouses and the office Unreal exported, is read by what its
  inputs are called: its albedo or base colour texture, else a texture whose file ends `_D` or
  `_BC`, times any tint, else its first colour, and its roughness and metalness, the middle of a
  range when it gives one.

## Robots tested

Each made into a model and drawn, its shown parts counted against Pixar's own USD from Isaac
Sim, its joints moved, and its frames checked at rest.

| Robot | From | Links | Moving joints | Triangles | Made in |
| --- | --- | --- | --- | --- | --- |
| Yaskawa NEX10 | Isaac 5.1 | 7 | 6 | 201k | 81 ms |
| Franka Panda | Isaac 5.1 | 11 | 9 | 94k | 63 ms |
| Shadow Hand | Isaac 5.1 | 26 | 24 | 40k | 34 ms |
| Kinova Gen3, Jaco2 | Isaac 5.1 | 9, 14 | 7, 12 | 90k, 92k | 60 ms |
| Fanuc CRX10iA/L | Isaac 5.1 | 10 | 6 | 24k | 16 ms |
| Kuka KR210 | Isaac 5.1 | 9 | 6 | 88k | 49 ms |
| Robotiq 2F-140, 2F-85, Hand-E | Isaac 5.1 | 11, 9, 3 | 6, 6, 2 | 30k, 86k, 55k | 26 to 73 ms |
| UR10e | Isaac 5.1 | 7 | 6 | 1.6M | 444 ms |
| Unitree Go2 | Isaac 5.1 | 39 | 12 | 556k | 335 ms |
| Asimov 1 | Hugging Face, Isaac 6 layout | 26 | 25 | 959k | 641 ms |
| Unitree G1 43 DOF | Hugging Face | 53 | 43 | 626k | 345 ms |
| Piper, Franka with 2F-85 | Hugging Face | 11, 20 | 8, 15 | 184k, 237k | 90, 122 ms |
| Isaac URDF importer test | Isaac 5.1 install | 7 | 6 | 1k | 9 ms |
| arna2 | the user's | 15 | 11 | 420k | 2.4 s, 295 ms after |

Times are a release build. arna2's Kinova arm and lidar are on NVIDIA's asset server, which the
first make downloads.

## Left out

- OmniPBR's separate opacity, roughness, metallic and normal textures. glTF keeps opacity in
  the colour texture, so a decal shows its whole rectangle.
- What an MDL of its own works out in its code: masks that colour a cart's body and handle
  apart, tiling, and inputs a material leaves at the MDL file's defaults, as a traffic cone's
  orange.
- Closed loops move only by the joints given values.
- Textures go as their files are, PNG or JPEG, and are most of a scene's bytes: the office's
  281 MB is 233 MB of them. A screen loads a model once and then asks for it by tag.
