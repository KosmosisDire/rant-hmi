//! Saving the project's files.

use std::fs;
use std::path::Path;

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
