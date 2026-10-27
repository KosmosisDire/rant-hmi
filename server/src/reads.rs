//! What code reads of the names it does not bind, found by the client's `lang/reads.js` on
//! acorn, so the backend decodes only the fields something reads.

use std::cell::RefCell;
use std::collections::HashMap;

use rquickjs::{Context, Function, Persistent, Runtime};
use serde::Deserialize;

use crate::script::{ACORN, ARITH, MATH, module};

const READS: (&str, &str) = ("reads.js", include_str!("../../client/src/lang/reads.js"));

/// What code reads: each path a name and the fields after it, `[]` for each item of a list,
/// read with all it holds. `values` are the paths an expression's value may be.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Found {
    pub paths: Vec<Vec<String>>,
    pub values: Vec<Vec<String>>,
    /// It may read any name, by one worked out as it runs.
    pub all: bool,
}

/// reads.js in a context of its own, each text read once.
pub struct Reads {
    // dropped in this order, the function before its context and runtime
    reads: Persistent<Function<'static>>,
    ctx: Context,
    _rt: Runtime,
    done: RefCell<HashMap<(String, bool), Option<Found>>>,
}

impl Reads {
    pub fn new() -> Reads {
        let rt = Runtime::new().expect("QuickJS starts");
        let ctx = Context::full(&rt).expect("QuickJS makes a context");
        let reads = ctx
            .with(|ctx| {
                module(&ctx, ACORN)?;
                module(&ctx, MATH)?;
                module(&ctx, ARITH)?;
                let reads: Function = module(&ctx, READS)?.get("reads")?;
                Ok::<_, rquickjs::Error>(Persistent::save(&ctx, reads))
            })
            .expect("reads.js loads");
        Reads { reads, ctx, _rt: rt, done: RefCell::default() }
    }

    /// What `src` reads, an expression, or with `body` a handler's code. None when it does not
    /// parse, so it never runs.
    pub fn of(&self, src: &str, body: bool) -> Option<Found> {
        let key = (src.to_owned(), body);
        if let Some(found) = self.done.borrow().get(&key) {
            return found.clone();
        }
        let found = self.ctx.with(|ctx| {
            let reads = self.reads.clone().restore(&ctx).ok()?;
            let found: rquickjs::Value = reads.call((src, body)).ok()?;
            let text = ctx.json_stringify(found).ok()??.to_string().ok()?;
            serde_json::from_str::<Option<Found>>(&text).ok()?
        });
        let mut done = self.done.borrow_mut();
        // each edit is a new text, so old ones are let go now and then
        if done.len() > 4096 {
            done.clear();
        }
        done.insert(key, found.clone());
        found
    }
}

