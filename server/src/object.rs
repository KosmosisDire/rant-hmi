//! An object: one thing the HMI controls, as its mesh members, state, computed values, records,
//! functions and logic, kept in `objects/<name>.html` as `docs/project.md` shows.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::list::by_name;
use crate::logic::{self, Rule, When};
use crate::pages::format::{Reader, lines, quote, var};
use crate::pages::js;
use crate::project::{self, Computed, Import, Intent, Kind, Record, Setter, Variable};
use crate::rules::{self, EVERY_MS, KEEP_S, RATE};

/// The object every project has, which holds what is about the HMI itself.
pub const HMI: &str = "Hmi";
/// Where the HMI's own node keeps its entities, as `status.rs` names them.
const HMI_MESH: &str = "Hmi";

/// Code outside reads its Global members as `Robot.State`, its own code all of them bare.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Object {
    pub name: String,
    /// The mesh path its members' entities count from, empty for the mesh's own root.
    pub mesh: String,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
    /// Its mesh members, each alias the member's name and each entity counted from `mesh`.
    pub imports: Vec<Import>,
    pub variables: Vec<Variable>,
    pub computed: Vec<Computed>,
    pub records: Vec<Record>,
    pub functions: Vec<Function>,
    pub logic: Vec<Rule>,
    /// The members only its own code reads.
    pub local: Vec<String>,
}

/// Code an object runs on the system when called, giving back what it returns.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Function {
    pub name: String,
    /// What a call passes, in order, each read by its name.
    pub takes: Vec<String>,
    pub code: String,
}

/// An object apart from its members, as the Objects tab adds, renames and points one.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct ObjectInfo {
    pub name: String,
    pub mesh: String,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
}

by_name!(Object, Function);

/// The key a member's value is kept under, as the wire, the engine and screens name it.
pub fn key(object: &str, member: &str) -> String {
    format!("{object}.{member}")
}

/// The object a key's member belongs to.
pub fn owner(key: &str) -> &str {
    key.split_once('.').map_or(key, |(object, _)| object)
}

impl Object {
    pub fn new(info: ObjectInfo) -> Object {
        let ObjectInfo { name, mesh, note } = info;
        Object { name, mesh, note, imports: Vec::new(), variables: Vec::new(), computed: Vec::new(), records: Vec::new(), functions: Vec::new(), logic: Vec::new(), local: Vec::new() }
    }

    /// The Hmi object a project has before it keeps anything there.
    pub fn hmi() -> Object {
        Object::new(ObjectInfo { name: HMI.into(), mesh: HMI_MESH.into(), note: None })
    }

    pub fn info(&self) -> ObjectInfo {
        ObjectInfo { name: self.name.clone(), mesh: self.mesh.clone(), note: self.note.clone() }
    }

    pub fn key(&self, member: &str) -> String {
        key(&self.name, member)
    }

    /// A mesh member's entity in full: from the object's mesh root, or from the mesh's own when
    /// it starts with `/`.
    pub fn entity(&self, path: &str) -> String {
        match path.strip_prefix('/') {
            Some(own) => own.to_owned(),
            None if self.mesh.is_empty() => path.to_owned(),
            None => format!("{}/{path}", self.mesh),
        }
    }

    /// Whether code outside it reads `member`.
    pub fn global(&self, member: &str) -> bool {
        !self.local.iter().any(|l| l == member)
    }

    /// The key of what its own code names `name`: a member of its own, or another object's
    /// written `Line.Speed`.
    pub fn key_of(&self, name: &str) -> String {
        if name.contains('.') { name.to_owned() } else { self.key(name) }
    }

