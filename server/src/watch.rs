//! Watches the project folder, so a file changed outside the HMI, by an editor or an AI,
//! reaches every screen.

use std::path::Path;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::UnboundedSender;

/// Starts watching `root`, sending on `changed` for each change to a project file. Watching
/// stops when the watcher drops.
pub fn watch(root: &Path, changed: UnboundedSender<()>) -> notify::Result<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |e: notify::Result<Event>| {
        if let Ok(e) = e {
            if !e.kind.is_access() && e.paths.iter().any(|p| project_file(p)) {
                let _ = changed.send(());
            }
        }
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// The files a project is made of, not the partial ones a save writes first.
fn project_file(p: &Path) -> bool {
    matches!(p.extension().and_then(|x| x.to_str()), Some("html" | "toml"))
}
