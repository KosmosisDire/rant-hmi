//! A small line to try the HMI on: a conveyor, a jog topic, a reset function, a fill task that
//! reports its progress, a moving robot, a camera with the boxes a detector finds in its frames
//! and a home it counts, the same view as MJPEG video, a label camera showing a real conveyor
//! shot with a parcel and its labels, and a 3D scan of the cell's floor with that part on it.
//! `cargo run --example demo -- --loopback` keeps it on this host.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use rant::types::{AlignedBox2D, Double2, Double3, Empty, Float3, Image, ImageFormat, JointState, Pose, Quaternion, Timestamp, VideoCodec, VideoFrame};
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
    let mut options = NodeOptions::new().domain(domain).max_topics(32);
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