    /// Each member's name and what it is, in the order its file keeps them.
    pub fn members(&self) -> impl Iterator<Item = (&str, &'static str)> + '_ {
        let imports = self.imports.iter().map(|i| (i.alias.as_str(), "an import"));
        imports
            .chain(self.variables.iter().map(|v| (v.name.as_str(), "a variable")))
            .chain(self.computed.iter().map(|c| (c.name.as_str(), "a computed value")))
            .chain(self.records.iter().map(|r| (r.name.as_str(), "a record")))
            .chain(self.functions.iter().map(|f| (f.name.as_str(), "a function")))
    }

    pub fn has(&self, name: &str) -> bool {
        self.members().any(|(n, _)| n == name)
    }

    /// Refuses `name` when another member has it, leaving out `own`, the one of `what` being
    /// changed.
    pub fn free(&self, name: &str, what: &str, own: &str) -> Result<(), String> {
        match self.members().find(|(n, w)| *n == name && !(*w == what && name == own)) {
            Some((_, w)) => Err(format!("{name} is already {w} of {}", self.name)),
            None => Ok(()),
        }
    }

    /// Each piece of its code: its computed values and setters, records, functions and logic.
    pub fn code(&self) -> impl Iterator<Item = &str> + '_ {
        let computed = self.computed.iter().flat_map(|c| std::iter::once(c.get.as_str()).chain(c.set.iter().map(|s| s.value.as_str())));
        let logic = self.logic.iter().flat_map(|r| {
            let condition = match &r.when {
                When::Turns { condition, .. } => Some(condition.as_str()),
                _ => None,
            };
            std::iter::once(r.code.as_str()).chain(condition)
        });
        computed.chain(self.records.iter().map(|r| r.source.as_str())).chain(self.functions.iter().map(|f| f.code.as_str())).chain(logic)
    }

    /// The keys `code` of its own reads: its members by name, and other objects' as
    /// `Line.Speed`.
    pub fn reads(&self, code: &str) -> Vec<String> {
        js::names(code)
            .into_iter()
            .filter_map(|(at, name)| match self.has(name) {
                true => Some(self.key(name)),
                false => js::member_after(&code[at + name.len()..]).map(|m| key(name, m)),
            })
            .collect()
    }
}

/// Every object's members in one list each, under their keys: entities in full, and setter
/// targets and the names logic waits on as keys too.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Flat {
    pub imports: Vec<Import>,
    pub variables: Vec<Variable>,
    pub computed: Vec<Computed>,
    pub records: Vec<Record>,
    pub functions: Vec<Function>,
    /// Each object's logic, with the object it runs in.
    pub rules: Vec<(String, Rule)>,
}

impl Flat {
    /// As if each key `moved` names, from and to, had been its new one all along.
    pub fn renamed(mut self, moved: &[(String, String)]) -> Flat {
        let to = |key: &mut String| {
            if let Some((_, new)) = moved.iter().find(|(from, _)| from == key) {
                *key = new.clone();
            }
        };
        self.imports.iter_mut().for_each(|i| to(&mut i.alias));
        self.variables.iter_mut().for_each(|v| to(&mut v.name));
        for c in &mut self.computed {
            to(&mut c.name);
            if let Some(s) = &mut c.set {
                to(&mut s.target);
            }
        }
        self.records.iter_mut().for_each(|r| to(&mut r.name));
        self.functions.iter_mut().for_each(|f| to(&mut f.name));
        for (_, r) in &mut self.rules {
            if let When::Changes { name } = &mut r.when {
                to(name);
            }
        }
        self
    }

    pub fn of(objects: &[Object]) -> Flat {
        let mut f = Flat::default();
        for o in objects {
            f.imports.extend(o.imports.iter().map(|i| Import { alias: o.key(&i.alias), entity: o.entity(&i.entity), ..i.clone() }));
            f.variables.extend(o.variables.iter().map(|v| Variable { name: o.key(&v.name), ..v.clone() }));
            f.computed.extend(o.computed.iter().map(|c| Computed {
                name: o.key(&c.name),
                set: c.set.as_ref().map(|s| Setter { target: o.key_of(&s.target), value: s.value.clone() }),
                ..c.clone()
            }));
            f.records.extend(o.records.iter().map(|r| Record { name: o.key(&r.name), ..r.clone() }));
            f.functions.extend(o.functions.iter().map(|x| Function { name: o.key(&x.name), ..x.clone() }));
            f.rules.extend(o.logic.iter().map(|r| {
                let when = match &r.when {
                    When::Changes { name } => When::Changes { name: o.key_of(name) },
                    other => other.clone(),
                };
                (o.name.clone(), Rule { when, ..r.clone() })
            }));
        }
        f
    }
}

