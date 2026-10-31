use std::collections::BTreeMap;
use std::time::Duration;

use crate::value::value;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

use super::*;
use crate::logic::{Rule, When};
use crate::object::ObjectInfo;

fn import(alias: &str, kind: Kind, intent: Intent) -> Import {
    Import { alias: alias.into(), entity: alias.into(), kind, intent, rate: None }
}

/// The demo line as an object, with these computed values and logic.
fn line(computed: Vec<Computed>, logic: Vec<Rule>) -> object::Object {
    let mut o = object::Object::new(ObjectInfo { name: "Line".into(), mesh: "Line1".into(), note: None });
    o.imports = vec![
        import("Speed", Kind::Variable, Intent::Write),
        import("Running", Kind::Variable, Intent::Write),
        import("Settings", Kind::Variable, Intent::Write),
        import("Joints", Kind::Topic, Intent::Read),
        import("Jog", Kind::Topic, Intent::Write),
        import("Target", Kind::Variable, Intent::Read),
        import("Peek", Kind::Function, Intent::Read),
        import("Reset", Kind::Function, Intent::Write),
        import("Fill", Kind::Task, Intent::Write),
    ];
    o.variables = vec![
        Variable { name: "jogMode".into(), start: value!("Joint"), per: Per::Screen },
        Variable { name: "count".into(), start: value!(0), per: Per::Hmi },
    ];
    o.computed = computed;
    o.logic = logic;
    o
}

/// Runs as the line's own code, which reads its members by name.
fn own() -> Option<String> {
    Some("Line".into())
}

/// An engine with the demo line, Speed and Settings known, Running unknown.
fn engine() -> (Script, UnboundedReceiver<FromScript>) {
    let (tx, rx) = unbounded_channel();
    let script = Script::start(tx);
    script.send(ToScript::Pages(vec![("Overview".into(), "overview".into()), ("RobotCell".into(), "robot-cell".into())]));
    script.send(ToScript::Objects(vec![line(Vec::new(), Vec::new())]));
    script.send(ToScript::Screen { session: 7, values: vec![("Line.jogMode".into(), value!("Joint"))] });
    script.send(ToScript::values(vec![
        ("Line.count".into(), Some(value!(0))),
        ("Line.Speed".into(), Some(value!(1.0))),
        ("Line.Running".into(), None),
        ("Line.Settings".into(), Some(value!({ "mode": "Auto", "target": 120 }))),
        ("Line.Joints".into(), Some(value!({ "position": [0.5, 1.5] }))),
        ("Line.Target".into(), Some(value!(3))),
    ]));
    (script, rx)
}

/// Everything run `run` says, up to and including its end.
fn until_done(rx: &mut UnboundedReceiver<FromScript>, run: u64) -> Vec<FromScript> {
    let mut out = Vec::new();
    let start = std::time::Instant::now();
    loop {
        match rx.try_recv() {
            Ok(msg) => {
                let done = matches!(&msg, FromScript::Done { run: r, .. } if *r == run);
                out.push(msg);
                if done {
                    return out;
                }
            }
            Err(_) if start.elapsed() > Duration::from_secs(3) => panic!("run {run} never ended"),
            Err(_) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
}

fn writes(said: &[FromScript]) -> Vec<(String, Value)> {
    said.iter().filter_map(|m| if let FromScript::Write { alias, value, .. } = m { Some((alias.clone(), value.clone())) } else { None }).collect()
}

fn end(said: &[FromScript]) -> &End {
    said.iter().find_map(|m| if let FromScript::Done { end, .. } = m { Some(end) } else { None }).unwrap()
}

#[test]
fn rant_math_answers_a_handler_as_it_answers_a_page() {
    let (script, mut rx) = engine();
    let code = r#"
        const pose = { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
        log(math.poseApply(math.poseInverse(pose), pose.position).x);
        log(math.pointsBounds([{ x: 1, y: 0, z: 0 }, { x: -1, y: 2, z: 5 }]).max.z);
        log(math.planeRaycast({ position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } }, { origin: { x: 0, y: 0, z: 5 }, direction: { x: 0, y: 0, z: 1 } }));
        log(math.axesPointTo(math.axesOf("Unity"), { x: 1, y: 0, z: 0 }).z);
        const line = math.shapeFromPolyline([{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]);
        log(math.shapeDistance(line, { x: 1, y: 3, z: 0 }));
        try { math.matrix3x3Inverse([[0, 0, 0], [0, 0, 0], [0, 0, 0]]); } catch (e) { log(e.kind, e instanceof math.MathError); }
        const tree = math.kdtreeCreate([{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }]);
        log(math.kdtreeNearest(tree, { x: 4, y: 0, z: 0 }, 1)[0][0]);
    "#;
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    let logged: Vec<String> = said.iter().filter_map(|m| if let FromScript::Log { text, .. } = m { Some(text.clone()) } else { None }).collect();
    assert_eq!(end(&said), &End::Ok);
    assert_eq!(logged, ["0", "5", "null", "1", "3", "Degenerate true", "1"]);
}

#[test]
fn making_rant_math_takes_little_of_a_handlers_budget() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "const t = Date.now(); const k = Object.keys(math).length; log(k > 400, Date.now() - t < 25);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    assert!(until_done(&mut rx, 1).iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "true true")));
}

#[test]
fn a_run_that_leaves_rant_math_alone_makes_none() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "log(Object.getOwnPropertyDescriptor(globalThis, 'math').get !== undefined);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    assert!(until_done(&mut rx, 1).iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "true")));
}

#[test]
fn a_run_writes_what_it_sets_when_it_ends() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = Speed + 1;\nSpeed = Speed * 2;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Line.Speed".to_string(), value!(4))]);
    assert_eq!(end(&said), &End::Ok);
}

