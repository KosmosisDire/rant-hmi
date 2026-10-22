//! `rant-hmi-pack <runtime folder> <out folder>`: archives a runtime that app/runtime.mjs put
//! together, as `runtime.tar.gz` beside `runtime.id`, the id that names it on every device.

use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [runtime, out] = args.as_slice() else {
        eprintln!("usage: rant-hmi-pack <runtime folder> <out folder>");
        return ExitCode::FAILURE;
    };
    let archive = out.join("runtime.tar.gz");
    let made = fs::create_dir_all(out)
        .and_then(|()| File::create(&archive))
        .and_then(|f| rant_hmi_pack::archive(runtime, BufWriter::new(f)))
        .and_then(|()| fs::read(&archive))
        .and_then(|bytes| fs::write(out.join("runtime.id"), rant_hmi_pack::id(&bytes)));
    match made {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("could not archive {}: {e}", runtime.display());
            ExitCode::FAILURE
        }
    }
}
