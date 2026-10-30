//! A small line to try the HMI on: a conveyor, a jog topic, a reset function, a fill task that
//! reports its progress, a moving robot, a camera with the boxes a detector finds in its frames
//! and a home it counts, the same view as MJPEG video, a label camera showing a real conveyor
//! shot with a parcel and its labels, a 3D scan of the cell's floor with that part on it, and
//! the floor's heat as points each with a colour and a size, and the robot's routes, each leg
//! a list of points of its own. The same floor as a PointCloud, a room's walls as a LaserScan,
//! a planned Path, a turning part and rolling ground as Meshes, the room as a map and a ball as
//! voxels in Grids, as the standard types carry them.
//! `cargo run --example demo -- --loopback` keeps it on this host.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use rant::types::{
    AlignedBox2D, Color, Double2, Double3, Empty, Float3, Grid, GridField, Image, ImageFormat, JointState, LaserScan, Mesh, Path, PointCloud, PointField, Pose, Quaternion, ScalarKind,
    Timestamp, Transform, VideoCodec, VideoFrame,
};
use rant::{Bytes, FunctionOptions, Node, NodeOptions, Qos, Request, TaskOptions, TaskRequest, VariableOptions};

#[derive(rant::Message, Clone)]
struct Conveyor {
    speed: f64,
    running: bool,
    part: rant::String<16>,
}

#[derive(rant::Message, Clone)]
struct Settings {
    mode: Mode,
    target: u32,
}

/// What a detector found in a camera frame, each box in the frame's pixels.
#[derive(rant::Message, Clone)]
struct Detections {
    boxes: Vec<AlignedBox2D>,
}

/// Where a 3D camera over the cell met something, each point in metres.
#[derive(rant::Message, Clone)]
struct Scan {
    points: Vec<Float3>,
}

/// One leg of a route: how fast, and the points it passes.
#[derive(rant::Message, Clone)]
struct Leg {
    speed: f32,
    pts: Vec<Double2>,
}

/// The robot's routes, lists in lists: each leg's points, and a name per route.
#[derive(rant::Message, Clone)]
struct Routes {
    legs: Vec<Leg>,
    names: Vec<String>,
}

/// How warm the cell's floor is, as a thermal camera's cloud comes: its points, and beside them
/// a colour and a size for each, in metres.
#[derive(rant::Message, Clone)]
struct Heat {
    points: Vec<Float3>,
    colors: Vec<Color>,
    sizes: Vec<f32>,
}

#[derive(rant::Enum, Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
enum Mode {
    Auto,
    Manual,
}

