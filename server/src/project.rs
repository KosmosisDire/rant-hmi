//! The project folder: `hmi.toml`, and the imports, variables, records and theme under
//! `data/`, as `docs/files.md` shows.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use crate::value::Value;
use ts_rs::TS;

use crate::{files, library};

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct ProjectInfo {
    pub name: String,
    /// The page an operator's screen opens on, else the first page.
    #[serde(default)]
    #[ts(optional)]
    pub start: Option<String>,
}

/// The four kinds of Rant entity.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Kind {
    Topic,
    Variable,
    Function,
    Task,
}

/// What the HMI may do with an import. Write means set, send or call.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Intent {
    Read,
    Write,
}

/// One mesh entity under an alias. Pages and handlers see only imports, never the mesh.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq, Eq)]
#[ts(export)]
pub struct Import {
    pub alias: String,
    pub entity: String,
    pub kind: Kind,
    pub intent: Intent,
}

#[derive(Serialize, Deserialize, Default)]
struct ImportsFile {
    #[serde(default, rename = "import")]
    imports: Vec<Import>,
}

/// Whose value a variable holds: one every screen shares, or one per screen.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Per {
    #[default]
    Hmi,
    Screen,
}

/// HMI state, named in camelCase, with the value it starts from.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Variable {
    pub name: String,
    pub start: Value,
    #[serde(default)]
    pub per: Per,
}

#[derive(Serialize, Deserialize, Default)]
struct VariablesFile {
    #[serde(default, rename = "variable")]
    variables: Vec<Variable>,
}

/// A value's history, named in camelCase: `source` sampled every `every_ms`, each sample kept
/// for `keep_s` seconds. Pages read it as a list of `{ t, v }`, oldest first.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Record {
    pub name: String,
    /// An expression over mesh imports and variables.
    pub source: String,
    pub every_ms: u32,
    pub keep_s: u32,
}

#[derive(Serialize, Deserialize, Default)]
struct RecordsFile {
    #[serde(default, rename = "record")]
    records: Vec<Record>,
}

/// A value worked out from others, as a C# property is, named in camelCase: a pure getter,
/// and a setter when a write can go back through one target.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Computed {
    pub name: String,
    /// An expression over imports, variables and other computed values, with no writes.
    pub get: String,
    #[serde(default)]
    #[ts(optional)]
    pub set: Option<Setter>,
    #[serde(default)]
    #[ts(optional)]
    pub unit: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
}

/// Where a write to a computed value goes: `target` takes `value`, an expression of the new
/// value `v`. `Duty` takes `v * 0.4`.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Setter {
    pub target: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Default)]
struct ComputedFile {
    #[serde(default, rename = "computed")]
    computed: Vec<Computed>,
}

/// A design value with one value per mode, read as `$name` anywhere, components too.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Token {
    /// camelCase, written without the `$` code puts before it.
    pub name: String,
    pub dark: String,
    pub light: String,
}

#[derive(Serialize, Deserialize, Default)]
struct ThemeFile {
    #[serde(default, rename = "token")]
    tokens: Vec<Token>,
}

pub struct Project {
    root: PathBuf,
    pub info: ProjectInfo,
    pub imports: Vec<Import>,
    pub variables: Vec<Variable>,
    pub records: Vec<Record>,
    pub computed: Vec<Computed>,
    pub tokens: Vec<Token>,
}

impl Project {
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Opens the folder, starting an empty project there when it holds none.
    pub fn open(root: &Path) -> Result<Project> {
        let hmi = root.join("hmi.toml");
        if !hmi.exists() {
            fs::create_dir_all(root).with_context(|| format!("making {}", root.display()))?;
            let name = fs::canonicalize(root)
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_else(|| "HMI".to_owned());
            fs::write(&hmi, toml::to_string(&ProjectInfo { name, start: None })?).with_context(|| format!("writing {}", hmi.display()))?;
            library::seed(root)?;
        }
        let info = toml::from_str(&read(&hmi)?).with_context(|| format!("reading {}", files::shown(root, &hmi)))?;
        let imports = load::<ImportsFile>(root, &imports_file(root))?.imports;
        let variables = load::<VariablesFile>(root, &variables_file(root))?.variables;
        let records = load::<RecordsFile>(root, &records_file(root))?.records;
        let computed = load::<ComputedFile>(root, &computed_file(root))?.computed;
        let tokens = load::<ThemeFile>(root, &theme_file(root))?.tokens;
        Ok(Project { root: root.to_path_buf(), info, imports, variables, records, computed, tokens })
    }

