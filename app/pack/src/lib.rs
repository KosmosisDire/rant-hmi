//! The file a built HMI app is: a launcher, then the runtime it unpacks once per version, the
//! project it runs, its settings, and a trailer saying where each lies. The server writes it and
//! the launcher reads it, both through this crate. docs/design/native-app.md weighs the choice.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Ends every app, so a launcher knows it carries one.
const MAGIC: &[u8; 8] = b"RANTHMI1";

/// The folder the HMI keeps its own files in on this host, `.rant/hmi` in the home folder: its
/// certificate, the window's data, the runtimes it builds apps from and what apps unpack.
pub fn kept() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".rant").join("hmi"))
}

/// Where each part of an app lies in its file, in bytes from its start.
#[derive(Debug, Clone, PartialEq)]
pub struct Trailer {
    pub runtime: Range<u64>,
    pub project: Range<u64>,
    pub settings: Range<u64>,
}

impl Trailer {
    /// Its length at the end of the file: three ranges, then the mark.
    pub const LEN: u64 = 6 * 8 + MAGIC.len() as u64;

    pub fn write(&self, w: &mut impl Write) -> io::Result<()> {
        for r in [&self.runtime, &self.project, &self.settings] {
            w.write_all(&r.start.to_le_bytes())?;
            w.write_all(&r.end.to_le_bytes())?;
        }
        w.write_all(MAGIC)
    }

    /// The trailer that ends `file`, or None when it carries no app.
    pub fn read(file: &mut (impl Read + Seek)) -> io::Result<Option<Trailer>> {
        let len = file.seek(SeekFrom::End(0))?;
        if len < Self::LEN {
            return Ok(None);
        }
        file.seek(SeekFrom::End(-(Self::LEN as i64)))?;
        let mut b = [0u8; Self::LEN as usize];
        file.read_exact(&mut b)?;
        if &b[6 * 8..] != MAGIC {
            return Ok(None);
        }
        let at = |i: usize| u64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().expect("8 bytes"));
        let t = Trailer { runtime: at(0)..at(1), project: at(2)..at(3), settings: at(4)..at(5) };
        let inside = [&t.runtime, &t.project, &t.settings].iter().all(|r| r.start <= r.end && r.end <= len - Self::LEN);
        Ok(inside.then_some(t))
    }
}

/// What an app runs and how, which its launcher hands to the window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    /// The HMI's name.
    pub name: String,
    /// The id of its runtime, unpacked once for every app that shares it.
    pub runtime: String,
    pub shows: Shows,
    /// The Rant domain of the server it was built from.
    pub domain: u16,
    /// Keep the mesh on this host, as the server it was built from did.
    pub loopback: bool,
    pub fullscreen: bool,
    /// The server's own certificate, by the fingerprint the window trusts it by.
    pub trust: Option<String>,
}

/// What an app shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shows {
    /// The project it carries, run on the device, by the id of its archive.
    Project(String),
    /// The screen of the server at this address.
    Address(String),
}

/// An id for what `bytes` hold, which names the folder they are unpacked in.
pub fn id(bytes: &[u8]) -> String {
    id_of(bytes).expect("reading memory never fails")
}

/// The id of what `r` reads, as `id` names those bytes, read a piece at a time.
pub fn id_of(mut r: impl Read) -> io::Result<String> {
    let mut hash = Sha256::new();
    io::copy(&mut r, &mut hash)?;
    Ok(hash.finalize()[..16].iter().map(|b| format!("{b:02x}")).collect())
}

/// Writes all of `dir` but what is named with a leading dot, as a gzipped tar.
pub fn archive(dir: &Path, w: impl Write) -> io::Result<()> {
    let mut tar = tar::Builder::new(GzEncoder::new(w, Compression::default()));
    tar.follow_symlinks(false);
    add(&mut tar, dir, Path::new(""))?;
    tar.into_inner()?.finish()?;
    Ok(())
}

fn add(tar: &mut tar::Builder<impl Write>, dir: &Path, inside: &Path) -> io::Result<()> {
    let mut entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
    // the same folder makes the same archive, and so the same id
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = inside.join(&name);
        if e.file_type()?.is_dir() {
            tar.append_dir(&path, e.path())?;
            add(tar, &e.path(), &path)?;
        } else {
            tar.append_path_with_name(e.path(), &path)?;
        }
    }
    Ok(())
}

/// Unpacks a gzipped tar from `r` into `into`.
pub fn unpack(r: impl Read, into: &Path) -> io::Result<()> {
    tar::Archive::new(GzDecoder::new(r)).unpack(into)
}

/// The part of `file` in `range`, unpacked into `dir` unless an earlier start did. It lands whole
/// or not at all, so a start cut short never leaves half of it.
pub fn unpacked(file: &mut (impl Read + Seek), range: &Range<u64>, dir: &Path) -> io::Result<()> {
    file.seek(SeekFrom::Start(range.start))?;
    unpack_whole(file.take(range.end - range.start), dir, |_| Ok(()))
}