/// Why an object cannot be as it is, for the user: each name spelled as its kind is and taken
/// once, and each member whole.
pub fn check(o: &Object) -> Result<(), String> {
    rules::ALIAS.check(&o.name, "an object")?;
    project::unreserved(&o.name)?;
    for i in &o.imports {
        project::check_import(i)?;
    }
    for v in &o.variables {
        project::check_local(&v.name, "a variable")?;
        if v.start.is_null() {
            return Err(format!("{} needs a start value", v.name));
        }
    }
    for c in &o.computed {
        project::check_local(&c.name, "a computed value")?;
        if c.get.trim().is_empty() {
            return Err(format!("{} needs an expression to work its value out", c.name));
        }
        if let Some(s) = c.set.as_ref().filter(|s| s.value.trim().is_empty()) {
            return Err(format!("{} needs the value its setter gives {}", c.name, s.target));
        }
        if c.rate.is_some_and(|r| !(RATE.0..=RATE.1).contains(&r)) {
            return Err(format!("{} is worked out from {} to {} times a second", c.name, RATE.0, RATE.1));
        }
    }
    for r in &o.records {
        project::check_local(&r.name, "a record")?;
        if r.source.trim().is_empty() {
            return Err(format!("{} needs a value to record", r.name));
        }
        let within = |(low, high): (u32, u32), n: u32| (low..=high).contains(&n);
        if !within(EVERY_MS, r.every_ms) || !within(KEEP_S, r.keep_s) {
            return Err(format!("{} samples every {} ms or more, and keeps from 1 s to a day", r.name, EVERY_MS.0));
        }
    }
    for f in &o.functions {
        project::check_local(&f.name, "a function")?;
        for (n, t) in f.takes.iter().enumerate() {
            rules::LOCAL.check(t, "what a function takes")?;
            if f.takes[..n].contains(t) {
                return Err(format!("{} takes {t} twice", f.name));
            }
        }
    }
    let names: Vec<(&str, &str)> = o.members().collect();
    for (n, (name, what)) in names.iter().enumerate() {
        if let Some((_, first)) = names[..n].iter().find(|(m, _)| m == name) {
            return Err(format!("{name} is {first} of {} and {what} too", o.name));
        }
    }
    for r in &o.logic {
        logic::check(r)?;
        if logic::hmis(&r.when) && o.name != HMI {
            return Err(format!("{} runs as the HMI starts or a screen comes or goes, which is Hmi's logic", r.name));
        }
    }
    if let Some(l) = o.local.iter().find(|l| !o.has(l)) {
        return Err(format!("{l} is not a member of {}", o.name));
    }
    Ok(())
}

// ------------------------------------------------------------------------------ the file

/// The tag each kind of mesh member is written with.
fn tag_of(kind: Kind) -> &'static str {
    match kind {
        Kind::Topic => "topic",
        Kind::Variable => "variable",
        Kind::Function => "function",
        Kind::Task => "task",
    }
}

