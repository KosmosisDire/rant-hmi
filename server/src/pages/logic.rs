//! The HMI's own handlers, which belong to no element, kept in `logic/handlers.html` as
//! `docs/files.md` shows.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::format::{Reader, dedent, quote};
use super::js::outside;

/// One of the HMI's own handlers.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Rule {
    /// `h` and a number, stable while it lives.
    pub id: String,
    pub name: String,
    pub when: When,
    pub code: String,
}

/// A rule is held under its id, since its name is free text.
impl crate::list::Named for Rule {
    fn name(&self) -> &str {
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
    /// When a mesh import or variable changes. `p.value` and `p.previous`.
    Changes { name: String },
    /// Once, when the HMI starts.
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

pub fn write(rules: &[Rule]) -> String {
    let mut out = String::from("<logic>\n");
    for r in rules {
        let when = match &r.when {
            When::Every { ms } => format!("every=\"{ms}\""),
            When::Turns { condition, ms } if *ms == 0 => format!("when={}", quote(condition)),
            When::Turns { condition, ms } => format!("when={} for=\"{ms}\"", quote(condition)),
            When::Changes { name } => format!("change={}", quote(name)),
            When::Starts => "start=\"\"".into(),
            When::Connects => "screen=\"connects\"".into(),
            When::Leaves => "screen=\"leaves\"".into(),
        };
        out.push_str(&format!("  <on id={} name={} {when}>\n", quote(&r.id), quote(&r.name)));
        for line in r.code.lines() {
            if !line.trim().is_empty() {
                out.push_str(&format!("    {line}"));
            }
            out.push('\n');
        }
        out.push_str("  </on>\n");
    }
    out.push_str("</logic>\n");
    out
}

pub fn parse(text: &str) -> Result<Vec<Rule>, String> {
    let mut r = Reader::new(text);
    r.gap();
    r.expect("<logic>")?;
    let mut rules: Vec<Rule> = Vec::new();
    loop {
        r.gap();
        if r.eat("</logic>") {
            return Ok(rules);
        }
        r.expect("<on")?;
        let attrs = r.attrs()?;
        r.expect(">")?;
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
        let n = outside(r.rest(), "</on>").ok_or_else(|| r.error("<on> never closes"))?;
        let rule = Rule { id: get("id").unwrap_or_default(), name: get("name").unwrap_or_default(), when, code: dedent(&r.rest()[..n]) };
        if rule.id.is_empty() || rules.iter().any(|x| x.id == rule.id) {
            return Err(r.error("each <on> needs an id of its own"));
        }
        rules.push(rule);
        r.skip(n);
        r.expect("</on>")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_read_and_write_back_the_same() {
        let rules = vec![
            Rule { id: "h1".into(), name: "Blink".into(), when: When::Every { ms: 500 }, code: "lamp = !lamp;".into() },
            Rule { id: "h2".into(), name: "Too fast".into(), when: When::Turns { condition: "Speed > 1.5 && Mode == \"Auto\"".into(), ms: 2000 }, code: "if (x) {\n  notify(\"</on>\");\n}".into() },
            Rule { id: "h3".into(), name: "Run".into(), when: When::Changes { name: "Running".into() }, code: "log(p.value);".into() },
            Rule { id: "h4".into(), name: "Hello".into(), when: When::Starts, code: String::new() },
            Rule { id: "h5".into(), name: "Came".into(), when: When::Connects, code: "log(p.screen);".into() },
            Rule { id: "h6".into(), name: "Went".into(), when: When::Leaves, code: "log(p.screen);".into() },
        ];
        let text = write(&rules);
        assert_eq!(parse(&text).unwrap(), rules);
        assert!(text.contains("<on id=\"h2\" name=\"Too fast\" when='Speed > 1.5 && Mode == \"Auto\"' for=\"2000\">"));
        assert_eq!(parse("<logic>\n<on id=\"h1\" name=\"x\">\n</on></logic>").unwrap_err(), "line 2: <on> needs every, when, change, start or screen");
    }
}
