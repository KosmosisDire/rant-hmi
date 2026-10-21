use std::time::Duration;

use crate::value::value;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

use super::*;

fn import(alias: &str, kind: Kind, intent: Intent) -> Import {
    Import { alias: alias.into(), entity: format!("Line1/{alias}"), kind, intent }
}

/// An engine with the demo line's imports, Speed and Settings known, Running unknown.
fn engine() -> (Script, UnboundedReceiver<FromScript>) {
    let (tx, rx) = unbounded_channel();
    let script = Script::start(tx);
    script.send(ToScript::Pages(vec![("Overview".into(), "overview".into()), ("RobotCell".into(), "robot-cell".into())]));
    script.send(ToScript::Imports(vec![
        import("Speed", Kind::Variable, Intent::Write),
        import("Running", Kind::Variable, Intent::Write),
        import("Settings", Kind::Variable, Intent::Write),
        import("Joints", Kind::Topic, Intent::Read),
        import("Jog", Kind::Topic, Intent::Write),
        import("Target", Kind::Variable, Intent::Read),
        import("Peek", Kind::Function, Intent::Read),
        import("Reset", Kind::Function, Intent::Write),
    ]));
    script.send(ToScript::Variables(vec![
        Variable { name: "jogMode".into(), start: value!("Joint"), per: Per::Screen },
        Variable { name: "count".into(), start: value!(0), per: Per::Hmi },
    ]));
    script.send(ToScript::Screen { session: 7, values: vec![("jogMode".into(), value!("Joint"))] });
    script.send(ToScript::Values(vec![
        ("count".into(), Some(value!(0))),
        ("Speed".into(), Some(value!(1.0))),
        ("Running".into(), None),
        ("Settings".into(), Some(value!({ "mode": "Auto", "target": 120 }))),
        ("Joints".into(), Some(value!({ "position": [0.5, 1.5] }))),
        ("Target".into(), Some(value!(3))),
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
fn a_run_writes_what_it_sets_when_it_ends() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = Speed + 1;\nSpeed = Speed * 2;".into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Speed".to_string(), value!(4))]);
    assert_eq!(end(&said), &End::Ok);
}

#[test]
fn values_reach_code_as_js_values_and_come_back_whole() {
    let (script, mut rx) = engine();
    let image = Value::map([("width", 2u32.into()), ("data", Value::Bytes(vec![0, 7, 255]))]);
    script.send(ToScript::Values(vec![("Settings".into(), Some(Value::map([("image", image), ("count", Value::Int(u64::MAX.into()))])))]));
    let code = "log(Settings.image.data instanceof Uint8Array, Settings.image.data[2], typeof Settings.count);\n\
                Settings = { image: { width: 3, data: new Uint8Array([9, 8]) }, count: Settings.count - 1n };";
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert_eq!(end(&said), &End::Ok);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "true 255 bigint")));
    let written = Value::map([("image", Value::map([("width", 3.into()), ("data", Value::Bytes(vec![9, 8]))])), ("count", Value::Int((u64::MAX - 1).into()))]);
    assert_eq!(writes(&said), [("Settings".to_string(), written)]);

    script.send(ToScript::Run { run: 2, session: Some(7), code: "Speed = 2n ** 70n;".into(), p: Value::Null, at: None });
    assert!(matches!(end(&until_done(&mut rx, 2)), End::Fault(text) if text.contains("past what a whole number holds")));
}

#[test]
fn a_function_is_never_a_value() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Settings = { mode: () => 1 };".into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert!(matches!(end(&said), End::Fault(text) if text.contains("function cannot be a value")), "{:?}", end(&said));
}

#[test]
fn fields_set_together_go_out_as_one_value() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Settings.target = 5;\nconst s = Settings;\ns.mode = \"Manual\";".into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Settings".to_string(), value!({ "mode": "Manual", "target": 5 }))]);
}

#[test]
fn reading_an_unknown_value_stops_the_run_and_drops_its_writes() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 9;\nif (Running) Speed = 10;".into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert!(writes(&said).is_empty());
    assert_eq!(end(&said), &End::Unknown("Running".into()));
}