    /// Adds, changes or with None removes the token called `name`, and saves. A change may
    /// rename it. The error is for the user.
    pub fn set_token(&mut self, name: &str, to: Option<Token>) -> Result<(), String> {
        let at = self.tokens.iter().position(|t| t.name == name);
        match (to, at) {
            (None, Some(at)) => drop(self.tokens.remove(at)),
            (None, None) => return Err(format!("${name} is not a token")),
            (Some(t), at) => {
                let mut chars = t.name.chars();
                if !(chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_alphanumeric())) {
                    return Err(format!("\"{}\" cannot name a token: start with a small letter, then use letters and digits", t.name));
                }
                if t.name != name && self.tokens.iter().any(|x| x.name == t.name) {
                    return Err(format!("${} is already a token", t.name));
                }
                match at {
                    Some(at) => self.tokens[at] = t,
                    None => self.tokens.push(t),
                }
            }
        }
        files::write_toml(&theme_file(&self.root), &ThemeFile { tokens: self.tokens.clone() })
    }

    pub fn variable(&self, name: &str) -> Option<&Variable> {
        self.variables.iter().find(|v| v.name == name)
    }

    /// Adds, changes or with None removes the variable called `name`, and saves. A change
    /// may rename it. The error is for the user.
    pub fn set_variable(&mut self, name: &str, to: Option<Variable>) -> Result<(), String> {
        let at = self.variables.iter().position(|v| v.name == name);
        match (to, at) {
            (None, Some(at)) => {
                self.variables.remove(at);
            }
            (None, None) => return Err(format!("{name} is not a variable")),
            (Some(v), at) => {
                check_local(&v.name)?;
                if v.start.is_null() {
                    return Err(format!("{} needs a start value", v.name));
                }
                self.free(&v.name, "variable", name)?;
                match at {
                    Some(at) => self.variables[at] = v,
                    None => self.variables.push(v),
                }
            }
        }
        files::write_toml(&variables_file(&self.root), &VariablesFile { variables: self.variables.clone() })
    }

    pub fn record(&self, name: &str) -> Option<&Record> {
        self.records.iter().find(|r| r.name == name)
    }

    /// Adds, changes or with None removes the record called `name`, and saves. A change may
    /// rename it. The error is for the user.
    pub fn set_record(&mut self, name: &str, to: Option<Record>) -> Result<(), String> {
        let at = self.records.iter().position(|r| r.name == name);
        match (to, at) {
            (None, Some(at)) => drop(self.records.remove(at)),
            (None, None) => return Err(format!("{name} is not a record")),
            (Some(r), at) => {
                check_local(&r.name)?;
                if r.source.trim().is_empty() {
                    return Err(format!("{} needs a value to record", r.name));
                }
                if !(MIN_EVERY_MS..=86_400_000).contains(&r.every_ms) || !(1..=86_400).contains(&r.keep_s) {
                    return Err(format!("{} samples every {MIN_EVERY_MS} ms or more, and keeps from 1 s to a day", r.name));
                }
                self.free(&r.name, "record", name)?;
                match at {
                    Some(at) => self.records[at] = r,
                    None => self.records.push(r),
                }
            }
        }
        files::write_toml(&records_file(&self.root), &RecordsFile { records: self.records.clone() })
    }

    pub fn computed(&self, name: &str) -> Option<&Computed> {
        self.computed.iter().find(|c| c.name == name)
    }

    /// Adds, changes or with None removes the computed value called `name`, and saves. A
    /// change may rename it. The error is for the user.
    pub fn set_computed(&mut self, name: &str, to: Option<Computed>) -> Result<(), String> {
        let at = self.computed.iter().position(|c| c.name == name);
        match (to, at) {
            (None, Some(at)) => drop(self.computed.remove(at)),
            (None, None) => return Err(format!("{name} is not a computed value")),
            (Some(c), at) => {
                check_local(&c.name)?;
                self.free(&c.name, "computed value", name)?;
                if c.get.trim().is_empty() {
                    return Err(format!("{} needs an expression to work its value out", c.name));
                }
                if let Some(s) = &c.set {
                    if s.value.trim().is_empty() {
                        return Err(format!("{} needs the value its setter gives {}", c.name, s.target));
                    }
                    self.takes_writes(&s.target, &c.name)?;
                }
                let mut next = self.computed.clone();
                match at {
                    Some(at) => next[at] = c,
                    None => next.push(c),
                }
                if let Some(cycle) = cycle(&next) {
                    return Err(format!("{} reads itself through {}", cycle[0], cycle.join(", ")));
                }
                self.computed = next;
            }
        }
        files::write_toml(&computed_file(&self.root), &ComputedFile { computed: self.computed.clone() })
    }

    /// Whether `target` takes a computed value's writes: a variable imported to write, an HMI
    /// variable, or another computed value with a setter.
    fn takes_writes(&self, target: &str, from: &str) -> Result<(), String> {
        let ok = self.find(target).is_some_and(|i| i.kind == Kind::Variable && i.intent == Intent::Write)
            || self.variable(target).is_some()
            || (target != from && self.computed(target).is_some_and(|c| c.set.is_some()));
        match ok {
            true => Ok(()),
            false => Err(format!("{target} takes no writes: a setter writes a variable imported to write, an HMI variable, or a computed value with a setter")),
        }
    }

    /// Refuses `name` when another of the HMI's own names has it, a variable, a record or a
    /// computed value, leaving out `own`, the one of `kind` being changed.
    fn free(&self, name: &str, kind: &str, own: &str) -> Result<(), String> {
        let uses = [
            ("variable", self.variable(name).is_some()),
            ("record", self.record(name).is_some()),
            ("computed value", self.computed(name).is_some()),
        ];
        match uses.iter().find(|(what, used)| *used && !(*what == kind && name == own)) {
            Some((what, _)) => Err(format!("{name} is already a {what}")),
            None => Ok(()),
        }
    }

    pub fn find(&self, alias: &str) -> Option<&Import> {
        self.imports.iter().find(|i| i.alias == alias)
    }

    /// Adds an import and saves. The error is for the user.
    pub fn import(&mut self, import: Import) -> Result<(), String> {
        check_alias(&import.alias)?;
        if self.find(&import.alias).is_some() {
            return Err(format!("{} is already an import", import.alias));
        }
        // the mesh gives a node one handle per entity, so one alias each
        if let Some(other) = self.imports.iter().find(|i| i.entity == import.entity) {
            return Err(format!("{} is already imported as {}", import.entity, other.alias));
        }
        self.imports.push(import);
        self.save()
    }

    /// Makes `page` the one operators' screens open on, and saves.
    pub fn set_start(&mut self, page: String) -> Result<(), String> {
        self.info.start = Some(page);
        files::write_toml(&self.root.join("hmi.toml"), &self.info)
    }

    /// Changes an import's alias or intent and saves. Its entity and kind stay.
    pub fn change(&mut self, alias: &str, to: Import) -> Result<(), String> {
        let at = self.imports.iter().position(|i| i.alias == alias).ok_or_else(|| format!("{alias} is not an import"))?;
        let old = &self.imports[at];
        if to.entity != old.entity || to.kind != old.kind {
            return Err(format!("{alias} stays an import of {}", old.entity));
        }
        if to.alias != alias {
            check_alias(&to.alias)?;
            if self.find(&to.alias).is_some() {
                return Err(format!("{} is already an import", to.alias));
            }
        }
        self.imports[at] = to;
        self.save()
    }

    /// Removes an import and saves. The error is for the user.
    pub fn unimport(&mut self, alias: &str) -> Result<(), String> {
        let at = self.imports.iter().position(|i| i.alias == alias).ok_or_else(|| format!("{alias} is not an import"))?;
        self.imports.remove(at);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        files::write_toml(&imports_file(&self.root), &ImportsFile { imports: self.imports.clone() })
    }
}