pub fn write(o: &Object) -> String {
    let mut out = format!("<object name={}", quote(&o.name));
    if !o.mesh.is_empty() {
        out.push_str(&format!(" mesh={}", quote(&o.mesh)));
    }
    if let Some(note) = &o.note {
        out.push_str(&format!(" note={}", quote(note)));
    }
    out.push_str(">\n");
    let local = |name: &str| if o.global(name) { "" } else { " local=\"true\"" };
    for i in &o.imports {
        // a function or a task is only called, so only a topic or a variable says it writes
        let intent = if i.intent == Intent::Write && matches!(i.kind, Kind::Topic | Kind::Variable) { " intent=\"write\"" } else { "" };
        let rate = i.rate.map(|r| format!(" rate=\"{r}\"")).unwrap_or_default();
        out.push_str(&format!("  <{} name={} entity={}{intent}{rate}{}/>\n", tag_of(i.kind), quote(&i.alias), quote(&i.entity), local(&i.alias)));
    }
    for v in &o.variables {
        var(&mut out, "  ", v, local(&v.name));
    }
    for c in &o.computed {
        out.push_str(&format!("  <computed name={} get={}", quote(&c.name), quote(&c.get)));
        if let Some(s) = &c.set {
            out.push_str(&format!(" target={} set={}", quote(&s.target), quote(&s.value)));
        }
        if let Some(r) = c.rate {
            out.push_str(&format!(" rate=\"{r}\""));
        }
        for (k, v) in [("unit", &c.unit), ("note", &c.note)] {
            if let Some(v) = v {
                out.push_str(&format!(" {k}={}", quote(v)));
            }
        }
        out.push_str(&format!("{}/>\n", local(&c.name)));
    }
    for r in &o.records {
        out.push_str(&format!("  <record name={} source={} every=\"{}\" keep=\"{}\"{}/>\n", quote(&r.name), quote(&r.source), r.every_ms, r.keep_s, local(&r.name)));
    }
    for f in &o.functions {
        let takes = if f.takes.is_empty() { String::new() } else { format!(" takes={}", quote(&f.takes.join(", "))) };
        out.push_str(&format!("  <fn name={}{takes}{}>\n", quote(&f.name), local(&f.name)));
        lines(&mut out, "    ", &f.code);
        out.push_str("  </fn>\n");
    }
    for r in &o.logic {
        logic::write(&mut out, "  ", r);
    }
    out.push_str("</object>\n");
    out
}

