//! `rant-hmi-pack <folder> <file>`: archives a folder as apps carry one, a runtime that
//! app/runtime.mjs put together or what a release attaches for a platform, and prints its id.

use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [folder, file] = args.as_slice() else {
        eprintln!("usage: rant-hmi-pack <folder> <file>");
        return ExitCode::FAILURE;
    };
    let made = File::create(file)
        .and_then(|f| rant_hmi_pack::archive(folder, BufWriter::new(f)))
        .and_then(|()| fs::read(file));
    match made {
        Ok(bytes) => {
            println!("{}", rant_hmi_pack::id(&bytes));
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("could not archive {}: {e}", folder.display());
            ExitCode::FAILURE
        }
    }
}
