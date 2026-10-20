//! The project folder: the HMI as plain text files that diff well and that VS Code or an AI
//! can edit. `hmi.toml` names it and `data/imports.toml` lists its imports.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct ProjectInfo {
    pub name: String,
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

pub struct Project {
    root: PathBuf,
    pub info: ProjectInfo,
    pub imports: Vec<Import>,
}

impl Project {
    /// Opens the folder, starting an empty project there when it holds none.
    pub fn open(root: &Path) -> Result<Project> {
        let hmi = root.join("hmi.toml");
        if !hmi.exists() {
            fs::create_dir_all(root).with_context(|| format!("making {}", root.display()))?;
            let name = fs::canonicalize(root)
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_else(|| "HMI".to_owned());
            fs::write(&hmi, toml::to_string(&ProjectInfo { name })?).with_context(|| format!("writing {}", hmi.display()))?;
        }
        let info = toml::from_str(&read(&hmi)?).with_context(|| format!("reading {}", hmi.display()))?;
        let file = imports_file(root);
        let imports = match file.exists() {
            true => toml::from_str::<ImportsFile>(&read(&file)?).with_context(|| format!("reading {}", file.display()))?.imports,
            false => Vec::new(),
        };
        Ok(Project { root: root.to_path_buf(), info, imports })
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

    /// Removes an import and saves. The error is for the user.
    pub fn unimport(&mut self, alias: &str) -> Result<(), String> {
        let at = self.imports.iter().position(|i| i.alias == alias).ok_or_else(|| format!("{alias} is not an import"))?;
        self.imports.remove(at);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let file = imports_file(&self.root);
        let text = toml::to_string(&ImportsFile { imports: self.imports.clone() }).map_err(|e| e.to_string())?;
        fs::create_dir_all(file.parent().unwrap_or(&self.root))
            .and_then(|_| fs::write(&file, text))
            .map_err(|e| format!("could not save {}: {e}", file.display()))
    }
}

fn imports_file(root: &Path) -> PathBuf {
    root.join("data").join("imports.toml")
}

fn read(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

/// An import is named in PascalCase, which is what tells mesh names from local ones.
fn check_alias(alias: &str) -> Result<(), String> {
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