/// An object from its file text, checked. The error names the line where it can.
pub fn parse(text: &str) -> Result<Object, String> {
    let mut r = Reader::new(text);
    r.gap();
    r.expect("<object")?;
    let mut head = Attrs::read(&mut r, "object")?;
    r.expect(">")?;
    let name = head.need(&r, "name")?;
    let mut o = Object::new(ObjectInfo { name, mesh: head.take("mesh").unwrap_or_default(), note: head.take("note") });
    head.done(&r)?;
    loop {
        r.gap();
        if r.eat("</object>") {
            break;
        }
        if r.rest().is_empty() {
            return Err(r.error("<object> never closes"));
        }
        r.expect("<")?;
        let tag = r.word()?;
        let mut a = Attrs::read(&mut r, &tag)?;
        let local = a.take("local").is_some_and(|v| v == "true");
        let name = match tag.as_str() {
            "variable" | "topic" | "function" | "task" => {
                let kind = match tag.as_str() {
                    "variable" => Kind::Variable,
                    "topic" => Kind::Topic,
                    "function" => Kind::Function,
                    _ => Kind::Task,
                };
                let intent = match a.take("intent").as_deref() {
                    None | Some("read") => Intent::Read,
                    Some("write") => Intent::Write,
                    Some(_) => return Err(r.error("intent is read or write")),
                };
                let rate = a.take("rate").map(|n| n.parse().map_err(|_| r.error("rate takes values a second"))).transpose()?;
                let import = Import { alias: a.need(&r, "name")?, entity: a.need(&r, "entity")?, kind, intent: project::callable(kind).unwrap_or(intent), rate };
                a.done(&r)?;
                r.expect("/>")?;
                o.imports.push(import);
                &o.imports.last().expect("just pushed").alias
            }
            "var" => {
                let v = r.variable(&a.rest())?;
                r.expect("/>")?;
                o.variables.push(v);
                &o.variables.last().expect("just pushed").name
            }
            "computed" => {
                let set = match (a.take("target"), a.take("set")) {
                    (Some(target), Some(value)) => Some(Setter { target, value }),
                    (None, None) => None,
                    _ => return Err(r.error("a setter takes both a target and set")),
                };
                let rate = a.take("rate").map(|n| n.parse().map_err(|_| r.error("rate takes times a second"))).transpose()?;
                let c = Computed { name: a.need(&r, "name")?, get: a.need(&r, "get")?, set, rate, unit: a.take("unit"), note: a.take("note") };
                a.done(&r)?;
                r.expect("/>")?;
                o.computed.push(c);
                &o.computed.last().expect("just pushed").name
            }
            "record" => {
                let number = |a: &mut Attrs, k: &str| a.need(&r, k)?.parse::<u32>().map_err(|_| r.error(&format!("{k} takes a whole number")));
                let record = Record { name: a.need(&r, "name")?, source: a.need(&r, "source")?, every_ms: number(&mut a, "every")?, keep_s: number(&mut a, "keep")? };
                a.done(&r)?;
                r.expect("/>")?;
                o.records.push(record);
                &o.records.last().expect("just pushed").name
            }
            "fn" => {
                let name = a.need(&r, "name")?;
                let takes = a.take("takes").map(|t| t.split(',').map(|x| x.trim().to_owned()).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
                a.done(&r)?;
                r.expect(">")?;
                o.functions.push(Function { name, takes, code: r.code("fn")? });
                &o.functions.last().expect("just pushed").name
            }
            "on" if !local => {
                r.expect(">")?;
                o.logic.push(logic::read(&mut r, &a.rest())?);
                continue;
            }
            other => return Err(r.error(&format!("<{other}> is not what an object holds"))),
        };
        if local {
            o.local.push(name.clone());
        }
    }
    r.gap();
    if !r.rest().is_empty() {
        return Err(r.error("nothing may follow </object>"));
    }
    check(&o)?;
    Ok(o)
}

/// A tag's attributes, taken one by one, so one left over is a mistake.
struct Attrs {
    tag: String,
    left: BTreeMap<String, String>,
}

impl Attrs {
    fn read(r: &mut Reader, tag: &str) -> Result<Attrs, String> {
        Ok(Attrs { tag: tag.to_owned(), left: r.attrs()?.into_iter().collect() })
    }

    fn take(&mut self, k: &str) -> Option<String> {
        self.left.remove(k)
    }

    fn need(&mut self, r: &Reader, k: &str) -> Result<String, String> {
        self.take(k).ok_or_else(|| r.error(&format!("<{}> needs {k}", self.tag)))
    }

    /// What is left, for a reader that takes its own.
    fn rest(self) -> Vec<(String, String)> {
        self.left.into_iter().collect()
    }

    fn done(self, r: &Reader) -> Result<(), String> {
        match self.left.keys().next() {
            Some(k) => Err(r.error(&format!("<{}> takes no attribute {k}", self.tag))),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Per;
    use crate::value::value;

    fn line() -> Object {
        let mut o = Object::new(ObjectInfo { name: "Line".into(), mesh: "Line1".into(), note: Some("The packing line".into()) });
        o.imports = vec![
            Import { alias: "Speed".into(), entity: "Speed".into(), kind: Kind::Variable, intent: Intent::Write, rate: None },
            Import { alias: "Conveyor".into(), entity: "Conveyor".into(), kind: Kind::Topic, intent: Intent::Read, rate: Some(5) },
            Import { alias: "Reset".into(), entity: "Reset".into(), kind: Kind::Function, intent: Intent::Write, rate: None },
            Import { alias: "Joints".into(), entity: "/Robot/Joints".into(), kind: Kind::Topic, intent: Intent::Read, rate: None },
        ];
        o.variables = vec![Variable { name: "runSeconds".into(), start: value!(0), per: Per::Hmi }, Variable { name: "mode".into(), start: value!("Auto"), per: Per::Screen }];
        o.computed = vec![Computed { name: "speedPercent".into(), get: "Speed / 2 * 100".into(), set: Some(Setter { target: "Speed".into(), value: "v / 100 * 2".into() }), rate: Some(5), unit: Some("%".into()), note: None }];
        o.records = vec![Record { name: "speedHistory".into(), source: "Conveyor.speed".into(), every_ms: 100, keep_s: 60 }];
        o.functions = vec![Function { name: "restart".into(), takes: vec!["job".into(), "mode".into()], code: "await Reset();\nreturn job;".into() }];
        o.logic = vec![Rule { id: "h1".into(), name: "Count".into(), when: When::Every { ms: 1000 }, code: "if (Speed > 0) runSeconds = runSeconds + 1;".into() }];
        o.local = vec!["Reset".into(), "runSeconds".into()];
        o
    }

    #[test]
    fn an_object_reads_and_writes_back_the_same() {
        let text = write(&line());
        assert_eq!(parse(&text).unwrap(), line(), "{text}");
        assert!(text.starts_with("<object name=\"Line\" mesh=\"Line1\" note=\"The packing line\">\n  <variable name=\"Speed\" entity=\"Speed\" intent=\"write\"/>\n"), "{text}");
        assert!(text.contains("  <function name=\"Reset\" entity=\"Reset\" local=\"true\"/>\n"), "{text}");
        assert!(text.contains("  <var name=\"runSeconds\" start=\"0\" per=\"hmi\" local=\"true\"/>\n  <var name=\"mode\" start='\"Auto\"'/>\n"), "{text}");
        assert!(text.contains("  <fn name=\"restart\" takes=\"job, mode\">\n    await Reset();\n    return job;\n  </fn>\n"), "{text}");
        assert_eq!(parse("<object name=\"A\">\n  <knob name=\"x\"/>\n</object>").unwrap_err(), "line 2: <knob> is not what an object holds");
        assert_eq!(parse("<object name=\"A\">\n  <topic name=\"X\" entity=\"x\" colour=\"red\"/>\n</object>").unwrap_err(), "line 2: <topic> takes no attribute colour");
    }

    #[test]
    fn members_are_kept_by_key_with_entities_from_the_mesh_root() {
        let flat = Flat::of(&[line()]);
        assert_eq!(flat.imports.iter().map(|i| (i.alias.as_str(), i.entity.as_str())).collect::<Vec<_>>(), [("Line.Speed", "Line1/Speed"), ("Line.Conveyor", "Line1/Conveyor"), ("Line.Reset", "Line1/Reset"), ("Line.Joints", "Robot/Joints")]);
        assert_eq!(flat.computed[0].set.as_ref().unwrap().target, "Line.Speed");
        assert_eq!(flat.rules[0].0, "Line");
        assert_eq!(line().reads("Speed / Robot.Pose.x + Line.mode + speed"), ["Line.Speed", "Robot.Pose", "Line.mode"]);
    }

    #[test]
    fn names_keep_to_their_kind_and_logic_on_screens_to_hmi() {
        let mut o = line();
        o.variables.push(Variable { name: "Speed".into(), start: value!(1), per: Per::Hmi });
        assert!(check(&o).unwrap_err().contains("small letter"));
        o.variables.last_mut().unwrap().name = "speedPercent".into();
        assert_eq!(check(&o).unwrap_err(), "speedPercent is a variable of Line and a computed value too");
        let mut o = line();
        o.logic.push(Rule { id: "h2".into(), name: "Hello".into(), when: When::Connects, code: String::new() });
        assert!(check(&o).unwrap_err().contains("Hmi's logic"));
        o.name = HMI.into();
        check(&o).unwrap();
        o.local.push("nothing".into());
        assert_eq!(check(&o).unwrap_err(), "nothing is not a member of Hmi");
    }
}
