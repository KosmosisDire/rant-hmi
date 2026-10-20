//! The standard components a new project starts with. The build scenarios make them by hand
//! in the editor, and `node tests/run.mjs build- --library` keeps them in `library/components`.

use std::path::Path;

use anyhow::{Result, anyhow};

use crate::files;

include!(concat!(env!("OUT_DIR"), "/library.rs"));

/// Writes the standard components into a project that has no components yet.
pub fn seed(root: &Path) -> Result<()> {
    let folder = root.join("components");
    if folder.exists() {
        return Ok(());
    }
    for (name, text) in COMPONENTS {
        files::write(&folder.join(name), text).map_err(|e| anyhow!("writing components/{name}: {e}"))?;
    }
    Ok(())
}