#[test]
fn mistakes_say_what_and_where() {
    let (script, mut rx) = engine();
    let cases = [
        ("Target = 1;", "Target is imported to read. Import it to write to change it. (line 1)"),
        ("Joints = 1;", "Joints is not a variable, so it cannot be set (line 1)"),
        ("\nSped = 1;", "Sped names no mesh import, variable or record (line 2)"),
        ("Speed = ;", "Unexpected token (line 1)"),
        ("Speed = 1;
if (", "Unexpected token (line 2)"),
        ("Speed = vec(1, 2) + vec(1, 2, 3);", "a 2D vector and a 3D vector cannot be added (line 1)"),
        ("while (true) {}", "it ran 250 ms without waiting, so it was stopped"),
        ("null.x;", "cannot read property 'x' of null (line 1)"),
    ];
    for (n, (code, want)) in cases.iter().enumerate() {
        let run = n as u64 + 1;
        script.send(ToScript::Run { run, session: Some(7), code: code.to_string(), p: Value::Null, at: None });
        let said = until_done(&mut rx, run);
        assert_eq!(end(&said), &End::Fault(want.to_string()), "{code}");
    }
}

#[test]
fn a_call_goes_out_after_the_writes_before_it_and_its_answer_comes_back() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 3;\nconst r = await Reset();\nlog(\"answer\", r);\nSpeed = 4;".into(), p: Value::Null, at: None });
    let first = rx.blocking_recv().unwrap();
    assert!(matches!(&first, FromScript::Write { alias, value, .. } if alias == "Speed" && *value == value!(3)));
    let FromScript::Call { call, alias, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!((alias.as_str(), request), ("Reset", value!({})));
    script.send(ToScript::Answer { call, outcome: Ok(value!({ "ok": true })) });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "answer {\"ok\":true}")));
    assert_eq!(writes(&said), [("Speed".to_string(), value!(4))]);

    script.send(ToScript::Run { run: 2, session: Some(7), code: "try { await Reset(true); } catch (e) { log(e.status, e.message); }".into(), p: Value::Null, at: None });
    let FromScript::Call { call, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!(request, value!(true));
    script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "timeout".into(), message: "no answer".into() }) });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "timeout no answer")));

    script.send(ToScript::Run { run: 3, session: Some(7), code: "await Reset();".into(), p: Value::Null, at: None });
    let FromScript::Call { call, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "app_error".into(), message: "the belt is jammed".into() }) });
    let said = until_done(&mut rx, 3);
    assert_eq!(end(&said), &End::Fault("the belt is jammed (app error)".into()));
}

#[test]
fn sleep_waits_and_writes_go_out_at_each_await() {
    let (script, mut rx) = engine();
    let start = std::time::Instant::now();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 5;\nawait sleep(60);\nSpeed = 6;".into(), p: Value::Null, at: None });
    let first = rx.blocking_recv().unwrap();
    assert!(matches!(&first, FromScript::Write { value, .. } if *value == value!(5)));
    let said = until_done(&mut rx, 1);
    assert!(start.elapsed() >= Duration::from_millis(60));
    assert_eq!(writes(&said), [("Speed".to_string(), value!(6))]);
}

#[test]
fn pages_open_and_close_by_name() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "open(Pages.RobotCell);\nopen(Pages.Overview, { replace: true });\nclose();\nclose({ ok: true });".into(), p: Value::Null, at: None });
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

    script.send(ToScript::Run { run: 2, session: Some(7), code: "if (await open(Pages.RobotCell)) log(\"yes\");".into(), p: Value::Null, at: None });
    let FromScript::Open { call, .. } = rx.blocking_recv().unwrap() else { panic!("no open") };
    script.send(ToScript::Answer { call, outcome: Ok(value!(true)) });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "yes")));
}

