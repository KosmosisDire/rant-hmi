use std::time::Duration;

use crate::value::value;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

use super::*;
use crate::logic::Rule;
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
    script.send(ToScript::Values(vec![
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
    script.send(ToScript::Values(vec![("Line.Settings".into(), Some(Value::map([("image", image), ("count", Value::Int(u64::MAX.into()))])))]));
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
        ("while (true) {}", "it ran 250 ms without waiting, so it was stopped"),
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
    let c = |id: &str, condition: &str| Rule { id: id.into(), name: id.into(), when: When::Turns { condition: condition.into(), ms: 0 }, code: String::new() };
    let rules = vec![c("fast", "Speed > 0.5"), c("slow", "Speed <= 0.5"), c("running", "Running"), c("broken", "Speed >"), c("writes", "(Speed = 3) > 0")];
    script.send(ToScript::Objects(vec![line(Vec::new(), rules)]));
    script.send(ToScript::Judge);
    let FromScript::Judged(truths) = rx.blocking_recv().unwrap() else { panic!("no judgement") };
    assert_eq!(truths, [("fast".to_string(), true), ("slow".to_string(), false), ("running".to_string(), false), ("writes".to_string(), false)]);
    script.send(ToScript::Values(vec![("Line.Speed".into(), Some(value!(0.2)))]));
    script.send(ToScript::Judge);
    let FromScript::Judged(truths) = rx.blocking_recv().unwrap() else { panic!("no judgement") };
    assert_eq!(truths[0..2], [("fast".to_string(), false), ("slow".to_string(), true)]);
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
    script.send(ToScript::Compute);
    let got = next(&mut rx, |m| if let FromScript::Computed(list) = m { Some(list) } else { None });
    assert_eq!(got, [("Line.reach".to_string(), Some(value!(3)))]);
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
    script.send(ToScript::Objects(vec![line(vec![
        computed("half", "percent / 2", None),
        computed("percent", "Speed * 100", Some(("Speed", "v / 100"))),
        computed("on", "Running ? 1 : 0", None),
    ], Vec::new())]));
    script.send(ToScript::Compute);
    let got = next(&mut rx, |m| if let FromScript::Computed(list) = m { Some(list) } else { None });
    assert_eq!(got, [("Line.half".to_string(), Some(value!(50))), ("Line.percent".to_string(), Some(value!(100))), ("Line.on".to_string(), None)]);

    // handlers read them as any value, and a write goes back through the setter
    script.send(ToScript::Run { run: 1, session: Some(7), code: "count = half; percent = 250;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Line.count".to_string(), value!(50)), ("Line.percent".to_string(), value!(250))]);
    script.send(ToScript::Invert { session: Some(7), name: "Line.percent".into(), v: value!(250) });
    let (target, value) = next(&mut rx, |m| if let FromScript::Inverted { target, value, .. } = m { Some((target, value)) } else { None });
    assert_eq!((target.as_str(), value), ("Line.Speed", Ok(value!(2.5))));
}

#[test]
fn an_imports_own_objects_and_lists_are_values_whole_filtered_or_picked() {
    let (script, mut rx) = engine();
    let groups = value!([{ "name": "a", "on": true }, { "name": "b", "on": false }]);
    script.send(ToScript::Values(vec![("Line.Target".into(), Some(groups.clone()))]));
    script.send(ToScript::Objects(vec![line(vec![
        computed("all", "Target", None),
        computed("on", "Target.filter((g) => g.on)", None),
        computed("first", "Target[0]", None),
        computed("joints", "Joints", None),
        computed("jog", "Jog", None),
        computed("after", "Speed + 1", None),
    ], Vec::new())]));
    script.send(ToScript::Compute);
    let got = next(&mut rx, |m| if let FromScript::Computed(list) = m { Some(list) } else { None });
    let want = [
        ("all", Some(groups)),
        ("on", Some(value!([{ "name": "a", "on": true }]))),
        ("first", Some(value!({ "name": "a", "on": true }))),
        ("joints", Some(value!({ "position": [0.5, 1.5] }))),
        ("jog", None),
        ("after", Some(value!(2))),
    ];
    assert_eq!(got, want.map(|(name, v)| (format!("Line.{name}"), v)));

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
    script.send(ToScript::Compute);
    let got = next(&mut rx, |m| if let FromScript::Computed(list) = m { Some(list) } else { None });
    assert_eq!(got, [("Line.sneaky".to_string(), None), ("Line.plain".to_string(), Some(value!(2)))]);
    script.send(ToScript::Run { run: 1, session: Some(7), code: "plain = 3;".into(), p: Value::Null, at: None, bound: Vec::new(), own: own(), came: None, takes: Vec::new() });
    let said = until_done(&mut rx, 1);
    assert!(matches!(end(&said), End::Fault(text) if text.contains("no setter")));
}

#[test]
fn a_setter_that_does_not_undo_its_getter_is_caught_on_a_try() {
    let (script, mut rx) = engine();
    script.send(ToScript::Objects(vec![line(vec![computed("good", "Speed * 100", Some(("Speed", "v / 100"))), computed("bad", "Speed * 100", Some(("Speed", "v * 4")))], Vec::new())]));
    script.send(ToScript::Compute);
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
            let api_in: Function = module(&ctx, API)?.get("apiIn")?;
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
