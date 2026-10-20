//! The project folder: `hmi.toml`, and the imports, variables and theme under `data/`, as
//! `docs/files.md` shows.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::files;

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
        }
        let info = toml::from_str(&read(&hmi)?).with_context(|| format!("reading {}", files::shown(root, &hmi)))?;
        let file = imports_file(root);
        let imports = match file.exists() {
            true => toml::from_str::<ImportsFile>(&read(&file)?).with_context(|| format!("reading {}", files::shown(root, &file)))?.imports,
            false => Vec::new(),
        };
        let file = variables_file(root);
        let variables = match file.exists() {
            true => toml::from_str::<VariablesFile>(&read(&file)?).with_context(|| format!("reading {}", files::shown(root, &file)))?.variables,
            false => Vec::new(),
        };
        let file = theme_file(root);
        let tokens = match file.exists() {
            true => toml::from_str::<ThemeFile>(&read(&file)?).with_context(|| format!("reading {}", files::shown(root, &file)))?.tokens,
            false => Vec::new(),
        };
        Ok(Project { root: root.to_path_buf(), info, imports, variables, tokens })
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
                if v.name != name && self.variable(&v.name).is_some() {
                    return Err(format!("{} is already a variable", v.name));
                }
                match at {
                    Some(at) => self.variables[at] = v,
                    None => self.variables.push(v),
                }
            }
        }
        files::write_toml(&variables_file(&self.root), &VariablesFile { variables: self.variables.clone() })
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

/// Local names are camelCase, which is what tells them from imports.
fn check_local(name: &str) -> Result<(), String> {
    if TAKEN_LOCAL.contains(&name) {
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
    if TAKEN.contains(&alias) {
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
    fn variables_survive_a_reopen_and_keep_to_their_names() {
        let dir = scratch("variables");
        let mut p = Project::open(&dir).unwrap();
        let mode = Variable { name: "jogMode".into(), start: serde_json::json!("Joint"), per: Per::Screen };
        p.set_variable("jogMode", Some(mode.clone())).unwrap();
        let limits = Variable { name: "limits".into(), start: serde_json::json!({ "low": 0.5, "high": [1, 2] }), per: Per::Hmi };
        p.set_variable("limits", Some(limits.clone())).unwrap();
        assert_eq!(Project::open(&dir).unwrap().variables, [mode.clone(), limits]);
        assert!(p.set_variable("Speed", Some(Variable { name: "Speed".into(), ..mode.clone() })).unwrap_err().contains("small letter"));
        assert!(p.set_variable("open", Some(Variable { name: "open".into(), ..mode.clone() })).unwrap_err().contains("already uses"));
        assert!(p.set_variable("x", Some(Variable { name: "x".into(), start: Value::Null, per: Per::Hmi })).unwrap_err().contains("start value"));
        p.set_variable("jogMode", Some(Variable { name: "mode".into(), ..mode })).unwrap();
        p.set_variable("limits", None).unwrap();
        assert_eq!(Project::open(&dir).unwrap().variables.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["mode"]);
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
        p.unimport("Speed").unwrap();
        assert!(p.imports.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
