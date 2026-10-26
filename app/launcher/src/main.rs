//! What a built HMI app starts as. It finds what it carries after itself, unpacks the runtime
//! once per version and the project once per build, under the HMI's own folder, then runs the
//! window on them until it closes.

#![windows_subsystem = "windows"]

use std::env;
use std::fs::File;
use std::process::{Command, ExitCode};

use rant_hmi_pack::{Settings, Shows, Trailer, kept, read, unpacked};

/// Electron's program in a runtime.
#[cfg(windows)]
const WINDOW: &str = "electron.exe";
#[cfg(not(windows))]
const WINDOW: &str = "electron";

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(why) => {
            say(&why);
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<ExitCode, String> {
    let me = env::current_exe().map_err(|e| format!("Could not find this app's own file: {e}"))?;
    let mut file = File::open(&me).map_err(|e| format!("Could not open {}: {e}", me.display()))?;
    let trailer = Trailer::read(&mut file).ok().flatten().ok_or_else(|| format!("{} carries no HMI. Download it again.", me.display()))?;
    let settings: Settings = read(&mut file, &trailer.settings)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or("Its settings could not be read. Download it again.")?;
    // every part an app carries is unpacked once, in a folder named by its id
    let unpacked_in = kept().ok_or("There is no home folder to unpack it in.")?.join("unpacked");
    let runtime = unpacked_in.join(&settings.runtime);
    unpacked(&mut file, &trailer.runtime, &runtime).map_err(|e| format!("Could not unpack its runtime into {}: {e}", runtime.display()))?;
    let shows = match &settings.shows {
        Shows::Project(id) => {
            let project = unpacked_in.join(id);
            unpacked(&mut file, &trailer.project, &project).map_err(|e| format!("Could not unpack the HMI into {}: {e}", project.display()))?;
            project.into_os_string()
        }
        Shows::Address(address) => address.into(),
    };
    // every value after `=`, as Electron ends at once given an address then a value as the next word
    let mut window = Command::new(runtime.join(WINDOW));
    window.arg(shows).arg(format!("--domain={}", settings.domain));
    if settings.loopback {
        window.arg("--loopback");
    }
    if settings.fullscreen {
        window.arg("--fullscreen");
    }
    if let Some(trust) = &settings.trust {
        window.arg(format!("--trust={trust}"));
    }
    // Chromium ends at start where it cannot sandbox, so the window goes without it there
    #[cfg(target_os = "linux")]
    if !sandboxed() {
        window.arg("--no-sandbox");
    }
    // Chromium takes Wayland only in a session that says it is one, never a lone compositor as a kiosk runs
    #[cfg(target_os = "linux")]
    if env::var_os("WAYLAND_DISPLAY").is_some() && env::var_os("DISPLAY").is_none() {
        window.arg("--ozone-platform=wayland");
    }
    // what the app was started with goes on to the window, after what it was built with
    window.args(env::args_os().skip(1));
    // Electron runs as plain Node where this is set, as a VS Code extension's children inherit it
    window.env_remove("ELECTRON_RUN_AS_NODE");
    let status = window.status().map_err(|e| format!("Could not start its window: {e}"))?;
    Ok(ExitCode::from(status.code().unwrap_or(1).clamp(0, 255) as u8))
}

/// Says why the app cannot start: in a message box on Windows, where it has no console.
#[cfg(windows)]
fn say(why: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MessageBoxW};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    eprintln!("{why}");
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(why).as_ptr(), wide("Rant HMI").as_ptr(), MB_ICONERROR) };
}

#[cfg(not(windows))]
fn say(why: &str) {
    eprintln!("{why}");
}

/// Whether Chromium's sandbox can run here: a child maps this user into a user namespace, as the
/// sandbox does. Ubuntu 24.04 and later make the namespace but deny the map to unknown programs.
#[cfg(target_os = "linux")]
fn sandboxed() -> bool {
    let map = format!("0 {} 1", unsafe { libc::getuid() });
    let write = |path: &std::ffi::CStr, text: &[u8]| unsafe {
        let fd = libc::open(path.as_ptr(), libc::O_WRONLY);
        let wrote = fd >= 0 && libc::write(fd, text.as_ptr().cast(), text.len()) == text.len() as isize;
        if fd >= 0 {
            libc::close(fd);
        }
        wrote
    };
    // SAFETY: the launcher has one thread here, and the child makes only system calls before it exits
    unsafe {
        match libc::fork() {
            -1 => false,
            0 => {
                let made = libc::unshare(libc::CLONE_NEWUSER) == 0 && write(c"/proc/self/setgroups", b"deny") && write(c"/proc/self/uid_map", map.as_bytes());
                libc::_exit(if made { 0 } else { 1 })
            }
            child => {
                let mut status = 0;
                libc::waitpid(child, &mut status, 0) == child && libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
            }
        }
    }
}