fn imports_file(root: &Path) -> PathBuf {
    root.join("data").join("imports.toml")
}

fn variables_file(root: &Path) -> PathBuf {
    root.join("data").join("variables.toml")
}

fn records_file(root: &Path) -> PathBuf {
    root.join("data").join("records.toml")
}

fn computed_file(root: &Path) -> PathBuf {
    root.join("data").join("computed.toml")
}

/// A data file, empty while there is none.
fn load<F: DeserializeOwned + Default>(root: &Path, file: &Path) -> Result<F> {
    match file.exists() {
        true => toml::from_str(&read(file)?).with_context(|| format!("reading {}", files::shown(root, file))),
        false => Ok(F::default()),
    }
}

/// A chain of computed values that reads or writes back into its first, the names in order,
/// else None. A getter reads the computed values it names, a setter writes its target.
fn cycle(all: &[Computed]) -> Option<Vec<String>> {
    let next = |c: &Computed| -> Vec<String> {
        let mut out: Vec<String> = all.iter().filter(|o| names_in(&c.get).contains(&o.name)).map(|o| o.name.clone()).collect();
        out.extend(c.set.iter().filter(|s| all.iter().any(|o| o.name == s.target)).map(|s| s.target.clone()));
        out
    };
    fn walk(at: &str, all: &[Computed], next: &dyn Fn(&Computed) -> Vec<String>, path: &mut Vec<String>) -> bool {
        if path.iter().any(|p| p == at) {
            path.push(at.to_owned());
            return true;
        }
        path.push(at.to_owned());
        let found = all.iter().find(|c| c.name == at).is_some_and(|c| next(c).iter().any(|n| walk(n, all, next, path)));
        if !found {
            path.pop();
        }
        found
    }
    all.iter().find_map(|c| {
        let mut path = Vec::new();
        walk(&c.name, all, &next, &mut path).then(|| {
            let start = path.iter().position(|p| p == path.last().unwrap()).unwrap();
            path[start..].to_vec()
        })
    })
}