impl Default for Reads {
    fn default() -> Reads {
        Reads::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paths `src` reads and those its value may be, each written with dots, sorted.
    fn read(reads: &Reads, src: &str, body: bool) -> (Vec<String>, Vec<String>) {
        let found = reads.of(src, body).unwrap_or_else(|| panic!("{src} parses"));
        assert!(!found.all, "{src} reads no name it works out");
        let dotted = |list: &[Vec<String>]| {
            let mut out: Vec<String> = list.iter().map(|p| p.join(".")).collect();
            out.sort();
            out
        };
        (dotted(&found.paths), dotted(&found.values))
    }

    fn reads_of(reads: &Reads, src: &str, body: bool, expect: &[&str]) {
        let (paths, values) = read(reads, src, body);
        assert_eq!(paths, expect, "{src}");
        assert!(values.is_empty(), "{src} is no path");
    }

    /// `src` as an expression whose value may be `values`.
    fn is(reads: &Reads, src: &str, paths: &[&str], values: &[&str]) {
        assert_eq!(read(reads, src, false), (paths.iter().map(|p| p.to_string()).collect(), values.iter().map(|v| v.to_string()).collect()), "{src}");
    }

    #[test]
    fn an_expression_reads_the_fields_it_names() {
        let r = Reads::new();
        reads_of(&r, "\"Last part \" + Conveyor.part", false, &["Conveyor.part"]);
        reads_of(&r, "`0 0 ${LabelCam.width} ${LabelCam.height}`", false, &["LabelCam.height", "LabelCam.width"]);
        reads_of(&r, "Robot?.pose?.x * 2", false, &["Robot.pose.x"]);
        reads_of(&r, "Robot[\"speed\"] + 1", false, &["Robot.speed"]);
        // an index is each item of a list
        reads_of(&r, "Joints.position[index] < 0 ? \"a\" : \"b\"", false, &["Joints.position.[]", "index"]);
        reads_of(&r, "degrees(Joints.position[0]).toFixed(0)", false, &["Joints.position.[]", "degrees"]);
        reads_of(&r, "Labels.boxes.length - 1", false, &["Labels.boxes.length"]);
        // a method of a field reads it whole, which the type tells from a field
        reads_of(&r, "Conveyor.name.toUpperCase()", false, &["Conveyor.name.toUpperCase"]);
        reads_of(&r, "vec(Pose.position.x, Pose.position.y).length()", false, &["Pose.position.x", "Pose.position.y", "vec"]);
    }

    #[test]
    fn a_value_handed_on_is_read_whole() {
        let r = Reads::new();
        reads_of(&r, "fmt(Pose)", false, &["Pose", "fmt"]);
        reads_of(&r, "{ position: Arm.position }", false, &["Arm.position"]);
        reads_of(&r, "Robot[key] * 2", false, &["Robot.[]", "key"]);
        reads_of(&r, "Cloud.points.map(scale)", false, &["Cloud.points.[]", "Cloud.points.length", "scale"]);
        // a choice handed on reads both its branches whole
        reads_of(&r, "fmt(ok ? Lidar.a : Lidar.b)", false, &["Lidar.a", "Lidar.b", "fmt", "ok"]);
    }

    #[test]
    fn an_expression_that_is_a_path_gives_it_for_its_reader() {
        let r = Reads::new();
        is(&r, "Lidar", &[], &["Lidar"]);
        is(&r, "Scan.points", &[], &["Scan.points"]);
        // a list's own items, filtered, are still its items
        is(&r, "Scan.points.filter((p) => p.z > 0)", &["Scan.points.[].z", "Scan.points.length"], &["Scan.points"]);
        is(&r, "Labels.boxes.find((b) => b.id == 3)", &["Labels.boxes.[].id", "Labels.boxes.length"], &["Labels.boxes.[]"]);
        // a choice is either branch, and reads what chooses
        is(&r, "wide ? Camera : LabelCam", &["wide"], &["Camera", "LabelCam"]);
        is(&r, "Robot.start ? Camera : big ? Wide : null", &["Robot.start", "big"], &["Camera", "Wide"]);
        is(&r, "Pick.cam ?? Camera", &[], &["Camera", "Pick.cam"]);
    }

    #[test]
    fn items_reach_the_functions_of_a_list() {
        let r = Reads::new();
        reads_of(&r, "Cloud.points.reduce((sum, p) => sum + p.z, 0)", false, &["Cloud.points.[].z", "Cloud.points.length"]);
        reads_of(&r, "Jobs.list.toSorted((a, b) => a.due - b.due)[0].name + \"!\"", false, &["Jobs.list.[].due", "Jobs.list.[].name", "Jobs.list.length"]);
        // a parameter named as an import is the item, not the import
        reads_of(&r, "Lidar.points.map((Lidar) => Lidar.x)", false, &["Lidar.points.[].x", "Lidar.points.length"]);
        reads_of(&r, "Lidar.points.map(({ x, y }) => x + y)", false, &["Lidar.points.[].x", "Lidar.points.[].y", "Lidar.points.length"]);
        reads_of(&r, "Lidar.points.map((p) => p)", false, &["Lidar.points.[]", "Lidar.points.length"]);
        // a reduce with no start begins from the first item, and a function also takes the list
        reads_of(&r, "Boxes.boxes.reduce((a) => a).uuid", false, &["Boxes.boxes.[]", "Boxes.boxes.length"]);
        reads_of(&r, "Boxes.boxes.reduce((a, b) => a.w + b.h)", false, &["Boxes.boxes.[].h", "Boxes.boxes.[].w", "Boxes.boxes.length"]);
        reads_of(&r, "Cloud.points.map((p, i, all) => (all[i - 1]?.y ?? 0) + p.x)", false, &["Cloud.points.[].x", "Cloud.points.[].y", "Cloud.points.length"]);
    }

    #[test]
    fn code_follows_its_own_names() {
        let r = Reads::new();
        let src = "const p = Pose.position;\nlet n = 0;\nfor (const q of Cloud.points) n += q.x;\nnotify(p.x + p.y + n);";
        // a let or a const reads all it is given, while a loop's item is followed
        reads_of(&r, src, true, &["Cloud.points.[].x", "Cloud.points.length", "Pose.position", "notify"]);
        reads_of(&r, "function draw() { return p.x; }\nconst p = Pose.position;\ndraw();", true, &["Pose.position"]);
        reads_of(&r, "const { x, y } = Pose.position;\nlog(x + y);", true, &["Pose.position.x", "Pose.position.y", "log"]);
        reads_of(&r, "const { x, ...rest } = Pose.position;\nlog(x);", true, &["Pose.position", "Pose.position.x", "log"]);
        // a name given another value reads all of that value
        reads_of(&r, "let p = A.pose;\np = B.q;\nlog(p.x);", true, &["A.pose", "B.q", "log"]);
        reads_of(&r, "for (const k in Settings) log(k);", true, &["Settings", "log"]);
        reads_of(&r, "Speed += 1;", true, &["Speed"]);
        reads_of(&r, "Speed = Target.value;", true, &["Target.value"]);
        // a var at the top runs on the scope's own names, so it is no other name for anything
        reads_of(&r, "var s = Settings;\nlog(s.mode);", true, &["Settings", "log", "s.mode"]);
        reads_of(&r, "const f = (Pose) => Pose.x;\nlog(f(Arm));", true, &["Arm", "log"]);
    }

    #[test]
    fn code_that_may_read_any_name_says_so() {
        let r = Reads::new();
        for src in ["eval(\"Speed\")", "globalThis.Speed", "new Function(\"return Speed\")()", "this.Speed"] {
            assert!(r.of(src, true).is_some_and(|f| f.all), "{src}");
        }
        assert!(r.of("function f() { return this.x; }", true).is_some_and(|f| !f.all));
        assert_eq!(r.of("Speed +", false), None);
    }
}
