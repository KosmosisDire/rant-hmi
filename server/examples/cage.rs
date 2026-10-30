//! The cage cell the classic example runs against: a PLC's conveyor, pusher, vacuum and
//! safety, and a robot's state, joints, jogs and commands, under the names and types the real
//! cell has. `cargo run --example cage -- --loopback` keeps it on this host.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rant::types::{JointState, Twist};
use rant::{FunctionOptions, Node, NodeOptions, Qos, Request, VariableOptions};

#[derive(rant::Message, Clone, Default)]
struct SafetyCmd {
    stop: bool,
    reset: bool,
    chirp: bool,
    slow_mode: bool,
}

#[derive(rant::Message, Clone, Default, PartialEq)]
struct SafetyStatus {
    /// True while the safety circuit is closed, so false is an emergency stop.
    estop: bool,
    lamp_red: bool,
    lamp_yellow: bool,
    lamp_green: bool,
}

#[derive(rant::Enum, Clone, Copy, Debug, PartialEq, Default)]
#[repr(u8)]
enum RobotMode {
    #[default]
    Unknown,
    Teach,
    Play,
    Remote,
}

#[derive(rant::Enum, Clone, Copy, Debug, PartialEq, Default)]
#[repr(u8)]
enum CycleMode {
    #[default]
    Unknown,
    Step,
    OneCycle,
    Auto,
}

#[derive(rant::Message, Clone, Default, PartialEq)]
struct RobotState {
    mode: RobotMode,
    cycle: CycleMode,
    servo_power: bool,
    start: bool,
    hold: bool,
    error: bool,
    alarm: bool,
    is_home: bool,
    alarm_count: u8,
    alarm_no: [u16; 4],
    alarm_data: [u16; 4],
    error_no: u16,
    error_data: u16,
    job_name: rant::String<33>,
    cur_job_name: rant::String<33>,
    job_line: u16,
    job_step: u16,
    jog_active: bool,
    jog_rc: i32,
    alarm_text: String,
}

#[derive(rant::Message, Clone)]
struct ServoCmd {
    on: bool,
}

#[derive(rant::Message, Clone)]
struct Hold {
    on: bool,
}

#[derive(rant::Message, Clone)]
struct AlarmReset {
    reset_alarm: bool,
    cancel_error: bool,
}

/// The jobs on the controller, as the robot lists them for RunJob.
#[derive(rant::Enum, Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
enum Job {
    None,
    Home249,
    Jog,
    Pick,
    Place,
}

#[derive(rant::Message, Clone)]
struct JobCmd {
    job_name: Job,
    task_no: u8,
    start_line: u16,
    from_line: bool,
    servo_on: bool,
}

#[derive(rant::Enum, Clone, Copy, Debug, PartialEq)]
#[repr(i16)]
enum Outcome {
    Ok,
    Error,
    Rejected,
}

#[derive(rant::Message, Clone)]
struct CmdRsp {
    result: Outcome,
    rc: i32,
    err: u16,
}

#[derive(rant::Enum, Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
enum JogFrame {
    Base,
    Robot,
    Tool,
    User,
}

#[derive(rant::Message, Clone)]
struct CartesianJog {
    twist: Twist,
    frame: JogFrame,
    tool: u8,
    user_frame: u8,
}

const BELT_MM: f64 = 1485.0;
const BOX_MM: f64 = 300.0;
const BELT_MM_PER_S: f64 = 250.0;
/// A jog stops once its commands stop for this long, as the robot's does after 32 ms.
const JOG_SILENCE: Duration = Duration::from_millis(100);
/// How many steps a job other than Jog runs before it ends.
const JOB_STEPS: u16 = 20;
/// The alarm a job raises when started without servo power.
const ALARM_NO_SERVO: u16 = 4100;
/// The alarm an emergency stop raises while the servos are on.
const ALARM_ESTOP: u16 = 4000;

fn reply(result: Outcome) -> CmdRsp {
    CmdRsp { result, rc: if result == Outcome::Ok { 0 } else { -1 }, err: 0 }
}