fn main() -> Result<(), rant::Error> {
    let args: Vec<String> = std::env::args().collect();
    let loopback = args.iter().any(|a| a == "--loopback");
    let domain = args.iter().position(|a| a == "--domain").and_then(|i| args.get(i + 1)?.parse().ok()).unwrap_or(0);
    let mut options = NodeOptions::new().domain(domain).max_topics(48);
    if loopback {
        options = options.multicast_interface("127.0.0.1");
    }
    let node = Node::new("demo_line", options)?;

    let speed = node.variable_definition::<f64>("Line1/Speed", VariableOptions::new().initial(0.5))?;
    let running = node.variable_definition::<bool>("Line1/Running", VariableOptions::new().initial(true))?;
    let settings = node.variable_definition::<Settings>(
        "Line1/Settings",
        VariableOptions::new().initial(Settings { mode: Mode::Auto, target: 120 }),
    )?;
    let conveyor = node.publisher::<Conveyor>("Line1/Conveyor", Qos::new())?;
    let pose = node.publisher::<Pose>("Robot/Pose", Qos::new())?;
    let joints = node.publisher::<JointState>("Robot/Joints", Qos::new())?;
    let camera = node.publisher::<Image>("Cell/Camera", Qos::new())?;
    // a setting held under the camera, as the transcoder's Video is, in ms
    let _exposure = node.variable_definition::<f64>("Cell/Camera/Exposure", VariableOptions::new().initial(8.0))?;
    let inspection = node.publisher::<VideoFrame>("Cell/Inspection", Qos::new())?;
    let detections = node.publisher::<Detections>("Cell/Detections", Qos::new())?;
    let label_cam = node.publisher::<VideoFrame>("Line1/LabelCam", Qos::new())?;
    let labels = node.publisher::<Detections>("Line1/LabelCam/Detections", Qos::new())?;
    let scan = node.publisher::<Scan>("Cell/Scan", Qos::new())?;
    let heat = node.publisher::<Heat>("Cell/Heat", Qos::new())?;
    let routes = node.publisher::<Routes>("Cell/Routes", Qos::new())?;
    let cloud = node.publisher::<PointCloud>("Cell/Cloud", Qos::new())?;
    let lidar = node.publisher::<LaserScan>("Cell/Lidar", Qos::new())?;
    let plan = node.publisher::<Path>("Cell/Plan", Qos::new())?;
    let part = node.publisher::<Mesh>("Cell/Part", Qos::new())?;
    let ground = node.publisher::<Mesh>("Cell/Ground", Qos::new())?;
    let map = node.publisher::<Grid>("Cell/Map", Qos::new())?;
    let voxels = node.publisher::<Grid>("Cell/Voxels", Qos::new())?;
    let jog = Arc::new(Mutex::new(None::<f64>));
    let heard = jog.clone();
    let _jog = node.subscriber::<f64>("Line1/Jog", Qos::new(), move |m| *heard.lock().unwrap() = Some(m.into_inner()))?;
    let parts = Arc::new(AtomicU32::new(0));
    let cleared = parts.clone();
    let _reset = node.function_definition("Line1/Reset", FunctionOptions::new(), move |_: Request<Empty, u32>| Ok::<_, &str>(cleared.swap(0, Ordering::Relaxed)))?;
    // fills a box with `parts` parts, 5 a second, the share done after each, until cancelled
    let _fill = node.task_definition("Line1/Fill", TaskOptions::new(), |req: TaskRequest<u32, f32, u32>| {
        let parts = *req;
        let task = req.defer();
        std::thread::spawn(move || {
            for part in 1..=parts {
                if task.cancelled() {
                    return task.complete_cancelled("stopped", Some(&(part - 1)));
                }
                std::thread::sleep(Duration::from_millis(200));
                task.progress(&(part as f32 / parts as f32))?;
            }
            task.complete(&parts)
        });
    })?;
    // the camera's home takes and gives nothing, untyped as many devices' commands are
    let homes = Arc::new(AtomicU32::new(0));
    let homing = homes.clone();
    let _home = node.function_definition::<Bytes, Bytes, _>("Cell/Camera/Home", FunctionOptions::new(), move |_| {
        homing.fetch_add(1, Ordering::Relaxed);
        Vec::new()
    })?;
    let homed = node.variable_definition::<u32>("Cell/Camera/Homes", VariableOptions::new().initial(0))?;

    println!("demo_line is up on domain {domain}{}", if loopback { ", on this host only" } else { "" });
    let start = Instant::now();
    let mut tick = 0u32;
    let mut frame = 0u64;
    // 20 rounds a second whatever each takes, so values keep their rates
    let mut next = start;
    loop {
        if let Some(v) = jog.lock().unwrap().take() {
            speed.set(&v)?;
        }
        let n = homes.load(Ordering::Relaxed);
        if homed.get()? != Some(n) {
            homed.set(&n)?;
        }
        let t = start.elapsed().as_secs_f64();
        let on = running.get()?.unwrap_or(false);
        let v = if on { speed.get()?.unwrap_or(0.0) } else { 0.0 };
        // a part a second while running in Auto
        if on && settings.get()?.is_some_and(|s| s.mode == Mode::Auto) && t as u32 > tick {
            tick = t as u32;
            parts.fetch_add(1, Ordering::Relaxed);
        }
        conveyor.send(&Conveyor { speed: v, running: on, part: format!("P{}", parts.load(Ordering::Relaxed)).parse()? })?;
        pose.send(&Pose {
            position: Double3 { x: 0.4 * t.cos(), y: 0.4 * t.sin(), z: 0.3 },
            orientation: Quaternion::IDENTITY,
        })?;
        joints.send(&JointState {
            position: (0..6).map(|i| (t * 0.7 + i as f64).sin()).collect(),
            velocity: (0..6).map(|i| (t * 0.7 + i as f64).cos() * 0.7).collect(),
            effort: Vec::new(),
        })?;
        // the camera at 10 frames a second, a part wandering across it
        frame += 1;
        if frame.is_multiple_of(2) {
            let (image, found) = camera_frame(t);
            let mut jpeg = Vec::new();
            jpeg_encoder::Encoder::new(&mut jpeg, 80).encode(&image.data, image.width as u16, image.height as u16, jpeg_encoder::ColorType::Rgb).expect("a frame in memory encodes");
            inspection.send(&VideoFrame { codec: VideoCodec::Mjpeg, width: image.width, height: image.height, keyframe: true, pts: Timestamp::now(), data: jpeg })?;
            camera.send(&image)?;
            detections.send(&Detections { boxes: vec![found] })?;
        }
        if frame.is_multiple_of(4) {
            label_cam.send(&VideoFrame { codec: VideoCodec::Mjpeg, width: 960, height: 540, keyframe: true, pts: Timestamp::now(), data: SHOT.to_vec() })?;
            labels.send(&Detections { boxes: SHOT_FINDS.iter().map(|&[x0, y0, x1, y1]| AlignedBox2D { min: Double2 { x: x0, y: y0 }, max: Double2 { x: x1, y: y1 } }).collect() })?;
            scan.send(&scan_of(t))?;
            heat.send(&heat_of(t))?;
            routes.send(&routes_of(t))?;
            cloud.send(&cloud_of(t))?;
            lidar.send(&lidar_of(t))?;
            plan.send(&plan_of(t))?;
            part.send(&part_of(t))?;
            ground.send(&ground_of(t))?;
            map.send(&map_of(t))?;
            voxels.send(&voxels_of(t))?;
        }
        next += Duration::from_millis(50);
        match next.checked_duration_since(Instant::now()) {
            Some(wait) => std::thread::sleep(wait),
            None => next = Instant::now(),
        }
    }
}

