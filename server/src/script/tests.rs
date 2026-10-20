use std::time::Duration;

use serde_json::json;
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
        import("Target", Kind::Variable, Intent::Read),
        import("Peek", Kind::Function, Intent::Read),
        import("Reset", Kind::Function, Intent::Write),
    ]));
    script.send(ToScript::Variables(vec![
        Variable { name: "jogMode".into(), start: json!("Joint"), per: Per::Screen },
        Variable { name: "count".into(), start: json!(0), per: Per::Hmi },
    ]));
    script.send(ToScript::Screen { session: 7, values: vec![("jogMode".into(), json!("Joint"))] });
    script.send(ToScript::Values(vec![
        ("count".into(), Some(json!(0))),
        ("Speed".into(), Some(json!(1.0))),
        ("Running".into(), None),
        ("Settings".into(), Some(json!({ "mode": "Auto", "target": 120 }))),
        ("Joints".into(), Some(json!({ "position": [0.5, 1.5] }))),
        ("Target".into(), Some(json!(3))),
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
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = Speed + 1;\nSpeed = Speed * 2;".into() });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Speed".to_string(), json!(4))]);
    assert_eq!(end(&said), &End::Ok);
}

#[test]
fn fields_set_together_go_out_as_one_value() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Settings.target = 5;\nconst s = Settings;\ns.mode = \"Manual\";".into() });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("Settings".to_string(), json!({ "mode": "Manual", "target": 5 }))]);
}

#[test]
fn reading_an_unknown_value_stops_the_run_and_drops_its_writes() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 9;\nif (Running) Speed = 10;".into() });
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
        ("await Peek();", "Peek is imported to read. Import it to write to call it. (line 1)"),
        ("\nSped = 1;", "Sped names no datapoint (line 2)"),
        ("Speed = ;", "unexpected token in expression: ';' (line 1)"),
        ("while (true) {}", "it ran 250 ms without waiting, so it was stopped"),
        ("null.x;", "cannot read property 'x' of null (line 1)"),
    ];
    for (n, (code, want)) in cases.iter().enumerate() {
        let run = n as u64 + 1;
        script.send(ToScript::Run { run, session: Some(7), code: code.to_string() });
        let said = until_done(&mut rx, run);
        assert_eq!(end(&said), &End::Fault(want.to_string()), "{code}");
    }
}

#[test]
fn a_call_goes_out_after_the_writes_before_it_and_its_answer_comes_back() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 3;\nconst r = await Reset();\nlog(\"answer\", r);\nSpeed = 4;".into() });
    let first = rx.blocking_recv().unwrap();
    assert!(matches!(&first, FromScript::Write { alias, value, .. } if alias == "Speed" && *value == json!(3)));
    let FromScript::Call { call, alias, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!((alias.as_str(), request), ("Reset", json!({})));
    script.send(ToScript::Answer { call, outcome: Ok(json!({ "ok": true })) });
    let said = until_done(&mut rx, 1);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "answer {\"ok\":true}")));
    assert_eq!(writes(&said), [("Speed".to_string(), json!(4))]);

    script.send(ToScript::Run { run: 2, session: Some(7), code: "try { await Reset(true); } catch (e) { log(e.status, e.message); }".into() });
    let FromScript::Call { call, request, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    assert_eq!(request, json!(true));
    script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "timeout".into(), message: "no answer".into() }) });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "timeout no answer")));

    script.send(ToScript::Run { run: 3, session: Some(7), code: "await Reset();".into() });
    let FromScript::Call { call, .. } = rx.blocking_recv().unwrap() else { panic!("no call") };
    script.send(ToScript::Answer { call, outcome: Err(CallFailure { status: "app_error".into(), message: "the belt is jammed".into() }) });
    let said = until_done(&mut rx, 3);
    assert_eq!(end(&said), &End::Fault("the belt is jammed (app error)".into()));
}

#[test]
fn sleep_waits_and_writes_go_out_at_each_await() {
    let (script, mut rx) = engine();
    let start = std::time::Instant::now();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "Speed = 5;\nawait sleep(60);\nSpeed = 6;".into() });
    let first = rx.blocking_recv().unwrap();
    assert!(matches!(&first, FromScript::Write { value, .. } if *value == json!(5)));
    let said = until_done(&mut rx, 1);
    assert!(start.elapsed() >= Duration::from_millis(60));
    assert_eq!(writes(&said), [("Speed".to_string(), json!(6))]);
}

#[test]
fn pages_open_and_close_by_name() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "open(Pages.RobotCell);\nopen(Pages.Overview, { replace: true });\nclose();\nclose({ ok: true });".into() });
    let said = until_done(&mut rx, 1);
    let moves: Vec<String> = said
        .iter()
        .filter_map(|m| match m {
            FromScript::Open { page, replace, .. } => Some(format!("open {page} {replace}")),
            FromScript::Close { answer, .. } => Some(format!("close {answer}")),
            _ => None,
        })
        .collect();
    assert_eq!(moves, ["open robot-cell false", "open overview true", "close null", "close {\"ok\":true}"]);

    script.send(ToScript::Run { run: 2, session: Some(7), code: "if (await open(Pages.RobotCell)) log(\"yes\");".into() });
    let FromScript::Open { call, .. } = rx.blocking_recv().unwrap() else { panic!("no open") };
    script.send(ToScript::Answer { call, outcome: Ok(json!(true)) });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "yes")));
}

#[test]
fn variables_read_and_write_as_their_screen_sees_them() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "count = count + 1;\njogMode = jogMode + \"!\";".into() });
    let said = until_done(&mut rx, 1);
    assert_eq!(writes(&said), [("count".to_string(), json!(1)), ("jogMode".to_string(), json!("Joint!"))]);
    script.send(ToScript::Run { run: 2, session: None, code: "jogMode = \"Cartesian\";".into() });
    let said = until_done(&mut rx, 2);
    assert_eq!(end(&said), &End::Fault("jogMode is each screen's own, and this handler runs for no screen (line 1)".into()));
    script.send(ToScript::Run { run: 3, session: Some(8), code: "log(jogMode);".into() });
    assert_eq!(end(&until_done(&mut rx, 3)), &End::Unknown("jogMode".into()));
}

#[test]
fn runs_do_not_share_names() {
    let (script, mut rx) = engine();
    script.send(ToScript::Run { run: 1, session: Some(7), code: "globalThis.mine = 1;".into() });
    until_done(&mut rx, 1);
    script.send(ToScript::Run { run: 2, session: Some(7), code: "log(typeof mine);".into() });
    let said = until_done(&mut rx, 2);
    assert!(said.iter().any(|m| matches!(m, FromScript::Log { text, .. } if text == "undefined")));
}