/// The names code mentions, leaving out quoted text. Text in backticks counts, so a name in a
/// template's own words reads as used.
fn names_in(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = code.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let mut escaped = false;
            for d in chars.by_ref() {
                if d == c && !escaped {
                    break;
                }
                escaped = d == '\\' && !escaped;
            }
        } else if c.is_alphabetic() || c == '_' || c == '$' {
            let mut word = c.to_string();
            while let Some(&d) = chars.peek() {
                if !(d.is_alphanumeric() || d == '_' || d == '$') {
                    break;
                }
                word.push(d);
                chars.next();
            }
            out.push(word);
        } else if c.is_ascii_digit() {
            while chars.peek().is_some_and(|d| d.is_alphanumeric() || *d == '.') {
                chars.next();
            }
        }
    }
    out
}

/// The fastest a record samples, a little slower than the backend's tick.
const MIN_EVERY_MS: u32 = 50;

fn theme_file(root: &Path) -> PathBuf {
    root.join("data").join("theme.toml")
}

/// Names code already has or keeps, which a variable would hide.
const TAKEN_LOCAL: [&str; 47] = [
    "await", "break", "case", "catch", "class", "close", "const", "continue", "default", "delete", "do", "else", "export", "extends", "false",
    "finally", "for", "force", "function", "hold", "if", "import", "in", "instanceof", "let", "log", "new", "notify", "null", "of", "open",
    "page", "return", "screen", "sleep", "status", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "unforce",
    "until", "while",
];

/// A name of the math library's, such as sqrt or PI, which a variable or import would hide.
fn taken_by_math(name: &str) -> bool {
    crate::script::library_names().iter().any(|n| n == name)
}