#[test]
fn state_reads_by_its_name_over_others_from_its_start_then_its_screens_value() {
    let (script, mut rx) = engine();
    let lit = Variable { name: "lit".into(), start: value!(false), per: Per::Screen };
    let shared = Variable { name: "count".into(), start: value!(10), per: Per::Hmi };
    let bound = || vec![("@o/e1/lit#2".to_string(), lit.clone()), ("@o/count".to_string(), shared.clone())];
    // count is the HMI's variable too, which the page's count hides
    let code = "log(lit, count);\nlit = !lit;\ncount = count + 1;\nSettings.mode = \"Manual\";";
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: bound(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(end(&said), &End::Ok);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "false 10")));
    let wrote = writes(&said);
    assert_eq!(wrote[..2], [("@o/e1/lit#2".to_string(), value!(true)), ("@o/count".to_string(), value!(11))]);
    // what the run wrote is held, its screen's for state each screen keeps
    script.send(ToScript::Run { run: 2, session: Some(7), code: "log(lit, count);".into(), p: Value::Null, at: None, bound: bound(), own: own(), came: None, takes: Vec::new() });
    assert!(until_done(&mut rx, 2).iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "true 11")));
    script.send(ToScript::Run { run: 3, session: Some(8), code: "log(lit, count);".into(), p: Value::Null, at: None, bound: bound(), own: own(), came: None, takes: Vec::new() });
    assert!(until_done(&mut rx, 3).iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "false 11")));
    script.send(ToScript::Forget(vec!["@o/count".into()]));
    script.send(ToScript::Run { run: 4, session: Some(7), code: "log(count);".into(), p: Value::Null, at: None, bound: bound(), own: own(), came: None, takes: Vec::new() });
    assert!(until_done(&mut rx, 4).iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "10")));
    script.send(ToScript::Run { run: 5, session: Some(7), code: "log(count);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    assert!(until_done(&mut rx, 5).iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "0")));
}

#[test]
fn values_reach_code_as_js_values_and_come_back_whole() {
    let (script, mut rx) = engine();
    let image = Value::map([("width", 2u32.into()), ("data", Value::Bytes(vec![0, 7, 255]))]);
    script.send(ToScript::values(vec![("Line.Settings".into(), Some(Value::map([("image", image), ("count", Value::Int(u64::MAX.into()))])))]));
    let code = "log(Settings.image.data instanceof Uint8Array, Settings.image.data[2], typeof Settings.count);\n\
                Settings = { image: { width: 3, data: new Uint8Array([9, 8]) }, count: Settings.count - 1n };";
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(end(&said), &End::Ok);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "true 255 bigint")));
    let written = Value::map([("image", Value::map([("width", 3.into()), ("data", Value::Bytes(vec![9, 8]))])), ("count", Value::Int((u64::MAX - 1).into()))]);
    assert_eq!(writes(&said), [("Line.Settings".to_string(), written)]);

    script.send(ToScript::Run { run: 2, session: Some(7), code: "Speed = 2n ** 70n;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    assert!(matches!(end(&until_done(&mut rx, 2)), End::Fault(text) if text.contains("past what a whole number holds")));
}

#[test]
fn a_function_is_never_a_value() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Settings = { mode: () => 1 };".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert!(matches!(end(&said), End::Fault(text) if text.contains("function cannot be a value")), "{:?}", end(&said));
}

#[test]
fn fields_set_together_go_out_as_one_value() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Settings.target = 5;\nconst s = Settings;\ns.mode = \"Manual\";".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Line.Settings".to_string(), value!({ "mode": "Manual", "target": 5 }))]);
}

#[test]
fn reading_an_unknown_value_stops_the_run_and_drops_its_writes() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 9;\nif (Running) Speed = 10;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert!(writes(&said).is_empty());
    assert_eq!(end(&said), &End::Unknown("Line.Running".into()));
}

#[test]
fn mistakes_say_what_and_where() {
    let (script, mut rx) = engine();
    let cases = [
        ("Target = 1;", "Line.Target is imported to read. Import it to write to change it. (line 1)"),
        ("Joints = 1;", "Line.Joints is not a variable, so it cannot be set (line 1)"),
        ("\nSped = 1;", "Sped names no object, member or state (line 2)"),
        ("Speed = ;", "Unexpected token (line 1)"),
        ("Speed = 1;
if (", "Unexpected token (line 2)"),
        ("Speed = vec(1, 2) + vec(1, 2, 3);", "a 2D vector and a 3D vector cannot be added (line 1)"),
        ("while (true) {}", "it ran 50 ms without waiting, so it was stopped"),
        ("null.x;", "cannot read property 'x' of null (line 1)"),
    ];
    for (n, (code, want)) in cases.iter().enumerate() {
        let run = n as u64 + 1;
        script.send(ToScript::Run { run, session: Some(7), code: code.to_string(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
        let said = until_done(&mut rx, run);
        assert_eq!(end(&said), &End::Fault(want.to_string()), "{code}");
    }
}

#[test]
fn a_call_goes_out_after_the_writes_before_it_and_its_answer_comes_back() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 3;\nconst r = await Reset();\nlog(\"answer\", r);\nSpeed = 4;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let first = rx.blocking_recv().unwrap();
    assert!(matches!(&first, FromScript::Write { alias, value, .. } if alias == "Line.Speed" && *value == value!(3)));
    let FromScript::Call { call, alias, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!((alias.as_str(), request), ("Line.Reset", value!({})));
    script.send(ToScript::Answer { call, outcome: Ok(value!({ "ok": true })) });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "answer {\"ok\":true}")));
    assert_eq!(writes(&said), [("Line.Speed".to_string(), value!(4))]);

    script.send(ToScript::Run { run: 2, session: Some(7), code: "try { await Reset(true); } catch (e) { log(e.status, e.message); }".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let FromScript::Call { call, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!(request, value!(true));
    script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "timeout".into(), message: "no answer".into() }) });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "timeout no answer")));

    script.send(ToScript::Run { run: 3, session: Some(7), code: "await Reset();".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let FromScript::Call { call, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "app_error".into(), message: "the belt is jammed".into() }) });
    let said = until_done(&mut rx, 3);
    assert_eq!(end(&said), &End::Fault("the belt is jammed (app error)".into()));
}