/// The cell's floor, 4 by 2 m in 20000 points, with a part 0.4 m wide and 0.3 high on it that
/// wanders along x, as a 3D camera over it sees them.
fn scan_of(t: f64) -> Scan {
    let at = 1.5 * (t * 0.5).sin() as f32;
    let points = (0..20_000)
        .map(|i| {
            let (x, y) = ((i % 200) as f32 * 0.02 - 2.0, (i / 200) as f32 * 0.02 - 1.0);
            let on = (x - at).abs() < 0.2 && y.abs() < 0.2;
            Float3 { x, y, z: if on { 0.3 } else { 0.0 } }
        })
        .collect();
    Scan { points }
}

/// The floor of `scan_of` as a PCL cloud: x, y, z and intensity as 32 bit floats, then rgb
/// packed blue, green, red, as PCL packs it. The part is orange and brighter, the floor grey.
fn cloud_of(t: f64) -> PointCloud {
    let fields = floats(&["x", "y", "z", "intensity", "rgb"]);
    let mut data = Vec::with_capacity(20_000 * 20);
    for p in scan_of(t).points {
        let on = p.z > 0.0;
        let intensity: f32 = if on { 200.0 } else { 40.0 + 20.0 * p.x.abs() };
        let [b, g, r] = if on { [40u8, 140, 230] } else { [120, 120, 120] };
        for v in [p.x, p.y, p.z, intensity] {
            data.extend(v.to_le_bytes());
        }
        data.extend([b, g, r, 0]);
    }
    PointCloud { origin: Transform::identity(), width: 200, fields, point_step: 20, dense: true, data }
}