/// Unpacks a gzipped tar from `r` into `dir` unless it is there, whole or not at all: into a
/// folder beside it first, which `check` looks over before it takes the name.
pub fn unpack_whole(r: impl Read, dir: &Path, check: impl FnOnce(&Path) -> io::Result<()>) -> io::Result<()> {
    if dir.exists() {
        return Ok(());
    }
    let part = dir.with_extension(format!("part{}", std::process::id()));
    let _ = fs::remove_dir_all(&part);
    if let Err(e) = unpack(r, &part).and_then(|()| check(&part)) {
        let _ = fs::remove_dir_all(&part);
        return Err(e);
    }
    match fs::rename(&part, dir) {
        Ok(()) => Ok(()),
        // another start of the same app got there first
        Err(_) if dir.exists() => fs::remove_dir_all(&part),
        Err(e) => Err(e),
    }
}

/// Reads the part of `file` in `range`.
pub fn read(file: &mut (impl Read + Seek), range: &Range<u64>) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(range.start))?;
    let mut bytes = Vec::with_capacity((range.end - range.start) as usize);
    file.take(range.end - range.start).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rant-hmi-pack-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("pages")).unwrap();
        fs::write(dir.join("hmi.toml"), "name = \"Line\"\n").unwrap();
        fs::write(dir.join("pages").join("main.html"), "<page name=\"main\"/>\n").unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("HEAD"), "x").unwrap();
        dir
    }

    #[test]
    fn an_app_is_read_back_part_by_part() {
        let project = folder("parts");
        let mut runtime = Vec::new();
        archive(&project, &mut runtime).unwrap();
        let settings = Settings { name: "Line".into(), runtime: id(&runtime), shows: Shows::Address("http://host:6739".into()), domain: 7, loopback: true, fullscreen: false, trust: None };
        let json = serde_json::to_vec(&settings).unwrap();
        let mut file = b"LAUNCHER".to_vec();
        let at = |file: &Vec<u8>, n: usize| file.len() as u64..(file.len() + n) as u64;
        let t = Trailer { runtime: at(&file, runtime.len()), project: 0..0, settings: 0..0 };
        file.extend(&runtime);
        let t = Trailer { settings: at(&file, json.len()), ..t };
        file.extend(&json);
        t.write(&mut file).unwrap();

        let mut cursor = Cursor::new(file);
        let read_back = Trailer::read(&mut cursor).unwrap().expect("a trailer");
        assert_eq!(read_back, t);
        assert_eq!(serde_json::from_slice::<Settings>(&read(&mut cursor, &t.settings).unwrap()).unwrap(), settings);
        let into = project.with_extension("unpacked");
        let _ = fs::remove_dir_all(&into);
        unpacked(&mut cursor, &t.runtime, &into).unwrap();
        assert_eq!(fs::read_to_string(into.join("pages").join("main.html")).unwrap(), "<page name=\"main\"/>\n");
        assert!(!into.join(".git").exists(), "what starts with a dot stays out");
        // a second start finds it unpacked and leaves it
        fs::write(into.join("kept"), "").unwrap();
        unpacked(&mut cursor, &t.runtime, &into).unwrap();
        assert!(into.join("kept").exists());
        fs::remove_dir_all(&project).unwrap();
        fs::remove_dir_all(&into).unwrap();
    }

    #[test]
    fn a_file_with_no_app_has_no_trailer() {
        assert_eq!(Trailer::read(&mut Cursor::new(b"just a program".to_vec())).unwrap(), None);
        let mut bad = vec![0u8; 100];
        Trailer { runtime: 0..500, project: 0..0, settings: 0..0 }.write(&mut bad).unwrap();
        assert_eq!(Trailer::read(&mut Cursor::new(bad)).unwrap(), None, "a range past the end is no trailer");
    }

    #[test]
    fn what_its_check_refuses_is_not_unpacked() {
        let project = folder("refused");
        let mut archived = Vec::new();
        archive(&project, &mut archived).unwrap();
        let into = project.with_extension("refused");
        let _ = fs::remove_dir_all(&into);
        let refused = unpack_whole(&archived[..], &into, |part| {
            assert!(part.join("hmi.toml").is_file(), "the check sees it unpacked");
            Err(io::Error::other("not this one"))
        });
        assert_eq!(refused.unwrap_err().to_string(), "not this one");
        let left: Vec<_> = fs::read_dir(project.parent().unwrap()).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains("refused")).map(|e| e.file_name()).collect();
        assert_eq!(left, [project.file_name().unwrap()], "nothing but the project is left");
        assert_eq!(id_of(&archived[..]).unwrap(), id(&archived));
        fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn the_same_folder_makes_the_same_id() {
        let project = folder("same");
        let (mut a, mut b) = (Vec::new(), Vec::new());
        archive(&project, &mut a).unwrap();
        archive(&project, &mut b).unwrap();
        assert_eq!(id(&a), id(&b));
        fs::remove_dir_all(&project).unwrap();
    }
}
