//! The standard components and the theme a new project starts with. The build scenarios make
//! the components by hand in the editor, and `node tests/run.mjs build- --library` keeps them in
//! `library/components`. The theme is Rant's own palette, `library/theme.toml`.

use std::path::Path;

use anyhow::{Result, anyhow};

use crate::files;

include!(concat!(env!("OUT_DIR"), "/library.rs"));

/// Rant's palette, radii, spacing and type as tokens, which the standard components read.
const THEME: &str = include_str!("../library/theme.toml");

/// Writes the standard components into a project that has no components yet, and the theme
/// into one that has no theme.
pub fn seed(root: &Path) -> Result<()> {
    let folder = root.join("components");
    if !folder.exists() {
        for (name, text) in COMPONENTS {
            files::write(&folder.join(name), text).map_err(|e| anyhow!("writing components/{name}: {e}"))?;
        }
    }
    let theme = root.join("data").join("theme.toml");
    if !theme.exists() {
        files::write(&theme, THEME).map_err(|e| anyhow!("writing data/theme.toml: {e}"))?;
    }
    Ok(())
}