#[test]
fn variables_read_and_write_as_their_screen_sees_them() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "count = count + 1;\njogMode = jogMode + \"!\";".into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("count".to_string(), value!(1)), ("jogMode".to_string(), value!("Joint!"))]);
    script.send(ToScript::Run { run: 2, session: None, code: "jogMode = \"Cartesian\";".into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 2);
    assert_eq!(end(&said), &End::Fault("jogMode is each screen's own, and this handler runs for no screen (line 1)".into()));
    script.send(ToScript::Run { run: 3, session: Some(8), code: "log(jogMode);".into(), p: Value::Null, at: None });
    assert_eq!(end(&until_done(&mut rx, 3)), &End::Unknown("jogMode".into()));
}

#[test]
fn a_handler_reads_what_its_event_brought_as_p() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "log(p.on, p.value);".into(), p: value!({ "on": "knob", "value": 3 }), at: None });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "knob 3")));
}

#[test]
fn a_repeated_elements_handler_reads_its_copy_as_index_and_item() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "log(index, item.name);".into(), p: Value::Null, at: Some((2, value!({ "name": "J3" }))) });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "2 J3")));
}

#[test]
fn conditions_are_judged_and_an_unknown_one_is_false() {
    let (script, mut rx) = engine();
    let c = |id: &str, cond: &str| (id.to_string(), cond.to_string());
    script.send(ToScript::Conditions(vec![c("fast", "Speed > 0.5"), c("slow", "Speed <= 0.5"), c("running", "Running"), c("broken", "Speed >"), c("writes", "(Speed = 3) > 0")]));
    script.send(ToScript::Judge);
    let FromScript::Judged(truths) = rx.blocking_recv().unwrap() else { panic!("no judgement") };
    assert_eq!(truths, [("fast".to_string(), true), ("slow".to_string(), false), ("running".to_string(), false), ("writes".to_string(), false)]);
    script.send(ToScript::Values(vec![("Speed".into(), Some(value!(0.2)))]));
    script.send(ToScript::Judge);
    let FromScript::Judged(truths) = rx.blocking_recv().unwrap() else { panic!("no judgement") };
    assert_eq!(truths[0..2], [("fast".to_string(), false), ("slow".to_string(), true)]);
}

#[test]
fn a_topic_sends_after_the_writes_before_it_and_reads_its_latest() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 2;\nJog.send(1.75);\nlog(Joints.position[1]);".into(), p: Value::Null, at: None });
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
    assert_eq!(order, ["write Speed", "send Jog 1.75", "log 1.5"]);
    script.send(ToScript::Run { run: 2, session: Some(7), code: "Joints.send({});".into(), p: Value::Null, at: None });
    assert_eq!(end(&until_done(&mut rx, 2)), &End::Fault("Joints is imported to read. Import it to write to send on it. (line 1)".into()));
}