/// Local names are camelCase, which is what tells them from imports.
fn check_local(name: &str) -> Result<(), String> {
    if TAKEN_LOCAL.contains(&name) || taken_by_math(name) {
        return Err(format!("{name} is a name code already uses, so pick another"));
    }
    let mut chars = name.chars();
    if chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Ok(());
    }
    Err(format!("\"{name}\" cannot name a variable: start with a small letter, then use letters, digits or _"))
}

fn read(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

/// Names code already has, which an import would hide.
const TAKEN: [&str; 22] = [
    "Array", "BigInt", "Boolean", "Date", "Error", "Infinity", "Intl", "JSON", "Map", "Math", "NaN", "Number", "Object", "Pages", "Promise",
    "Proxy", "Reflect", "RegExp", "Set", "String", "Symbol", "TypeError",
];

/// An import is named in PascalCase, which is what tells mesh names from local ones.
fn check_alias(alias: &str) -> Result<(), String> {
    if TAKEN.contains(&alias) || taken_by_math(alias) {
        return Err(format!("{alias} is a name code already uses, so pick another"));
    }
    let mut chars = alias.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_uppercase());
    if first_ok && chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Ok(());
    }
    Err(format!("\"{alias}\" cannot be an alias: start with a capital letter, then use letters, digits or _"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::value;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rant-hmi-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn speed() -> Import {
        Import { alias: "Speed".into(), entity: "Line1/Speed".into(), kind: Kind::Variable, intent: Intent::Write }
    }

    #[test]
    fn a_new_folder_becomes_a_project_and_imports_survive_a_reopen() {
        let dir = scratch("reopen");
        let mut p = Project::open(&dir).unwrap();
        assert!(p.imports.is_empty());
        p.import(speed()).unwrap();
        let again = Project::open(&dir).unwrap();
        assert_eq!(again.imports, vec![speed()]);
        assert!(fs::read_to_string(dir.join("data/imports.toml")).unwrap().contains("[[import]]"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_project_starts_with_the_standard_components_once() {
        let dir = scratch("library");
        Project::open(&dir).unwrap();
        let pages = crate::pages::Pages::open(&dir).unwrap();
        let mut names: Vec<&str> = pages.list.iter().filter(|p| p.interface.is_some()).map(|p| p.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["Button", "Dropdown", "Gauge", "Joystick", "Knob", "ModeSwitch", "Plot", "Readout", "Slider", "Toggle"]);
        // a project that has its own leaves them be
        fs::remove_file(dir.join("components/button.html")).unwrap();
        Project::open(&dir).unwrap();
        assert!(!dir.join("components/button.html").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn computed_values_refuse_a_taken_name_a_target_without_writes_and_a_cycle() {
        let dir = scratch("computed");
        let mut p = Project::open(&dir).unwrap();
        p.import(speed()).unwrap();
        let c = |name: &str, get: &str, set: Option<(&str, &str)>| Computed {
            name: name.into(),
            get: get.into(),
            set: set.map(|(target, value)| Setter { target: target.into(), value: value.into() }),
            unit: None,
            note: None,
        };
        p.set_computed("percent", Some(c("percent", "Speed * 100", Some(("Speed", "v / 100"))))).unwrap();
        p.set_variable("mode", Some(Variable { name: "mode".into(), start: value!("Auto"), per: Per::Hmi })).unwrap();
        assert!(p.set_computed("mode", Some(c("mode", "1", None))).unwrap_err().contains("already a variable"));
        assert!(p.set_variable("percent", Some(Variable { name: "percent".into(), start: value!(1), per: Per::Hmi })).unwrap_err().contains("already a computed value"));
        assert!(p.set_computed("bad", Some(c("bad", "1", Some(("Nothing", "v"))))).unwrap_err().contains("takes no writes"));
        p.set_computed("half", Some(c("half", "percent / 2", None))).unwrap();
        assert!(p.set_computed("percent", Some(c("percent", "half * 2", None))).unwrap_err().contains("reads itself"));
        // a name in quotes is text, not a read
        p.set_computed("label", Some(c("label", "\"label: \" + half", None))).unwrap();
        let again = Project::open(&dir).unwrap();
        assert_eq!(again.computed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["percent", "half", "label"]);
        assert_eq!(again.computed[0].set.as_ref().unwrap().target, "Speed");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn variables_survive_a_reopen_and_keep_to_their_names() {
        let dir = scratch("variables");
        let mut p = Project::open(&dir).unwrap();
        let mode = Variable { name: "jogMode".into(), start: value!("Joint"), per: Per::Screen };
        p.set_variable("jogMode", Some(mode.clone())).unwrap();
        let limits = Variable { name: "limits".into(), start: value!({ "low": 0.5, "high": [1, 2] }), per: Per::Hmi };
        p.set_variable("limits", Some(limits.clone())).unwrap();
        assert_eq!(Project::open(&dir).unwrap().variables, [mode.clone(), limits]);
        assert!(p.set_variable("Speed", Some(Variable { name: "Speed".into(), ..mode.clone() })).unwrap_err().contains("small letter"));
        assert!(p.set_variable("open", Some(Variable { name: "open".into(), ..mode.clone() })).unwrap_err().contains("already uses"));
        assert!(p.set_variable("sqrt", Some(Variable { name: "sqrt".into(), ..mode.clone() })).unwrap_err().contains("already uses"));
        assert!(p.set_variable("x", Some(Variable { name: "x".into(), start: Value::Null, per: Per::Hmi })).unwrap_err().contains("start value"));
        p.set_variable("jogMode", Some(Variable { name: "mode".into(), ..mode })).unwrap();
        p.set_variable("limits", None).unwrap();
        assert_eq!(Project::open(&dir).unwrap().variables.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["mode"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn records_survive_a_reopen_and_share_names_with_variables() {
        let dir = scratch("records");
        let mut p = Project::open(&dir).unwrap();
        let record = |name: &str, every_ms: u32| Record { name: name.into(), source: "Speed".into(), every_ms, keep_s: 60 };
        p.set_record("speedHistory", Some(record("speedHistory", 100))).unwrap();
        assert_eq!(Project::open(&dir).unwrap().records, [record("speedHistory", 100)]);
        assert!(p.set_record("fast", Some(record("fast", 10))).unwrap_err().contains("50 ms or more"));
        p.set_variable("mode", Some(Variable { name: "mode".into(), start: value!("Auto"), per: Per::Hmi })).unwrap();
        assert!(p.set_record("mode", Some(record("mode", 100))).unwrap_err().contains("already a variable"));
        assert!(p.set_variable("speedHistory", Some(Variable { name: "speedHistory".into(), start: value!(0), per: Per::Hmi })).unwrap_err().contains("already a record"));
        p.set_record("speedHistory", None).unwrap();
        assert!(Project::open(&dir).unwrap().records.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tokens_survive_a_reopen() {
        let dir = scratch("tokens");
        let mut p = Project::open(&dir).unwrap();
        let accent = Token { name: "accent".into(), dark: "#e04a3f".into(), light: "#c0392b".into() };
        p.set_token("accent", Some(accent.clone())).unwrap();
        assert_eq!(Project::open(&dir).unwrap().tokens, [accent.clone()]);
        assert!(p.set_token("Accent", Some(Token { name: "Accent".into(), ..accent })).unwrap_err().contains("small letter"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_start_page_survives_a_reopen() {
        let dir = scratch("start");
        let mut p = Project::open(&dir).unwrap();
        assert_eq!(p.info.start, None);
        p.set_start("robot-cell".into()).unwrap();
        assert_eq!(Project::open(&dir).unwrap().info.start.as_deref(), Some("robot-cell"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn aliases_are_pascal_case_and_unique() {
        let dir = scratch("alias");
        let mut p = Project::open(&dir).unwrap();
        assert!(p.import(Import { alias: "speed".into(), ..speed() }).is_err());
        assert!(p.import(Import { alias: "Line-1".into(), ..speed() }).is_err());
        p.import(speed()).unwrap();
        assert_eq!(p.import(speed()).unwrap_err(), "Speed is already an import");
        assert_eq!(p.import(Import { alias: "Pace".into(), ..speed() }).unwrap_err(), "Line1/Speed is already imported as Speed");
        p.unimport("Speed").unwrap();
        assert!(p.imports.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