/// A planar lidar at the middle of a 6 by 4 m room, a post 0.3 m wide circling it, in 360
/// beams. The walls return 100 and the post 255.
fn lidar_of(t: f64) -> LaserScan {
    let post = (1.5 * (t * 0.5).cos(), 1.0 * (t * 0.5).sin());
    let (mut ranges, mut intensities) = (Vec::with_capacity(360), Vec::with_capacity(360));
    for i in 0..360 {
        let a = -std::f64::consts::PI + i as f64 * std::f64::consts::TAU / 360.0;
        let (dx, dy) = (a.cos(), a.sin());
        // the nearer of the walls the beam meets
        let wall = [3.0 / dx.abs(), 2.0 / dy.abs()].into_iter().filter(|d| d.is_finite()).fold(f64::INFINITY, f64::min);
        // the post as a circle of radius 0.15: the nearer root along the beam, if it meets it
        let along = dx * post.0 + dy * post.1;
        let miss = (post.0 * post.0 + post.1 * post.1) - along * along;
        let hit = if miss < 0.0225 && along > 0.0 { along - (0.0225 - miss).sqrt() } else { f64::INFINITY };
        let (r, v) = if hit < wall { (hit, 255.0) } else { (wall, 100.0) };
        ranges.push(r as f32);
        intensities.push(v);
    }
    let step = (std::f64::consts::TAU / 360.0) as f32;
    LaserScan { angle_min: -std::f32::consts::PI, angle_step: step, time_step: 0.0, range_min: 0.05, range_max: 10.0, echoes: 1, ranges, intensities }
}

/// A planned path of 40 poses round an ellipse, each facing along it, turning as time goes.
fn plan_of(t: f64) -> Path {
    let poses = (0..40)
        .map(|i| {
            let a = t * 0.2 + i as f64 * std::f64::consts::TAU / 40.0;
            let heading = (0.5 * a.cos()).atan2(-1.5 * a.sin()) / 2.0;
            Pose {
                position: Double3 { x: 1.5 * a.cos(), y: 0.5 * a.sin(), z: 0.05 },
                orientation: Quaternion { x: 0.0, y: 0.0, z: heading.sin(), w: heading.cos() },
            }
        })
        .collect();
    Path { poses }
}

/// Each of `names` a 32 bit float, one after another from the start of a point.
fn floats(names: &[&str]) -> Vec<PointField> {
    names.iter().zip(0..).map(|(name, i)| PointField { name: (*name).to_owned(), offset: 4 * i, kind: ScalarKind::F32, count: 1 }).collect()
}

/// A box 0.4 m wide turning about z, as a Mesh of its six faces, four vertices each with the
/// face's normal and colour, so its edges stay sharp. Its top is orange.
fn part_of(t: f64) -> Mesh {
    let (s, c) = ((t * 0.5).sin() as f32, (t * 0.5).cos() as f32);
    let turn = |[x, y, z]: [f32; 3]| [c * x - s * y, s * x + c * y, z];
    // each face's normal, two ways across it counterclockwise from outside, and its blue,
    // green and red
    let faces: [([f32; 3], [f32; 3], [f32; 3], [u8; 3]); 6] = [
        ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [60, 60, 220]),
        ([-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [60, 200, 60]),
        ([0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [220, 120, 60]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [60, 200, 220]),
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [40, 140, 230]),
        ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [120, 120, 120]),
    ];
    let (mut data, mut triangles) = (Vec::with_capacity(24 * 28), Vec::with_capacity(36));
    for (k, (n, u, v, bgr)) in faces.iter().enumerate() {
        for (a, b) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            let at = turn([0, 1, 2].map(|i| 0.2 * (n[i] + a * u[i] + b * v[i])));
            for x in at.into_iter().chain(turn(*n)) {
                data.extend(x.to_le_bytes());
            }
            data.extend([bgr[0], bgr[1], bgr[2], 0]);
        }
        let first = 4 * k as u32;
        triangles.extend([0, 1, 2, 0, 2, 3].map(|i| first + i));
    }
    let fields = floats(&["x", "y", "z", "normal_x", "normal_y", "normal_z", "rgb"]);
    Mesh { vertices: PointCloud { origin: Transform::identity(), width: 0, fields, point_step: 28, dense: true, data }, triangles }
}