#[test]
fn a_task_call_hands_each_update_to_its_function_and_cancels() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "const n = await Fill(4, (p) => { count = p; });\nlog(\"filled\", n);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let FromScript::Call { call, alias, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!((alias.as_str(), request), ("Line.Fill", value!(4)));
    for share in [0.25, 0.5] {
        script.send(ToScript::Progress { call, value: value!(share) });
        let FromScript::Write { alias, value, .. } = rx.blocking_recv().unwrap() else { panic!("no write") };
        assert_eq!((alias.as_str(), value), ("Line.count", value!(share)), "each update runs the function, whose writes go out");
    }
    script.send(ToScript::Answer { call, outcome: Ok(value!(4)) });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "filled 4")));

    // what a call gives cancels that call, and the task's own cancel every call of it
    let code = "const job = Fill(9);\njob.cancel();\nFill.cancel();\ntry { await job; } catch (e) { log(e.status); }";
    script.send(ToScript::Run { run: 2, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let FromScript::Call { call, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert!(matches!(rx.blocking_recv().unwrap(), FromScript::Cancel { alias, call: Some(c), .. } if alias == "Line.Fill" && c == call));
    assert!(matches!(rx.blocking_recv().unwrap(), FromScript::Cancel { alias, call: None, .. } if alias == "Line.Fill"));
    script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "cancelled".into(), message: "stopped".into() }) });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "cancelled")));

    // a function that throws is told, and the call goes on
    script.send(ToScript::Run { run: 3, session: Some(7), code: "await Fill(2, () => { throw new Error(\"no bar\"); });\nlog(\"done\");".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let FromScript::Call { call, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    script.send(ToScript::Progress { call, value: value!(0.5) });
    assert!(matches!(rx.blocking_recv().unwrap(), FromScript::Fault { text, .. } if text.starts_with("no bar")));
    script.send(ToScript::Answer { call, outcome: Ok(value!(2)) });
    let said = until_done(&mut rx, 3);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "done")));
    assert_eq!(end(&said), &End::Ok);

    // only a task takes a function and cancels
    for (run, code, want) in [(4, "await Reset(() => 1);", "a function cannot be a value"), (5, "Reset.cancel();", "not a function")] {
        script.send(ToScript::Run { run, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
        let said = until_done(&mut rx, run);
        assert!(matches!(end(&said), End::Fault(text) if text.contains(want)), "{code}: {:?}", end(&said));
    }
}

#[test]
fn sleep_waits_and_writes_go_out_at_each_await() {
    let (script, mut rx) = engine();
    let start = std::time::Instant::now();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 5;\nawait sleep(60);\nSpeed = 6;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let first = rx.blocking_recv().unwrap();
    assert!(matches!(&first, FromScript::Write { value, .. } if *value == value!(5)));
    let said = until_done(&mut rx, 1);
    assert!(start.elapsed() >= Duration::from_millis(60));
    assert_eq!(writes(&said), [("Line.Speed".to_string(), value!(6))]);
}

#[test]
fn a_run_going_on_reads_what_another_wrote_before_it_waited_or_ended() {
    let (script, mut rx) = engine();
    // both wake from their sleeps together, each adding to what the other wrote
    for (run, session) in [(1, 7), (2, 8)] {
        script.send(ToScript::Run { run, session: Some(session), code: "await sleep(40);\ncount = count + 1;\nawait sleep(1);\ncount = count + 1;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    }
    let mut said = until_done(&mut rx, 1);
    if !said.iter().any(|m| matches!(m, FromScript::Done { run: 2, .. })) {
        said.extend(until_done(&mut rx, 2));
    }
    let counts: Vec<Value> = writes(&said).into_iter().filter(|(a, _)| a == "Line.count").map(|(_, v)| v).collect();
    assert_eq!(counts.last(), Some(&value!(4)), "{counts:?}");
    // one that throws sends nothing of what it wrote since it last waited
    script.send(ToScript::Run { run: 3, session: Some(7), code: "count = 10;\nawait sleep(1);\ncount = 20;\nthrow new Error(\"no\");".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 3);
    assert_eq!(writes(&said), [("Line.count".to_string(), value!(10))]);
}

#[test]
fn pages_open_and_close_by_name() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "open(Pages.RobotCell);\nopen(Pages.Overview, { replace: true });\nclose();\nclose({ ok: true });".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    let moves: Vec<String> = said
        .iter()
        .filter_map(|m| match m {
            FromScript::Open { page, replace, .. } => Some(format!("open {page} {replace}")),
            FromScript::Close { answer, .. } => Some(format!("close {answer}")),
            _ => None,
        })
        .collect();
    assert_eq!(moves, ["open robot-cell false", "open overview true", "close null", "close { ok: true }"]);

    script.send(ToScript::Run { run: 2, session: Some(7), code: "if (await open(Pages.RobotCell)) log(\"yes\");".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let FromScript::Open { call, .. } = rx.blocking_recv().unwrap() else { panic!("no open") };
    script.send(ToScript::Answer { call, outcome: Ok(value!(true)) });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "yes")));
}

#[test]
fn variables_read_and_write_as_their_screen_sees_them() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "count = count + 1;\njogMode = jogMode + \"!\";".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Line.count".to_string(), value!(1)), ("Line.jogMode".to_string(), value!("Joint!"))]);
    script.send(ToScript::Run { run: 2, session: None, code: "jogMode = \"Cartesian\";".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 2);
    assert_eq!(end(&said), &End::Fault("Line.jogMode is each screen's own, and this handler runs for no screen (line 1)".into()));
    script.send(ToScript::Run { run: 3, session: Some(8), code: "log(jogMode);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    assert_eq!(end(&until_done(&mut rx, 3)), &End::Unknown("Line.jogMode".into()));
}

#[test]
fn a_handler_reads_what_its_event_brought_as_p() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "log(p.on, p.value);".into(), p: value!({ "on": "knob", "value": 3 }), at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "knob 3")));
}

#[test]
fn a_repeated_elements_handler_reads_its_copy_as_index_and_item() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "log(index, item.name);".into(), p: Value::Null, at: Some((2, value!({ "name": "J3" }))), bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "2 J3")));
}

