//! The tables of docs/reference.md, written by a test from where each lives in code, as
//! events.ts is. The sheet's own words stand around them.

use std::fmt::Write;

use serde_json::Value as Json;

use crate::events::{EVENTS, EventInfo, Gather, SENT, SettingInfo, SettingKind};
use crate::pages::format::{ATTRS, own_attrs};
use crate::pages::WORDS;

/// Each event as its sender's table, then the values of each filter that takes only some.
fn events() -> String {
    let mut out = String::new();
    let mut senders = Vec::new();
    for e in EVENTS {
        if !senders.contains(&e.from) {
            senders.push(e.from);
        }
    }
    for sender in senders {
        writeln!(out, "### {}\n\n| Event | When | Settings | `p` holds |\n| --- | --- | --- | --- |", sender.label()).unwrap();
        let events: Vec<&EventInfo> = EVENTS.iter().filter(|e| e.from == sender).collect();
        for (i, e) in events.iter().enumerate() {
            // what an event above brings too is named once, there
            let brings = match events[..i].iter().find(|x| x.brings == e.brings) {
                Some(x) => format!("as `{}`", x.name),
                None => e.brings.iter().map(|(name, words)| format!("`{name}` {words}")).collect::<Vec<_>>().join("<br>"),
            };
            writeln!(out, "| `{}` | {} | {} | {brings} |", e.name, when(e), settings(e.settings)).unwrap();
        }
        out.push('\n');
    }
    writeln!(out, "A component's own events, which its code sends with `emit`, take {}.", settings(SENT)).unwrap();
    let mut shown = Vec::new();
    for s in EVENTS.iter().flat_map(|e| e.settings).filter(|s| !s.options.is_empty()) {
        if shown.contains(&s.name) {
            continue;
        }
        shown.push(s.name);
        writeln!(out, "\n### The `{}` filter\n\n| Value | Is |\n| --- | --- |", s.name).unwrap();
        for (value, words) in s.options {
            writeln!(out, "| `{value}` | {words} |").unwrap();
        }
    }
    out
}

/// When an event comes, what ends it, and whether it streams.
fn when(e: &EventInfo) -> String {
    let mut out = format!("{}{}.", e.words[..1].to_uppercase(), &e.words[1..]);
    match e.ends_with {
        Some(end) if end == e.name => out += " Ends at rest.",
        Some(end) => write!(out, " Ended by `{end}`.").unwrap(),
        None => {}
    }
    if !e.once {
        let gathered = |how: Gather| e.gathers.iter().filter(|(_, g)| *g == how).map(|(name, _)| format!("`{name}`")).collect::<Vec<_>>().join(" and ");
        let ways: Vec<String> = [(Gather::Sum, "summing"), (Gather::Product, "multiplying")].into_iter().map(|(how, verb)| (gathered(how), verb)).filter(|(names, _)| !names.is_empty()).map(|(names, verb)| format!("{verb} {names}")).collect();
        out += &if ways.is_empty() { " A stream.".to_owned() } else { format!(" A stream, {}.", ways.join(", ")) };
    }
    out
}

/// Each setting as its `<on>` writes it, with its default, or a filter by name.
fn settings(of: &[SettingInfo]) -> String {
    if of.is_empty() {
        return "none".to_owned();
    }
    let each: Vec<String> = of
        .iter()
        .map(|s| match s.kind {
            SettingKind::Expression => format!("`{}=\"{}\"`", s.name, s.default),
            SettingKind::Filter => format!("`{}` filter", s.name),
        })
        .collect();
    each.join("<br>")
}

/// The names api.js lists: the HMI's own with where each is read, then JavaScript's.
fn names() -> String {
    let api = crate::script::api();
    let places = &api["PLACES"];
    let mut out = String::from("| Name | What | Read in |\n| --- | --- | --- |\n");
    let mut standard = String::from("\nJavaScript's own, read everywhere:\n\n| Name | What |\n| --- | --- |\n");
    for a in api["API"].as_array().expect("API is a list") {
        let text = |v: &Json| v.as_str().unwrap_or_default().to_owned();
        let name = match a["takes"].as_array() {
            Some(takes) => format!("{}({})", text(&a["name"]), takes.iter().map(text).collect::<Vec<_>>().join(", ")),
            None => text(&a["name"]),
        };
        if a["standard"] == Json::Bool(true) {
            writeln!(standard, "| `{name}` | {} |", text(&a["words"])).unwrap();
            continue;
        }
        let read: Vec<String> = a["places"].as_array().map(|ps| ps.iter().map(|p| text(&places[text(p)])).collect()).unwrap_or_else(|| vec!["everywhere".to_owned()]);
        let read = match read.split_last() {
            Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
            _ => read.concat(),
        };
        writeln!(out, "| `{name}` | {} | {read} |", text(&a["words"])).unwrap();
        for f in a["fields"].as_array().into_iter().flatten() {
            writeln!(out, "| `{}.{}` | {} | {read} |", text(&a["name"]), text(&f["name"]), text(&f["words"])).unwrap();
        }
    }
    out + &standard
}

/// `sheet` with `table` between the marks named `name`.
fn fill(sheet: &mut String, name: &str, table: &str) {
    let (open, close) = (format!("<!-- {name}:"), format!("<!-- end {name} -->"));
    let at = sheet.find(&open).unwrap_or_else(|| panic!("the sheet has no {open}"));
    let start = at + sheet[at..].find('\n').expect("a mark ends its line") + 1;
    let end = start + sheet[start..].find(&close).unwrap_or_else(|| panic!("the sheet has no {close}"));
    sheet.replace_range(start..end, &format!("\n{table}\n"));
}

#[test]
fn the_reference_sheet_reads_the_code() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/reference.md");
    let was = std::fs::read_to_string(&path).unwrap();
    let mut sheet = was.clone();
    fill(&mut sheet, "events", &events());
    fill(&mut sheet, "names", &names());
    if sheet != was {
        std::fs::write(&path, &sheet).unwrap();
    }
    // what is written by hand still names every tag and attribute a file may hold
    let attrs = WORDS.iter().flat_map(|(tag, _)| own_attrs(*tag)).chain(ATTRS.iter());
    for word in WORDS.iter().map(|(_, w)| w).chain(attrs) {
        assert!(sheet.contains(&format!("`{word}`")), "docs/reference.md never names `{word}`");
    }
}