#[test]
fn a_message_is_passed_whole_or_by_its_fields() {
    let (script, mut rx) = engine();
    let form = |name: &str, fields: &[&str]| Form { name: name.into(), fields: fields.iter().map(|f| f.to_string()).collect() };
    script.send(ToScript::Forms(HashMap::from([("Jog".into(), form("Vector3", &["x", "y", "z"])), ("Reset".into(), form("ResetRequest", &["line"]))])));
    let mut sends = |code: &str, run: u64| {
        script.send(ToScript::Run { run, session: Some(7), code: code.into(), p: Value::Null, at: None });
        until_done(&mut rx, run)
    };
    let sent = |said: &[FromScript]| said.iter().find_map(|m| if let FromScript::Send { value, .. } = m { Some(value.clone()) } else { None });
    assert_eq!(sent(&sends("Jog.send(1, 2, 3);", 1)), Some(value!({ "x": 1, "y": 2, "z": 3 })));
    assert_eq!(sent(&sends("Jog.send({ x: 1, y: 2, z: 3 });", 2)), Some(value!({ "x": 1, "y": 2, "z": 3 })));
    assert_eq!(end(&sends("Jog.send(1, 2);", 3)), &End::Fault("Jog.send takes x, y, z, or one Vector3 with them (line 1)".into()));

    // a request of one field takes that field bare
    script.send(ToScript::Run { run: 4, session: Some(7), code: "await Reset(4);".into(), p: Value::Null, at: None });
    let FromScript::Call { call, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!(request, value!({ "line": 4 }));
    script.send(ToScript::Answer { call, outcome: Ok(Value::Null) });
    until_done(&mut rx, 4);
}

#[test]
fn runs_do_not_share_names() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "globalThis.mine = 1;".into(), p: Value::Null, at: None });
    until_done(&mut rx, 1);
    script.send(ToScript::Run { run: 2, session: Some(7), code: "log(typeof mine);".into(), p: Value::Null, at: None });
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
    script.send(ToScript::Run { run: 1, session: Some(7), code: code.into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert_eq!(end(&said), &End::Ok);
    assert_eq!(writes(&said), [("count".to_string(), value!(12)), ("Settings".to_string(), value!({ "mode": "x(1, 2)", "target": 1 }))]);

    script.send(ToScript::Computed(vec![computed("reach", "(vec(Speed, 0, 0) * 3).length()", None)]));
    script.send(ToScript::Compute);
    let got = next(&mut rx, |m| if let FromScript::Computed(list) = m { Some(list) } else { None });
    assert_eq!(got, [("reach".to_string(), Some(value!(3)))]);
}

fn computed(name: &str, get: &str, set: Option<(&str, &str)>) -> Computed {
    let set = set.map(|(target, value)| crate::project::Setter { target: target.into(), value: value.into() });
    Computed { name: name.into(), get: get.into(), set, unit: None, note: None }
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
    script.send(ToScript::Computed(vec![
        computed("half", "percent / 2", None),
        computed("percent", "Speed * 100", Some(("Speed", "v / 100"))),
        computed("on", "Running ? 1 : 0", None),
    ]));
    script.send(ToScript::Compute);
    let got = next(&mut rx, |m| if let FromScript::Computed(list) = m { Some(list) } else { None });
    assert_eq!(got, [("half".to_string(), Some(value!(50))), ("percent".to_string(), Some(value!(100))), ("on".to_string(), None)]);

    // handlers read them as any value, and a write goes back through the setter
    script.send(ToScript::Run { run: 1, session: Some(7), code: "count = half; percent = 250;".into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("count".to_string(), value!(50)), ("percent".to_string(), value!(250))]);
    script.send(ToScript::Invert { session: Some(7), name: "percent".into(), v: value!(250) });
    let (target, value) = next(&mut rx, |m| if let FromScript::Inverted { target, value, .. } = m { Some((target, value)) } else { None });
    assert_eq!((target.as_str(), value), ("Speed", Ok(value!(2.5))));
}

#[test]
fn a_computed_value_only_reads_and_one_without_a_setter_takes_no_write() {
    let (script, mut rx) = engine();
    script.send(ToScript::Computed(vec![computed("sneaky", "(Speed = 5, 1)", None), computed("plain", "Speed + 1", None)]));
    script.send(ToScript::Compute);
    let got = next(&mut rx, |m| if let FromScript::Computed(list) = m { Some(list) } else { None });
    assert_eq!(got, [("sneaky".to_string(), None), ("plain".to_string(), Some(value!(2)))]);
    script.send(ToScript::Run { run: 1, session: Some(7), code: "plain = 3;".into(), p: Value::Null, at: None });
    let said = until_done(&mut rx, 1);
    assert!(matches!(end(&said), End::Fault(text) if text.contains("no setter")));
}

#[test]
fn a_setter_that_does_not_undo_its_getter_is_caught_on_a_try() {
    let (script, mut rx) = engine();
    script.send(ToScript::Computed(vec![computed("good", "Speed * 100", Some(("Speed", "v / 100"))), computed("bad", "Speed * 100", Some(("Speed", "v * 4")))]));
    script.send(ToScript::Compute);
    // a good one says nothing, so the first warning is the bad one's
    script.send(ToScript::Try { session: 7, name: "good".into() });
    script.send(ToScript::Try { session: 7, name: "bad".into() });
    let warning = next(&mut rx, |m| if let FromScript::Tried { warning, .. } = m { Some(warning) } else { None });
    assert!(warning.starts_with("bad's setter does not undo it: writing 1 reads back as 400"), "{warning}");
}