#[test]
fn conditions_are_judged_and_an_unknown_one_is_false() {
    let (script, mut rx) = engine();
    let c = |id: &str, condition: &str| Rule { id: id.into(), name: id.into(), when: When::Turns { condition: condition.into(), ms: 0, rate: None }, code: String::new() };
    let rules = vec![c("fast", "Speed > 0.5"), c("slow", "Speed <= 0.5"), c("running", "Running"), c("broken", "Speed >"), c("writes", "(Speed = 3) > 0")];
    script.send(ToScript::Objects(vec![line(Vec::new(), rules)]));
    let t = think(&script, &mut rx, &[]);
    assert_eq!(t.judged, truths(&[("broken", false), ("fast", true), ("running", false), ("slow", false), ("writes", false)]));
    assert!(matches!(t.problems.as_slice(), [(id, Level::Fault, why)] if id == "writes" && why.contains("only reads")), "{:?}", t.problems);
    // only those that read what changed are judged again, once their period passed
    script.send(ToScript::values(vec![("Line.Speed".into(), Some(value!(0.2)))]));
    std::thread::sleep(TICK);
    assert_eq!(think(&script, &mut rx, &[]).judged, truths(&[("fast", false), ("slow", true)]));
}

#[test]
fn a_topic_sends_after_the_writes_before_it_and_reads_its_latest() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 2;\nJog.send(1.75);\nlog(Joints.position[1]);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    let order: Vec<String> = said
        .iter()
        .filter_map(|m| match m {
            FromScript::Write { alias, .. } => Some(format!("write {alias}")),
            FromScript::Send { alias, value, .. } => Some(format!("send {alias} {value}")),
            FromScript::Log { text, .. } => Some(format!("log {text}")),
            _ => None,
        })
        .collect();
    assert_eq!(order, ["write Line.Speed", "send Line.Jog 1.75", "log 1.5"]);
    script.send(ToScript::Run { run: 2, session: Some(7), code: "Joints.send({});".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    assert_eq!(end(&until_done(&mut rx, 2)), &End::Fault("Line.Joints is imported to read. Import it to write to send on it. (line 1)".into()));
}

#[test]
fn a_message_is_passed_whole_or_by_its_fields() {
    let (script, mut rx) = engine();
    let form = |name: &str, fields: &[&str]| Form { name: name.into(), fields: fields.iter().map(|f| f.to_string()).collect() };
    script.send(ToScript::Forms(HashMap::from([("Line.Jog".into(), form("Vector3", &["x", "y", "z"])), ("Line.Reset".into(), form("ResetRequest", &["line"]))])));
    let mut sends = |code: &str, run: u64| {
        script.send(ToScript::Run { run, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
        until_done(&mut rx, run)
    };
    let sent = |said: &[FromScript]| said.iter().find_map(|m| if let FromScript::Send { value, .. } = m { Some(value.clone()) } else { None });
    assert_eq!(sent(&sends("Jog.send(1, 2, 3);", 1)), Some(value!({ "x": 1, "y": 2, "z": 3 })));
    assert_eq!(sent(&sends("Jog.send({ x: 1, y: 2, z: 3 });", 2)), Some(value!({ "x": 1, "y": 2, "z": 3 })));
    assert_eq!(end(&sends("Jog.send(1, 2);", 3)), &End::Fault("Line.Jog.send takes x, y, z, or one Vector3 with them (line 1)".into()));

    // a request of one field takes that field bare
    script.send(ToScript::Run { run: 4, session: Some(7), code: "await Reset(4);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let FromScript::Call { call, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!(request, value!({ "line": 4 }));
    script.send(ToScript::Answer { call, outcome: Ok(Value::Null) });
    until_done(&mut rx, 4);
}

#[test]
fn an_enum_reads_by_its_type_name_as_a_fresh_list_of_its_options() {
    let (script, mut rx) = engine();
    script.send(ToScript::Enums(vec![EnumInfo { name: "Job".into(), options: vec!["None".into(), "Pick".into()] }]));
    let code = r#"const o = Job.options; o.push("Place"); log(o, Job.options.length, Job.options.includes("Pick"));"#;
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == r#"["None","Pick","Place"] 2 true"#)), "the log was not the options");
    assert!(reserved("Math") && reserved("Pages") && reserved("sqrt") && reserved("emit") && reserved("link") && reserved("keys") && reserved("gamepads") && !reserved("Job"));
    assert!(reserved("class") && reserved("await") && reserved("let") && reserved("undefined") && !reserved("speed"));
}

#[test]
fn runs_do_not_share_names() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "globalThis.mine = 1;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    until_done(&mut rx, 1);
    script.send(ToScript::Run { run: 2, session: Some(7), code: "log(typeof mine);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "undefined")));
}

#[test]
fn code_does_math_on_numbers_vectors_turns_and_poses() {
    let (script, mut rx) = engine();
    let code = "count = sqrt(16) + clamp(5, 0, 3) + (vec(3, 4) * 2 - vec(0, 0)).length() / 2;
                const turned = fromEuler(0, 0, PI / 2) * vec(1, 0, 0);
                const pose = { position: vec(1, 2, 3), orientation: fromEuler(0, 0, PI / 2) };
                Settings = { mode: \"x\" + vec(1, 2), target: round(turned.y) + (pose * pose.inverse()).position.length() };";
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(end(&said), &End::Ok);
    assert_eq!(writes(&said), [("Line.count".to_string(), value!(12)), ("Line.Settings".to_string(), value!({ "mode": "x(1, 2)", "target": 1 }))]);

    script.send(ToScript::Objects(vec![line(vec![computed("reach", "(vec(Speed, 0, 0) * 3).length()", None)], Vec::new())]));
    assert_eq!(think(&script, &mut rx, &[]).computed, values(&[("reach", Some(value!(3)))]));
}

fn computed(name: &str, get: &str, set: Option<(&str, &str)>) -> Computed {
    let set = set.map(|(target, value)| crate::project::Setter { target: target.into(), value: value.into() });
    Computed { name: name.into(), get: get.into(), set, rate: None, unit: None, note: None }
}

/// The backend's tick, the period of what names no rate.
const TICK: Duration = Duration::from_millis(34);

/// What the readers worked out, each as it last did, by key, and the problems they met.
#[derive(Default)]
struct Thoughts {
    computed: BTreeMap<String, Option<Value>>,
    judged: BTreeMap<String, bool>,
    sampled: BTreeMap<String, Option<Value>>,
    problems: Vec<(String, Level, String)>,
}

/// Asks the readers to work out what is due, with the records named, and gives all they worked
/// out since the last ask, once nothing runs and nothing more may start.
fn think(script: &Script, rx: &mut UnboundedReceiver<FromScript>, sample: &[&str]) -> Thoughts {
    script.think(sample.iter().map(|name| name.to_string()).collect());
    let start = std::time::Instant::now();
    while !script.readers.idle() {
        assert!(start.elapsed() < Duration::from_secs(5), "the readers never went idle");
        std::thread::sleep(Duration::from_millis(2));
    }
    let mut t = Thoughts::default();
    while let Ok(msg) = rx.try_recv() {
        if let FromScript::Thought { computed, judged, sampled, problems } = msg {
            t.computed.extend(computed);
            t.judged.extend(judged);
            t.sampled.extend(sampled);
            t.problems.extend(problems);
        }
    }
    t
}

/// Values by their name on the line.
fn values(list: &[(&str, Option<Value>)]) -> BTreeMap<String, Option<Value>> {
    list.iter().map(|(name, v)| (format!("Line.{name}"), v.clone())).collect()
}

fn truths(list: &[(&str, bool)]) -> BTreeMap<String, bool> {
    list.iter().map(|(id, truth)| (id.to_string(), *truth)).collect()
}

fn keys<T>(map: &BTreeMap<String, T>) -> Vec<&str> {
    map.keys().map(String::as_str).collect()
}

/// The next message of the kind `pick` takes, skipping the rest.
fn next<T>(rx: &mut UnboundedReceiver<FromScript>, pick: impl Fn(FromScript) -> Option<T>) -> T {
    let start = std::time::Instant::now();
    loop {
        match rx.try_recv() {
            Ok(msg) => {
                if let Some(t) = pick(msg) {
                    return t;
                }
            }
            Err(_) if start.elapsed() > Duration::from_secs(3) => panic!("nothing came"),
            Err(_) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
}

#[test]
fn computed_values_are_worked_out_in_any_order_and_unknown_while_what_they_read_is() {
    let (script, mut rx) = engine();
    // half reads percent, which comes after it in the list
    script.send(ToScript::Objects(vec![line(vec![
        computed("half", "percent / 2", None),
        computed("percent", "Speed * 100", Some(("Speed", "v / 100"))),
        computed("on", "Running ? 1 : 0", None),
    ], Vec::new())]));
    let got = think(&script, &mut rx, &[]).computed;
    assert_eq!(got, values(&[("half", Some(value!(50))), ("on", None), ("percent", Some(value!(100)))]));

    // handlers read them as any value, as the loop sends them back, and a write goes back
    // through the setter
    script.send(ToScript::values(got));
    script.send(ToScript::Run { run: 1, session: Some(7), code: "count = half; percent = 250;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Line.count".to_string(), value!(50)), ("Line.percent".to_string(), value!(250))]);
    script.send(ToScript::Invert { session: Some(7), name: "Line.percent".into(), v: value!(250) });
    let (target, value) = next(&mut rx, |m| if let FromScript::Inverted { target, value, .. } = m { Some((target, value)) } else { None });
    assert_eq!((target.as_str(), value), ("Line.Speed", Ok(value!(2.5))));
}

#[test]
fn a_computed_value_is_worked_out_again_only_once_what_it_read_changed_or_while_it_reads_the_clock() {
    let (script, mut rx) = engine();
    script.send(ToScript::Objects(vec![line(vec![
        computed("percent", "Speed * 100", None),
        computed("aim", "Target + 1", None),
        computed("blink", "Number.isInteger(time.now) ? Speed : 0", None),
    ], Vec::new())]));
    assert_eq!(keys(&think(&script, &mut rx, &[]).computed), ["Line.aim", "Line.blink", "Line.percent"]);
    std::thread::sleep(TICK);
    assert_eq!(keys(&think(&script, &mut rx, &[]).computed), ["Line.blink"], "only what reads the clock goes again");
    script.send(ToScript::values(vec![("Line.Target".into(), Some(value!(4)))]));
    std::thread::sleep(TICK);
    assert_eq!(think(&script, &mut rx, &[]).computed, values(&[("aim", Some(value!(5))), ("blink", Some(value!(1)))]));
    // the loop sends a computed value back as it took it, which changes nothing
    script.send(ToScript::values(vec![("Line.percent".into(), Some(value!(100)))]));
    std::thread::sleep(TICK);
    assert_eq!(keys(&think(&script, &mut rx, &[]).computed), ["Line.blink"]);
}

#[test]
fn a_computed_value_or_a_condition_is_worked_out_at_its_rate_at_the_most_and_within_its_period() {
    let (script, mut rx) = engine();
    let rated = |name: &str, get: &str, rate: u16| Computed { rate: Some(rate), ..computed(name, get, None) };
    let busy = |ms: u32| format!("(() => {{ const t = Date.now(); while (Date.now() - t < {ms}); return Speed; }})()");
    let rule = Rule { id: "h1".into(), name: "Lit".into(), when: When::Turns { condition: "time.now > 0".into(), ms: 0, rate: Some(5) }, code: String::new() };
    script.send(ToScript::Objects(vec![line(vec![rated("heavy", &busy(120), 5), computed("over", &busy(100), None), rated("slow", "time.now > 0 ? Speed : 0", 5)], vec![rule])]));
    let t = think(&script, &mut rx, &[]);
    assert_eq!(keys(&t.computed), ["Line.heavy", "Line.over", "Line.slow"]);
    assert_eq!(t.judged, truths(&[("h1", true)]));
    let said = |key: &str| t.problems.iter().filter(|(k, _, _)| k == key).map(|(_, l, w)| (*l, w.as_str())).collect::<Vec<_>>();
    assert_eq!(said("Line.slow"), []);
    assert_eq!(said("Line.heavy"), [(Level::Warn, "it ran over half the 200 ms its rate gives it")], "a fifth of a second gives it 200 ms");
    assert_eq!(said("Line.over"), [(Level::Fault, "it ran all the 33 ms its rate gives it, so it was stopped")]);
    assert_eq!(t.computed["Line.over"], None, "a stopped value is unknown");
    // what reads the clock goes again only once its period passed, which heavy's time did not
    let t = think(&script, &mut rx, &[]);
    assert!(t.computed.is_empty() && t.judged.is_empty(), "{:?} {:?}", t.computed, t.judged);
    std::thread::sleep(Duration::from_millis(200));
    let t = think(&script, &mut rx, &[]);
    assert_eq!(keys(&t.computed), ["Line.slow"]);
    assert_eq!(t.judged, truths(&[("h1", true)]));
}

#[test]
fn a_record_runs_within_the_time_between_its_samples() {
    let (script, mut rx) = engine();
    let mut o = line(Vec::new(), Vec::new());
    o.records = vec![
        crate::project::Record { name: "fast".into(), source: "(() => { const t = Date.now(); while (Date.now() - t < 100); return 1; })()".into(), every_ms: 50, keep_s: 10 },
        crate::project::Record { name: "calm".into(), source: "(() => { const t = Date.now(); while (Date.now() - t < 100); return 2; })()".into(), every_ms: 1000, keep_s: 10 },
    ];
    script.send(ToScript::Objects(vec![o]));
    let t = think(&script, &mut rx, &["Line.fast", "Line.calm"]);
    assert_eq!(t.sampled, values(&[("calm", Some(value!(2))), ("fast", None)]));
    assert_eq!(t.problems, [("Line.fast".to_string(), Level::Fault, "it ran all the 50 ms between its samples, so it was stopped".to_string())]);
}

#[test]
fn what_runs_long_holds_up_no_handler_and_no_other_computed_value() {
    let (script, mut rx) = engine();
    let heavy = Computed { rate: Some(5), ..computed("heavy", "(() => { const t = Date.now(); while (Date.now() - t < 150); return Speed; })()", None) };
    script.send(ToScript::Objects(vec![line(vec![heavy, computed("double", "Speed * 2", None)], Vec::new())]));
    script.send(ToScript::Run { run: 1, session: Some(7), code: "count = 1;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let worked = |m: &FromScript, name: &str| matches!(m, FromScript::Thought { computed, .. } if computed.iter().any(|(n, _)| n == name));
    let said = until_done(&mut rx, 1);
    assert!(!said.iter().any(|m| worked(m, "Line.heavy")), "the handler waited for the heavy value");
    let mut double = said.iter().any(|m| worked(m, "Line.double"));
    loop {
        let m = next(&mut rx, |m| matches!(m, FromScript::Thought { .. }).then_some(m));
        if worked(&m, "Line.heavy") {
            break;
        }
        double |= worked(&m, "Line.double");
    }
    assert!(double, "the double value waited for the heavy one");
}

#[test]
fn what_waits_over_its_period_for_a_worker_is_told() {
    let (script, mut rx) = engine();
    // as many heavy values as there are workers hold them all, so the light one starts late, but
    // its first run since the code changed waits on new readers and is not told
    let heavy = |i: usize| Computed { rate: Some(5), ..computed(&format!("heavy{i}"), "(() => { const t = Date.now(); while (Date.now() - t < 80); return Speed; })()", None) };
    let mut list: Vec<Computed> = (0..readers::workers()).map(heavy).collect();
    list.push(computed("light", "Speed * 2", None));
    script.send(ToScript::Objects(vec![line(list, Vec::new())]));
    let t = think(&script, &mut rx, &[]);
    assert_eq!((t.computed["Line.light"].clone(), t.problems), (Some(value!(2)), Vec::new()));
    std::thread::sleep(Duration::from_millis(200));
    script.send(ToScript::values(vec![("Line.Speed".into(), Some(value!(2)))]));
    let t = think(&script, &mut rx, &[]);
    assert_eq!(t.computed["Line.light"], Some(value!(4)));
    assert_eq!(t.problems, [("Line.light".to_string(), Level::Warn, "it started over 33 ms late, as other code held every worker".to_string())]);
}

#[test]
fn a_value_is_copied_into_code_once_till_something_changes() {
    let (script, mut rx) = engine();
    // read whole each time, the list would take seconds
    let list: Vec<Value> = (0..5000).map(Value::Int).collect();
    script.send(ToScript::values(vec![("Line.Target".into(), Some(Value::List(list)))]));
    let sum = "(() => { let s = 0; for (let i = 0; i < Target.length; i++) s += Target[i]; return s; })()";
    script.send(ToScript::Objects(vec![line(vec![Computed { rate: Some(1), ..computed("sum", sum, None) }], Vec::new())]));
    let t = think(&script, &mut rx, &[]);
    assert_eq!(t.computed, values(&[("sum", Some(value!(12497500)))]));
    assert!(t.problems.is_empty(), "{:?}", t.problems);
    // a copy changed in place lets go of it, and a write is read back
    let code = "const s = Settings;\ndelete s.mode;\nlog(Settings.mode, s.mode);\nSettings.target = 7;\nlog(Settings.target, s.target);";
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(end(&said), &End::Ok);
    let logs: Vec<&str> = said.iter().filter_map(|m| if let FromScript::Log { text, .. } = m { Some(text.as_str()) } else { None }).collect();
    assert_eq!(logs, ["Auto undefined", "7 120"]);
}

#[test]
fn a_handler_is_told_when_it_runs_long_and_stopped_at_its_limit_after_it_waited_too() {
    let (script, mut rx) = engine();
    let busy = "const t = Date.now(); while (Date.now() - t < 35);";
    let warned = |said: &[FromScript]| said.iter().position(|m| matches!(m, FromScript::Warn { text, .. } if text == "it ran over 25 ms without waiting, half of what it may"));
    let done = |said: &[FromScript]| said.iter().position(|m| matches!(m, FromScript::Done { .. }));
    for (run, code) in [(1, busy.to_owned()), (2, format!("await sleep(1);\n{busy}")), (3, format!("await null;\n{busy}"))] {
        script.send(ToScript::Run { run, session: Some(7), code, p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
        let said = until_done(&mut rx, run);
        assert_eq!(end(&said), &End::Ok);
        assert!(warned(&said) < done(&said) && warned(&said).is_some(), "run {run} is told before it ends");
    }
    // code that runs on after it waited is stopped too, and ends
    for (run, code) in [(4, "await sleep(1);\nwhile (true) {}"), (5, "await Peek();\nwhile (true) {}"), (6, "for (;;) await null;")] {
        script.send(ToScript::Run { run, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
        if run == 5 {
            let call = next(&mut rx, |m| if let FromScript::Call { call, .. } = m { Some(call) } else { None });
            script.send(ToScript::Answer { call, outcome: Ok(Value::Null) });
        }
        let said = until_done(&mut rx, run);
        assert_eq!(end(&said), &End::Fault("it ran 50 ms without waiting, so it was stopped".into()), "{code}");
        assert!(warned(&said).is_none(), "a stopped run is not told it ran long too");
    }
    // the engine goes on
    script.send(ToScript::Run { run: 7, session: Some(7), code: "count = 1;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    assert_eq!(writes(&until_done(&mut rx, 7)), [("Line.count".to_string(), value!(1))]);
}

#[test]
fn a_computed_value_that_fails_or_runs_too_long_says_why() {
    let (script, mut rx) = engine();
    script.send(ToScript::Objects(vec![line(vec![
        computed("broken", "Speed.nope.deeper", None),
        computed("slow", "(() => { const t = Date.now(); while (Date.now() - t < 1000); return 1; })()", None),
        computed("unknown", "Running", None),
    ], Vec::new())]));
    let Thoughts { computed: got, problems: faults, .. } = think(&script, &mut rx, &[]);
    assert!(got.values().all(Option::is_none), "{got:?}");
    let why = |key: &str| faults.iter().find(|(k, _, _)| k == key).map(|(_, _, w)| w.clone()).unwrap_or_default();
    assert!(why("Line.broken").contains("deeper"), "{faults:?}");
    assert_eq!(why("Line.slow"), "it ran all the 33 ms its rate gives it, so it was stopped", "{faults:?}");
    assert_eq!(faults.len(), 2, "reading an unknown value is no fault: {faults:?}");
}

#[test]
fn an_imports_own_objects_and_lists_are_values_whole_filtered_or_picked() {
    let (script, mut rx) = engine();
    let groups = value!([{ "name": "a", "on": true }, { "name": "b", "on": false }]);
    script.send(ToScript::values(vec![("Line.Target".into(), Some(groups.clone()))]));
    script.send(ToScript::Objects(vec![line(vec![
        computed("all", "Target", None),
        computed("on", "Target.filter((g) => g.on)", None),
        computed("first", "Target[0]", None),
        computed("joints", "Joints", None),
        computed("jog", "Jog", None),
        computed("after", "Speed + 1", None),
    ], Vec::new())]));
    let want = values(&[
        ("all", Some(groups)),
        ("on", Some(value!([{ "name": "a", "on": true }]))),
        ("first", Some(value!({ "name": "a", "on": true }))),
        ("joints", Some(value!({ "position": [0.5, 1.5] }))),
        ("jog", None),
        ("after", Some(value!(2))),
    ]);
    assert_eq!(think(&script, &mut rx, &[]).computed, want);

    // handlers write and send them too, and one read while unknown stops the run
    let code = "count = Target.filter((g) => !g.on);\nSettings = Joints;\nJog.send(Target[1]);";
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(end(&said), &End::Ok);
    assert_eq!(writes(&said), [("Line.count".to_string(), value!([{ "name": "b", "on": false }])), ("Line.Settings".to_string(), value!({ "position": [0.5, 1.5] }))]);
    assert!(said.iter().any(|m| matches!(m, FromScript::Send { value, .. } if *value == value!({ "name": "b", "on": false }))));
    script.send(ToScript::Run { run: 2, session: Some(7), code: "count = Jog;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 2);
    assert!(writes(&said).is_empty());
    assert_eq!(end(&said), &End::Unknown("Line.Jog".into()));
}

#[test]
fn a_computed_value_only_reads_and_one_without_a_setter_takes_no_write() {
    let (script, mut rx) = engine();
    script.send(ToScript::Objects(vec![line(vec![computed("sneaky", "(Speed = 5, 1)", None), computed("plain", "Speed + 1", None)], Vec::new())]));
    let t = think(&script, &mut rx, &[]);
    assert_eq!(t.computed, values(&[("plain", Some(value!(2))), ("sneaky", None)]));
    assert!(matches!(t.problems.as_slice(), [(key, Level::Fault, why)] if key == "Line.sneaky" && why.contains("only reads")), "{:?}", t.problems);
    script.send(ToScript::Run { run: 1, session: Some(7), code: "plain = 3;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert!(matches!(end(&said), End::Fault(text) if text.contains("no setter")));
}

#[test]
fn a_setter_that_does_not_undo_its_getter_is_caught_on_a_try() {
    let (script, mut rx) = engine();
    script.send(ToScript::Objects(vec![line(vec![computed("good", "Speed * 100", Some(("Speed", "v / 100"))), computed("bad", "Speed * 100", Some(("Speed", "v * 4")))], Vec::new())]));
    // a try writes values like the one the loop sent back
    let got = think(&script, &mut rx, &[]).computed;
    script.send(ToScript::values(got));
    // a good one says nothing, so the first warning is the bad one's
    script.send(ToScript::Try { session: 7, name: "Line.good".into() });
    script.send(ToScript::Try { session: 7, name: "Line.bad".into() });
    let warning = next(&mut rx, |m| if let FromScript::Tried { warning, .. } = m { Some(warning) } else { None });
    assert!(warning.starts_with("Line.bad's setter does not undo it: writing 1 reads back as 400"), "{warning}");
}

#[test]
fn a_handler_reads_what_the_api_lists_and_nothing_more() {
    // what JavaScript has without the HMI, and what the list says a page's handler reads
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    let (standard, listed, theirs) = ctx
        .with(|ctx| {
            let standard: Vec<String> = ctx.eval("Object.getOwnPropertyNames(globalThis)")?;
            let api_in: Function = api_module(&ctx)?.get("apiIn")?;
            let listed: Vec<Object> = api_in.call(("handler",))?;
            let name = |a: &Object| a.get::<_, String>("name");
            let theirs = listed.iter().filter(|a| a.get::<_, Option<bool>>("standard").ok().flatten() == Some(true)).map(name).collect::<rquickjs::Result<Vec<_>>>()?;
            let listed = listed.iter().filter(|a| a.get::<_, Option<bool>>("standard").ok().flatten() != Some(true)).map(name).collect::<rquickjs::Result<Vec<_>>>()?;
            Ok::<_, rquickjs::Error>((standard, listed, theirs))
        })
        .unwrap();
    for name in &theirs {
        assert!(standard.contains(name), "{name} is listed as JavaScript's own, which it is not");
    }
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "log(Object.getOwnPropertyNames(globalThis).join(\" \"));".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    let all = said.iter().find_map(|m| if let FromScript::Log { text, .. } = m { Some(text.clone()) } else { None }).unwrap();
    let project = ["p", "Line", "Speed", "Running", "Settings", "Joints", "Jog", "Target", "Peek", "Reset", "Fill", "jogMode", "count"];
    let mut own: Vec<&str> = all.split(' ').filter(|n| !n.starts_with("__") && !project.contains(n) && !standard.iter().any(|s| s == n)).collect();
    own.sort();
    let mut listed: Vec<&str> = listed.iter().map(String::as_str).collect();
    listed.sort();
    assert_eq!(own, listed, "a handler reads names the list leaves out, or the list names one it does not read");
}

#[test]
fn colours_lighten_darken_fade_mix_and_scale() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "log(\"#224493\".lighten(0), \"#224493\".lighten(0.2), \"#224493\".lighten(1), \"#224493\".darken(1), \"#808080\" * 0.5, \"#229834\" * 1.2, 0.8 * \"#229834\", \"#ffffff\" * \"#ff8000\", \"#f00\".alpha(0.5), \"#ff000080\".fade(0.5), mix(\"#000000\", \"#ffffff\", 1), \"#ff0000\".mix(\"#0000ff\"), \"#808080\" / 2);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    let text = said.iter().find_map(|m| if let FromScript::Log { text, .. } = m { Some(text.as_str()) } else { None });
    assert_eq!(text, Some("#224493 #4a69aa #ffffff #000000 #404040 #29b63e #1b7a2a #ff8000 #ff000080 #ff000040 #ffffff #8c53a2 #404040"));
}

#[test]
fn code_outside_reads_an_objects_global_members_and_its_functions_run_on_their_own() {
    let (script, mut rx) = engine();
    let mut o = line(Vec::new(), Vec::new());
    o.functions = vec![object::Function { name: "restart".into(), takes: vec!["job".into()], code: "return job + \"ed\";".into() }];
    o.local = vec!["Target".into()];
    script.send(ToScript::Objects(vec![o]));
    let code = "Line.Speed = Line.Speed + 1;\nlog(typeof Line.Target, typeof Speed);\nlog(await Line.restart(\"pick\"));";
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None, bound: Vec::new(), own: None, came: None, takes: Vec::new() });
    // a Local member and a bare name are not there, and the write goes out before the call
    assert_eq!(next(&mut rx, |m| if let FromScript::Log { text, .. } = m { Some(text) } else { None }), "undefined undefined");
    assert!(matches!(rx.blocking_recv().unwrap(), FromScript::Write { alias, value, .. } if alias == "Line.Speed" && value == value!(2)));
    let FromScript::Run { run, call, function, args } = rx.blocking_recv().unwrap() else { panic!("no run") };
    assert_eq!((run, function.as_str(), args), (1, "Line.restart", vec![value!("pick")]));
    // the function's own run reads what it takes and gives back what it returns
    script.send(ToScript::Run { run: 2, session: Some(7), code: "return job + \"ed\";".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: vec![("job".into(), value!("pick"))] });
    let returned = until_done(&mut rx, 2).into_iter().find_map(|m| if let FromScript::Done { value, .. } = m { Some(value) } else { None });
    assert_eq!(returned, Some(value!("picked")));
    script.send(ToScript::Answer { call, outcome: Ok(value!("picked")) });
    assert!(until_done(&mut rx, 1).iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "picked")));
    // and only code outside the object is kept from its Local members
    script.send(ToScript::Run { run: 3, session: Some(7), code: "log(Target, Line.Target);".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    assert!(until_done(&mut rx, 3).iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "3 3")));
}
