//! Saving the project's files, and the folders pages, components and objects are kept in.

use std::fs;
use std::path::{Path, PathBuf};

/// Writes beside the file and renames over it, so a crash never leaves half a file. The error
/// is for the user.
pub fn write(file: &Path, text: &str) -> Result<(), String> {
    let partial = file.with_extension(format!("{}.partial", file.extension().and_then(|e| e.to_str()).unwrap_or("")));
    file.parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|_| fs::write(&partial, text))
        .and_then(|_| fs::rename(&partial, file))
        .map_err(|e| format!("could not save {}: {e}", file.display()))
}

/// A project file's name as a person reads it: from the project's folder, with forward slashes.
pub fn shown(root: &Path, file: &Path) -> String {
    file.strip_prefix(root).unwrap_or(file).to_string_lossy().replace('\\', "/")
}

/// Writes a value as TOML, as `write` does.
pub fn write_toml(file: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    write(file, &toml::to_string(value).map_err(|e| e.to_string())?)
}

/// The `.html` files under `dir` at any depth, each with the folder it is in counted from `dir`,
/// `/` between levels and empty at its top, in path order.
pub fn html_under(dir: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    walk(dir, "", &mut |path, folder| {
        if path.extension().is_some_and(|x| x == "html") {
            out.push((path.to_path_buf(), folder.to_owned()));
        }
    });
    out.sort();
    out
}

/// Every folder under `dir` at any depth, counted from `dir`, `/` between levels, in order.
pub fn folders_under(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk(dir, "", &mut |path, folder| {
        if path.is_dir() {
            out.push(join(folder, &path.file_name().unwrap_or_default().to_string_lossy()));
        }
    });
    out.sort();
    out
}

/// Calls `each` with every entry under `dir` and the folder it is in, folders before what they hold.
fn walk(dir: &Path, folder: &str, each: &mut impl FnMut(&Path, &str)) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for path in entries.filter_map(|e| Some(e.ok()?.path())) {
        each(&path, folder);
        if path.is_dir() {
            let inner = join(folder, &path.file_name().unwrap_or_default().to_string_lossy());
            walk(&path, &inner, each);
        }
    }
}

/// `name` inside `folder`, `/` between them.
pub fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() { name.to_owned() } else { format!("{folder}/{name}") }
}

/// The folder `folder`, `/` between its levels, under `dir`.
pub fn in_folder(dir: &Path, folder: &str) -> PathBuf {
    folder.split('/').filter(|l| !l.is_empty()).fold(dir.to_path_buf(), |at, level| at.join(level))
}

/// Whether `folder` is one a person may name, empty for the top: levels of letters, digits,
/// spaces, `-` and `_`, `/` between them. The error is for the user.
pub fn check_folder(folder: &str) -> Result<(), String> {
    if folder.is_empty() {
        return Ok(());
    }
    for level in folder.split('/') {
        let fits = !level.trim().is_empty() && level == level.trim() && level.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'));
        if !fits {
            return Err(format!("{folder} is no folder name: each level takes letters, digits, spaces, - and _"));
        }
    }
    Ok(())
}

/// Makes the folder `folder` under `dir`. The error is for the user.
pub fn make_folder(dir: &Path, folder: &str) -> Result<(), String> {
    check_folder(folder)?;
    let at = in_folder(dir, folder);
    if folder.is_empty() || at.exists() {
        return Err(format!("{folder} is already a folder"));
    }
    fs::create_dir_all(&at).map_err(|e| format!("could not make {}: {e}", at.display()))
}

/// Moves the folder `from` under `dir`, and all it holds, to `to`, which renames it. The error
/// is for the user.
pub fn move_folder(dir: &Path, from: &str, to: &str) -> Result<(), String> {
    check_folder(to)?;
    let (at, there) = (in_folder(dir, from), in_folder(dir, to));
    if from.is_empty() || !at.is_dir() {
        return Err(format!("there is no folder {from}"));
    }
    if to.is_empty() || there.exists() {
        return Err(format!("{to} is already taken"));
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(format!("{from} cannot go inside itself"));
    }
    if let Some(parent) = there.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not make {}: {e}", parent.display()))?;
    }
    fs::rename(&at, &there).map_err(|e| format!("could not move {from} to {to}: {e}"))
}

/// Removes the folder `folder` under `dir`, what it holds moving up into the folder around it,
/// unless something there has the same name. The error is for the user.
pub fn remove_folder(dir: &Path, folder: &str) -> Result<(), String> {
    let at = in_folder(dir, folder);
    if folder.is_empty() || !at.is_dir() {
        return Err(format!("there is no folder {folder}"));
    }
    let up = at.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.to_path_buf());
    let held: Vec<PathBuf> = fs::read_dir(&at).map_err(|e| format!("could not read {}: {e}", at.display()))?.filter_map(|e| Some(e.ok()?.path())).collect();
    if let Some(clash) = held.iter().find(|p| p.file_name().is_some_and(|n| up.join(n).exists())) {
        return Err(format!("{} is already in the folder around {folder}", clash.file_name().unwrap_or_default().to_string_lossy()));
    }
    for p in &held {
        let there = up.join(p.file_name().unwrap_or_default());
        fs::rename(p, &there).map_err(|e| format!("could not move {}: {e}", p.display()))?;
    }
    fs::remove_dir(&at).map_err(|e| format!("could not remove {}: {e}", at.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_are_made_moved_and_removed_into_the_one_around() {
        let dir = std::env::temp_dir().join(format!("rant-hmi-files-folders-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        make_folder(&dir, "cell/line").unwrap();
        write(&dir.join("cell/line/robot.html"), "x").unwrap();
        assert!(make_folder(&dir, "cell").is_err());
        assert!(make_folder(&dir, "bad/../up").is_err());
        assert_eq!(folders_under(&dir), ["cell", "cell/line"]);
        assert!(move_folder(&dir, "cell", "cell/inner").is_err());
        move_folder(&dir, "cell", "plant").unwrap();
        assert_eq!(html_under(&dir), [(dir.join("plant").join("line").join("robot.html"), "plant/line".to_owned())]);
        remove_folder(&dir, "plant/line").unwrap();
        assert_eq!(html_under(&dir), [(dir.join("plant").join("robot.html"), "plant".to_owned())]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