/// Ground 4 by 4 m rolling 0.2 m up and down, as a Mesh of 100 by 100 vertices with x, y and z
/// only, its hills moving along x as time goes.
fn ground_of(t: f64) -> Mesh {
    const N: u32 = 100;
    let mut data = Vec::with_capacity((N * N * 12) as usize);
    for j in 0..N {
        for i in 0..N {
            let (x, y) = (i as f32 * 0.04 - 2.0, j as f32 * 0.04 - 2.0);
            let z = 0.2 * (2.0 * x + 0.5 * t as f32).sin() * (1.5 * y).cos();
            for v in [x, y, z] {
                data.extend(v.to_le_bytes());
            }
        }
    }
    let mut triangles = Vec::with_capacity(((N - 1) * (N - 1) * 6) as usize);
    for j in 0..N - 1 {
        for i in 0..N - 1 {
            let a = j * N + i;
            triangles.extend([a, a + 1, a + N + 1, a, a + N + 1, a + N]);
        }
    }
    let vertices = PointCloud { origin: Transform::identity(), width: N, fields: floats(&["x", "y", "z"]), point_step: 12, dense: true, data };
    Mesh { vertices, triangles }
}

/// A grid's origin: its first cell's outer corner at x and y on the floor, square to the axes.
fn corner(x: f64, y: f64) -> Transform {
    Transform { pose: Pose { position: Double3 { x, y, z: 0.0 }, orientation: Quaternion::IDENTITY }, ..Transform::identity() }
}

/// The lidar's room, 6 by 4 m, as a map in cells of 2.5 cm: its walls and the post occupied,
/// 100, the floor free, 0, and the far corners unknown, -1. Beside that each cell's clearance,
/// how far it is from the nearest wall in metres.
fn map_of(t: f64) -> Grid {
    let (w, h, cell) = (240u32, 160u32, 0.025);
    let post = (1.5 * (t * 0.5).cos(), 1.0 * (t * 0.5).sin());
    let (mut occupancy, mut clearance) = (Vec::with_capacity((w * h) as usize), Vec::with_capacity((w * h * 4) as usize));
    for j in 0..h {
        for i in 0..w {
            let (x, y) = (-3.0 + (i as f64 + 0.5) * cell, -2.0 + (j as f64 + 0.5) * cell);
            let clear = (3.0 - x.abs()).min(2.0 - y.abs());
            let v: i8 = if clear < 0.1 || (x - post.0).hypot(y - post.1) < 0.15 { 100 } else if x.hypot(y) > 3.0 { -1 } else { 0 };
            occupancy.push(v as u8);
            clearance.extend((clear as f32).to_le_bytes());
        }
    }
    let fields = vec![
        GridField { name: "occupancy".to_owned(), kind: ScalarKind::I8, data: occupancy },
        GridField { name: "clearance".to_owned(), kind: ScalarKind::F32, data: clearance },
    ];
    Grid { origin: corner(-3.0, -2.0), resolution: cell, cells_x: w, cells_y: h, cells_z: 1, fields }
}

