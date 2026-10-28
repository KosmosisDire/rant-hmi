//! An object's logic: handlers that belong to no element, each an `<on>` in its object's file
//! as `docs/files.md` shows.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::pages::format::{Reader, lines, quote};

/// One handler of an object's logic.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Rule {
    /// `h` and a number, stable while it lives, and unique across the objects.
    pub id: String,
    pub name: String,
    pub when: When,
    pub code: String,
}

/// A rule is held under its id, since its name is free text.
impl crate::list::Keyed for Rule {
    fn key(&self) -> &str {
        &self.id
    }
}

/// What starts a rule's code, and what it then reads as `p`.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum When {
    /// Every so many milliseconds.
    Every { ms: u32 },
    /// When `condition` turns true and stays true for `ms`. An unknown value never fires it.
    Turns { condition: String, ms: u32 },
    /// When a member changes, an own one by its name, another object's as `Line.Speed`.
    /// `p.value` and `p.previous`.
    Changes { name: String },
    /// Once, when the HMI starts. This and a screen connecting or leaving are Hmi's alone.
    Starts,
    /// When a screen connects. `p.screen`.
    Connects,
    /// When a screen is lost. `p.screen`.
    Leaves,
}

/// The shortest timer a rule may have, so one cannot swamp the backend.
pub const SHORTEST_MS: u32 = 50;

pub fn check(rule: &Rule) -> Result<(), String> {
    if rule.name.trim().is_empty() {
        return Err("a handler needs a name".into());
    }
    // an empty condition or name is one being written, and simply never fires
    match &rule.when {
        When::Every { ms } if *ms < SHORTEST_MS => Err(format!("a timer runs every {SHORTEST_MS} ms at the most often")),
        _ => Ok(()),
    }
}

/// Whether only the Hmi object may hold logic that runs on this.
pub fn hmis(when: &When) -> bool {
    matches!(when, When::Starts | When::Connects | When::Leaves)
}

/// One rule as an `<on>` at `indent`, its code a step further in.
pub fn write(out: &mut String, indent: &str, r: &Rule) {
    let when = match &r.when {
        When::Every { ms } => format!("every=\"{ms}\""),
        When::Turns { condition, ms } if *ms == 0 => format!("when={}", quote(condition)),
        When::Turns { condition, ms } => format!("when={} for=\"{ms}\"", quote(condition)),
        When::Changes { name } => format!("change={}", quote(name)),
        When::Starts => "start=\"\"".into(),
        When::Connects => "screen=\"connects\"".into(),
        When::Leaves => "screen=\"leaves\"".into(),
    };
    out.push_str(&format!("{indent}<on id={} name={} {when}>
", quote(&r.id), quote(&r.name)));
    lines(out, &format!("{indent}  "), &r.code);
    out.push_str(&format!("{indent}</on>
"));
}

/// The `<on>` whose attributes were read, its code up to `</on>`.
pub(crate) fn read(r: &mut Reader, attrs: &[(String, String)]) -> Result<Rule, String> {
    let get = |k: &str| attrs.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
    let when = if let Some(ms) = get("every") {
        When::Every { ms: ms.parse().map_err(|_| r.error("every takes milliseconds"))? }
    } else if let Some(condition) = get("when") {
        let ms = get("for").map(|f| f.parse()).transpose().map_err(|_| r.error("for takes milliseconds"))?;
        When::Turns { condition, ms: ms.unwrap_or(0) }
    } else if let Some(name) = get("change") {
        When::Changes { name }
    } else if get("start").is_some() {
        When::Starts
    } else {
        match get("screen").as_deref() {
            Some("connects") => When::Connects,
            Some("leaves") => When::Leaves,
            _ => return Err(r.error("<on> needs every, when, change, start or screen")),
        }
    };
    let id = get("id").filter(|id| !id.is_empty()).ok_or_else(|| r.error("each <on> needs an id"))?;
    Ok(Rule { id, name: get("name").unwrap_or_default(), when, code: r.code("on")? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_read_and_write_back_the_same() {
        let rules = vec![
            Rule { id: "h1".into(), name: "Blink".into(), when: When::Every { ms: 500 }, code: "lamp = !lamp;".into() },
            Rule { id: "h2".into(), name: "Too fast".into(), when: When::Turns { condition: "Speed > 1.5 && Mode == \"Auto\"".into(), ms: 2000 }, code: "if (x) {
  notify(\"</on>\");
}".into() },
            Rule { id: "h3".into(), name: "Run".into(), when: When::Changes { name: "Running".into() }, code: "log(p.value);".into() },
            Rule { id: "h4".into(), name: "Hello".into(), when: When::Starts, code: String::new() },
            Rule { id: "h5".into(), name: "Came".into(), when: When::Connects, code: "log(p.screen);".into() },
            Rule { id: "h6".into(), name: "Went".into(), when: When::Leaves, code: "log(p.screen);".into() },
        ];
        for rule in rules {
            let mut text = String::new();
            write(&mut text, "  ", &rule);
            let mut r = Reader::new(&text);
            r.gap();
            r.expect("<on").unwrap();
            let attrs = r.attrs().unwrap();
            r.expect(">").unwrap();
            assert_eq!(read(&mut r, &attrs).unwrap(), rule, "{text}");
            if rule.id == "h2" {
                assert!(text.contains("<on id=\"h2\" name=\"Too fast\" when='Speed > 1.5 && Mode == \"Auto\"' for=\"2000\">"));
            }
        }
        let mut r = Reader::new("<on id=\"h1\" name=\"x\">
</on>");
        r.expect("<on").unwrap();
        let attrs = r.attrs().unwrap();
        r.expect(">").unwrap();
        assert_eq!(read(&mut r, &attrs).unwrap_err(), "line 1: <on> needs every, when, change, start or screen");
    }
}
