//! Builds the standard components into the binary from `library/components`, so a new project
//! starts with them wherever the HMI runs.

use std::path::Path;
use std::{env, fs};

fn main() {
    println!("cargo:rerun-if-changed=library/components");
    let mut names: Vec<String> = fs::read_dir("library/components")
        .expect("library/components holds the standard components")
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".html"))
        .collect();
    names.sort();
    let rows: String = names
        .iter()
        .map(|n| format!("    ({n:?}, include_str!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/library/components/{n}\"))),\n"))
        .collect();
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("library.rs");
    fs::write(out, format!("/// Each standard component's file name and text.\npub const COMPONENTS: &[(&str, &str)] = &[\n{rows}];\n")).unwrap();
}