/// A ball 0.8 m across bobbing in a 1.2 m cube of 5 cm cells, as voxels: the cells inside it
/// occupied, 100, the rest free, 0.
fn voxels_of(t: f64) -> Grid {
    let (n, cell) = (24u32, 0.05);
    let middle = |c: u32| (c as f64 + 0.5) * cell;
    let z = 0.6 + 0.1 * (t * 0.8).sin();
    let mut data = Vec::with_capacity((n * n * n) as usize);
    for k in 0..n {
        for j in 0..n {
            for i in 0..n {
                let inside = (middle(i) - 0.6).hypot(middle(j) - 0.6).hypot(middle(k) - z) < 0.4;
                data.push(if inside { 100 } else { 0 });
            }
        }
    }
    let fields = vec![GridField { name: "occupancy".to_owned(), kind: ScalarKind::I8, data }];
    Grid { origin: corner(-0.6, -0.6), resolution: cell, cells_x: n, cells_y: n, cells_z: n, fields }
}

/// Two legs of 2 and 3 points, the second's last point moving along x, and two route names.
fn routes_of(t: f64) -> Routes {
    let at = |x: f64, y: f64| Double2 { x, y };
    Routes {
        legs: vec![
            Leg { speed: 0.5, pts: vec![at(0.0, 0.0), at(1.0, 0.0)] },
            Leg { speed: 1.5, pts: vec![at(1.0, 0.0), at(1.0, 1.0), at(2.0 + t.sin(), 1.0)] },
        ],
        names: vec!["pick".to_owned(), "place and return".to_owned()],
    }
}

/// The floor in 50 by 50 points, a warm spot circling on it: red and large where warm, blue
/// and small where cold.
fn heat_of(t: f64) -> Heat {
    let (cx, cy) = ((t * 0.3).cos() as f32, (t * 0.3).sin() as f32 * 0.5);
    let mut heat = Heat { points: Vec::new(), colors: Vec::new(), sizes: Vec::new() };
    for i in 0..2500 {
        let (x, y) = ((i % 50) as f32 * 0.08 - 2.0, (i / 50) as f32 * 0.04 - 1.0);
        let warm = (-((x - cx).powi(2) + (y - cy).powi(2)) * 4.0).exp();
        heat.points.push(Float3 { x, y, z: 0.0 });
        heat.colors.push(Color { r: (255.0 * warm) as u8, g: 40, b: (255.0 * (1.0 - warm)) as u8, a: 255 });
        heat.sizes.push(0.02 + 0.04 * warm);
    }
    heat
}

/// A real conveyor shot for the label camera, 960 by 540, and what a detector finds in it, in
/// its pixels: the parcel, then its two labels.
const SHOT: &[u8] = include_bytes!("conveyor.jpg");
const SHOT_FINDS: [[f64; 4]; 3] = [[349.0, 114.0, 695.0, 399.0], [419.0, 210.0, 569.0, 292.0], [549.0, 247.0, 693.0, 334.0]];

/// A camera frame of a part on a shaded belt, and the box around the part, in its pixels.
fn camera_frame(t: f64) -> (Image, AlignedBox2D) {
    const W: u32 = 160;
    const H: u32 = 120;
    const HALF: f64 = 12.0;
    let (cx, cy) = (((t * 0.5).sin() * 0.35 + 0.5) * f64::from(W), ((t * 0.7).cos() * 0.3 + 0.5) * f64::from(H));
    let mut data = Vec::with_capacity((W * H * 3) as usize);
    for y in 0..H {
        for x in 0..W {
            let part = (f64::from(x) - cx).abs() < HALF && (f64::from(y) - cy).abs() < HALF;
            data.extend(if part { [230, 140, 40] } else { [30 + (x / 4) as u8, 40 + (y / 3) as u8, 60] });
        }
    }
    let image = Image { width: W, height: H, stride: W * 3, format: ImageFormat::Rgb8, data };
    let margin = HALF + 2.0;
    (image, AlignedBox2D { min: Double2 { x: cx - margin, y: cy - margin }, max: Double2 { x: cx + margin, y: cy + margin } })
}
