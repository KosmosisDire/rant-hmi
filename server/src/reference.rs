//! The tables of docs/events.md and docs/code.md, written by a test from where each lives in
//! code, as events.ts is. The docs' own words stand around them.

use std::fmt::Write;

use serde_json::Value as Json;

use crate::events::{ANY, EVENTS, EventInfo, SettingInfo, SettingKind, ended_by};
use crate::pages::format::{ATTRS, own_attrs};
use crate::pages::WORDS;

/// Each sender's events, then what their `p` holds and the values of their filters.
fn events() -> String {
    let mut out = String::new();
    let mut senders = Vec::new();
    for e in EVENTS {
        if !senders.contains(&e.from) {
            senders.push(e.from);
        }
    }
    for sender in senders {
        let events: Vec<&EventInfo> = EVENTS.iter().filter(|e| e.from == sender).collect();
        writeln!(out, "### {}\n\n| Event | When | Settings |\n| --- | --- | --- |", sender.label()).unwrap();
        for e in &events {
            writeln!(out, "| `{}` | {} | {} |", e.name, when(e), settings(e.settings)).unwrap();
        }
        writeln!(out, "\nIts `p` holds:\n\n| Field | Is |\n| --- | --- |").unwrap();
        let mut fields = Vec::new();
        for field in events.iter().flat_map(|e| e.brings) {
            if !fields.contains(&field) {
                fields.push(field);
            }
        }
        for field in fields {
            let (name, words) = field;
            let from: Vec<String> = events.iter().filter(|e| e.brings.contains(field)).map(|e| format!("`{}`", e.name)).collect();
            let only = if from.len() == events.len() { String::new() } else { format!("{} only: ", and(&from)) };
            writeln!(out, "| `{name}` | {only}{words} |").unwrap();
        }
        let mut shown = Vec::new();
        for s in events.iter().flat_map(|e| e.settings).filter(|s| !s.options.is_empty()) {
            if shown.contains(&s.name) {
                continue;
            }
            shown.push(s.name);
            writeln!(out, "\n`{}` is one of:\n\n| Value | Is |\n| --- | --- |", s.name).unwrap();
            for (value, words) in s.options {
                writeln!(out, "| `{value}` | {words} |").unwrap();
            }
        }
        out.push('\n');
    }
    out
}

/// When an event comes, and what ends it or what it ends.
fn when(e: &EventInfo) -> String {
    let mut out = format!("{}{}.", e.words[..1].to_uppercase(), &e.words[1..]);
    match (e.ends_with, ended_by(e.name)) {
        (Some(end), _) if end == e.name => out += " Comes once more at rest, its numbers 0.",
        (Some(end), _) => write!(out, " Ends with `{end}`.").unwrap(),
        (None, Some(begins)) => write!(out, " Ends a `{}`.", begins.name).unwrap(),
        (None, None) => {}
    }
    out
}

/// Each setting as its `<on>` writes it, with its default. `while` is left to the words above
/// the tables, as every event but an end takes it.
fn settings(of: &[SettingInfo]) -> String {
    let each: Vec<String> = of
        .iter()
        .filter(|s| s.name != "while")
        .map(|s| match s.kind {
            SettingKind::Filter if s.default == ANY => format!("`{}`", s.name),
            _ => format!("`{}=\"{}\"`", s.name, s.default),
        })
        .collect();
    each.join(", ")
}

/// The names api.js lists, a table for each set of places that reads them, JavaScript's own
/// last.
fn names() -> String {
    let api = crate::script::api();
    let places = &api["PLACES"];
    let text = |v: &Json| v.as_str().unwrap_or_default().to_owned();
    let mut groups: Vec<(String, String)> = Vec::new();
    for a in api["API"].as_array().expect("API is a list") {
        let called = |n: &Json| match n["takes"].as_array() {
            Some(takes) => format!("{}({})", text(&n["name"]), takes.iter().map(text).collect::<Vec<_>>().join(", ")),
            None => text(&n["name"]),
        };
        let name = called(a);
        let heading = match a["places"].as_array() {
            _ if a["standard"] == Json::Bool(true) => "JavaScript's own".to_owned(),
            Some(ps) => format!("Read in {}", and(&ps.iter().map(|p| text(&places[text(p)])).collect::<Vec<_>>())),
            None => "Read everywhere".to_owned(),
        };
        let mut rows = format!("| `{name}` | {} |\n", text(&a["words"]));
        // Rant Math's hundreds of calls have docs of their own, and completion lists them
        let listed = if text(&a["name"]) == "math" { None } else { a["fields"].as_array() };
        for f in listed.into_iter().flatten() {
            writeln!(rows, "| `{}.{}` | {} |", text(&a["name"]), called(f), text(&f["words"])).unwrap();
        }
        match groups.iter_mut().find(|(h, _)| *h == heading) {
            Some((_, table)) => table.push_str(&rows),
            None => groups.push((heading, rows)),
        }
    }
    groups.iter().map(|(heading, rows)| format!("### {heading}\n\n| Name | Is |\n| --- | --- |\n{rows}")).collect::<Vec<_>>().join("\n")
}

/// `words` as a sentence lists them: "a, b and c".
fn and(words: &[String]) -> String {
    match words.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => words.concat(),
    }
}

/// `sheet` with `table` between the marks named `name`.
fn fill(sheet: &mut String, name: &str, table: &str) {
    let (open, close) = (format!("<!-- {name}:"), format!("<!-- end {name} -->"));
    let at = sheet.find(&open).unwrap_or_else(|| panic!("the sheet has no {open}"));
    let start = at + sheet[at..].find('\n').expect("a mark ends its line") + 1;
    let end = start + sheet[start..].find(&close).unwrap_or_else(|| panic!("the sheet has no {close}"));
    sheet.replace_range(start..end, &format!("\n{}\n\n", table.trim_end()));
}

#[test]
fn the_docs_read_the_code() {
    let docs = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs");
    for (file, name, table) in [("events.md", "events", events()), ("code.md", "names", names())] {
        let path = docs.join(file);
        let was = std::fs::read_to_string(&path).unwrap();
        let mut sheet = was.clone();
        fill(&mut sheet, name, &table);
        if sheet != was {
            std::fs::write(&path, &sheet).unwrap();
        }
    }
    // what is written by hand still names every tag and attribute a page may hold
    let pages = std::fs::read_to_string(docs.join("pages.md")).unwrap();
    let attrs = WORDS.iter().flat_map(|(tag, _)| own_attrs(*tag)).chain(ATTRS.iter());
    for word in WORDS.iter().map(|(_, w)| w).chain(attrs) {
        assert!(pages.contains(&format!("`{word}`")), "docs/pages.md never names `{word}`");
    }
}