fn main() -> Result<(), rant::Error> {
    let args: Vec<String> = std::env::args().collect();
    let loopback = args.iter().any(|a| a == "--loopback");
    let domain = args.iter().position(|a| a == "--domain").and_then(|i| args.get(i + 1)?.parse().ok()).unwrap_or(0);
    let mut options = NodeOptions::new().domain(domain).max_topics(32);
    if loopback {
        options = options.multicast_interface("127.0.0.1");
    }
    let node = Node::new("cage", options)?;

    let flag = |name: &str| node.variable_definition::<bool>(name, VariableOptions::new().initial(false));
    let reading = |name: &str, at: i16| node.variable_definition::<i16>(name, VariableOptions::new().initial(at).read_only(true));
    let go = flag("Cage/Plc/IO/conveyorGo")?;
    let loop_go = flag("Cage/Plc/IO/conveyorLoopGo")?;
    let _loop_stop = flag("Cage/Plc/IO/conveyorLoopStop")?;
    let suction = flag("Cage/Plc/IO/gripperSuction")?;
    let extend = flag("Cage/Plc/Pusher1/extend")?;
    let distance_a = reading("Cage/Plc/IO/distanceSensorA", 621)?;
    let distance_d = reading("Cage/Plc/IO/distanceSensorD", 455)?;
    let vacuum = reading("Cage/Plc/IO/vacSense", 0)?;
    let pusher_a = node.variable_definition::<bool>("Cage/Plc/IO/pusherA", VariableOptions::new().initial(false).read_only(true))?;
    let safety_cmd = node.variable_definition::<SafetyCmd>("Cage/Plc/gSafetyCmd", VariableOptions::new().initial(SafetyCmd::default()))?;
    let healthy = SafetyStatus { estop: true, lamp_green: true, ..Default::default() };
    let safety = node.variable_definition::<SafetyStatus>("Cage/Plc/gSafetyStatus", VariableOptions::new().initial(healthy.clone()).read_only(true))?;

    let robot = Arc::new(Mutex::new(RobotState { mode: RobotMode::Remote, cycle: CycleMode::Auto, is_home: true, ..Default::default() }));
    let state = node.variable_definition::<RobotState>("Cage/Gp12/RobotState", VariableOptions::new().initial(robot.lock().unwrap().clone()).read_only(true))?;
    let joints = node.publisher::<JointState>("Cage/Gp12/JointState", Qos::new())?;
    let jog = Arc::new(Mutex::new((Instant::now() - JOG_SILENCE, [0.0f64; 6])));
    let heard = jog.clone();
    let _jog_joint = node.subscriber::<JointState>("Cage/Gp12/Jog/Joint", Qos::new(), move |m| {
        let mut v = [0.0; 6];
        for (to, from) in v.iter_mut().zip(m.velocity.iter()) {
            *to = *from;
        }
        *heard.lock().unwrap() = (Instant::now(), v);
    })?;
    // a Cartesian jog moves the first three joints by its linear part and the wrist by its
    // angular part, which is enough to see it work
    let heard = jog.clone();
    let _jog_cartesian = node.subscriber::<CartesianJog>("Cage/Gp12/Jog/Cartesian", Qos::new(), move |m| {
        let Twist { linear: l, angular: a } = &m.twist;
        *heard.lock().unwrap() = (Instant::now(), [l.x, l.y, l.z, a.x, a.y, a.z]);
    })?;

    let r = robot.clone();
    let _servo = node.function_definition("Cage/Gp12/SetServo", FunctionOptions::new(), move |q: Request<ServoCmd, CmdRsp>| {
        let mut s = r.lock().unwrap();
        s.servo_power = q.on;
        if !q.on {
            s.start = false;
        }
        Ok::<_, &str>(reply(Outcome::Ok))
    })?;
    let r = robot.clone();
    let _hold = node.function_definition("Cage/Gp12/SetHold", FunctionOptions::new(), move |q: Request<Hold, CmdRsp>| {
        let mut s = r.lock().unwrap();
        s.hold = q.on;
        if q.on {
            s.start = false;
        }
        Ok::<_, &str>(reply(Outcome::Ok))
    })?;
    let r = robot.clone();
    let _alarm = node.function_definition("Cage/Gp12/ResetAlarm", FunctionOptions::new(), move |q: Request<AlarmReset, CmdRsp>| {
        let mut s = r.lock().unwrap();
        if q.reset_alarm {
            s.alarm = false;
            s.alarm_count = 0;
            s.alarm_no = [0; 4];
            s.alarm_text = String::new();
        }
        Ok::<_, &str>(reply(Outcome::Ok))
    })?;
    let r = robot.clone();
    let _run = node.function_definition("Cage/Gp12/RunJob", FunctionOptions::new(), move |q: Request<JobCmd, CmdRsp>| {
        let mut s = r.lock().unwrap();
        if q.job_name == Job::None || s.alarm {
            return Ok::<_, &str>(reply(Outcome::Rejected));
        }
        if !s.servo_power {
            s.alarm = true;
            s.alarm_count = 1;
            s.alarm_no = [ALARM_NO_SERVO, 0, 0, 0];
            s.alarm_text = "Servo power is off".into();
            return Ok(reply(Outcome::Error));
        }
        let name = format!("{:?}", q.job_name).to_uppercase();
        s.job_name = name.parse().unwrap_or_default();
        s.cur_job_name = s.job_name;
        s.job_step = 0;
        s.hold = false;
        s.start = true;
        Ok(reply(Outcome::Ok))
    })?;

    println!("cage is up on domain {domain}{}", if loopback { ", on this host only" } else { "" });
    const TICK: Duration = Duration::from_millis(20);
    let dt = TICK.as_secs_f64();
    let mut at = BELT_MM - BOX_MM;
    let mut back = false;
    let mut looping = false;
    let mut loop_was = false;
    let mut extending = Duration::ZERO;
    let mut suck = 0.0f64;
    let mut status = healthy;
    let mut position = [0.0f64; 6];
    let mut stepped = Instant::now();
    loop {
        // the conveyor carries its box left while Convey is held, and back and forth after Loop
        let loop_now = loop_go.get()?.unwrap_or(false);
        if loop_now && !loop_was {
            looping = !looping;
        }
        loop_was = loop_now;
        let running = status.estop && (go.get()?.unwrap_or(false) || looping);
        if running {
            let slow = if status.lamp_yellow { 0.3 } else { 1.0 };
            at += if back { 1.0 } else { -1.0 } * BELT_MM_PER_S * slow * dt;
            if at <= 0.0 {
                at = 0.0;
                back = looping;
                if !looping {
                    at = BELT_MM - BOX_MM;
                }
            } else if at >= BELT_MM - BOX_MM {
                at = BELT_MM - BOX_MM;
                back = false;
            }
        }
        let d = (at + 455.0).round() as i16;
        let a = (BELT_MM - at - BOX_MM + 621.0).round() as i16;
        if distance_d.get()? != Some(d) {
            distance_d.set(&d)?;
        }
        if distance_a.get()? != Some(a) {
            distance_a.set(&a)?;
        }

        // the pusher reaches its end a moment after it is told to extend
        extending = if extend.get()?.unwrap_or(false) { extending + TICK } else { Duration::ZERO };
        let out = extending >= Duration::from_millis(300);
        if pusher_a.get()? != Some(out) {
            pusher_a.set(&out)?;
        }

        // the vacuum builds toward 12 bar while sucking and falls away after
        let goal = if suction.get()?.unwrap_or(false) { 1200.0 } else { 0.0 };
        suck += (goal - suck) * 0.1;
        let v = suck.round() as i16;
        if vacuum.get()? != Some(v) {
            vacuum.set(&v)?;
        }

        // stop opens the safety circuit until a reset closes it again
        let cmd = safety_cmd.get()?.unwrap_or_default();
        if cmd.stop {
            status.estop = false;
        } else if cmd.reset {
            status.estop = true;
        }
        status.lamp_red = !status.estop;
        status.lamp_yellow = status.estop && cmd.slow_mode;
        status.lamp_green = status.estop && !cmd.slow_mode;
        if safety.get()?.as_ref() != Some(&status) {
            safety.set(&status)?;
        }

        // the robot steps through a job, jogs while its Jog job runs and commands keep coming
        let mut s = robot.lock().unwrap();
        if !status.estop && s.servo_power {
            s.alarm = true;
            s.alarm_count = 1;
            s.alarm_no = [ALARM_ESTOP, 0, 0, 0];
            s.alarm_text = "Emergency stop".into();
            s.servo_power = false;
            s.start = false;
        }
        let (last, velocity) = *jog.lock().unwrap();
        let jogging = s.start && s.cur_job_name.as_str() == "JOG" && last.elapsed() < JOG_SILENCE;
        s.jog_active = jogging;
        if jogging {
            for (p, v) in position.iter_mut().zip(velocity) {
                *p += v * dt;
            }
            if velocity.iter().any(|v| *v != 0.0) {
                s.is_home = false;
            }
        }
        if s.start && s.cur_job_name.as_str() != "JOG" && stepped.elapsed() >= Duration::from_millis(200) {
            stepped = Instant::now();
            s.job_step += 1;
            if s.cur_job_name.as_str() == "HOME249" {
                for p in &mut position {
                    *p *= 0.8;
                }
            }
            if s.job_step >= JOB_STEPS {
                s.start = false;
                s.is_home = s.cur_job_name.as_str() == "HOME249";
                if s.is_home {
                    position = [0.0; 6];
                }
            }
        }
        if state.get()?.as_ref() != Some(&*s) {
            state.set(&*s)?;
        }
        drop(s);
        joints.send(&JointState { position: position.to_vec(), velocity: if jogging { velocity.to_vec() } else { vec![0.0; 6] }, effort: Vec::new() })?;
        std::thread::sleep(TICK);
    }
}
