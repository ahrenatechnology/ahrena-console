// The desktop reads the owner's private lock; HTTP never publishes this capability.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

struct Owner {
    port: u16,
    source: OwnerSource,
}

enum OwnerSource {
    Lock { dir: PathBuf, pid: u32 },
    ExplicitDemoFile(PathBuf),
}

static OWNER: Mutex<Option<Owner>> = Mutex::new(None);

pub fn configure(dir: Option<&Path>, port: u16, pid: Option<u32>) {
    *OWNER.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = dir.zip(pid).map(|(dir, pid)| Owner { port, source: OwnerSource::Lock { dir: dir.to_path_buf(), pid } });
}

/// Called only for the explicit watch/demo mode; a normal app core never falls back to this file.
pub fn configure_demo(file: Option<&Path>, port: u16) {
    *OWNER.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = file.map(|path| Owner { port, source: OwnerSource::ExplicitDemoFile(path.to_path_buf()) });
}

pub fn clear() {
    *OWNER.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

pub fn token(port: u16) -> Option<String> {
    let guard = OWNER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let owner = guard.as_ref().filter(|o| o.port == port)?;
    match &owner.source {
        OwnerSource::Lock { dir, pid } => read_token(dir, owner.port, *pid),
        OwnerSource::ExplicitDemoFile(path) => read_demo_token(path),
    }
}

#[cfg(unix)]
fn read_private_file(path: &Path, max_bytes: u64) -> Option<String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    // geteuid has no pointers or side effects; it supplies the OS identity, not an environment value.
    let uid = unsafe { libc::geteuid() };
    let before = std::fs::symlink_metadata(path).ok()?;
    if !before.is_file() || before.uid() != uid || before.mode() & 0o777 != 0o600 { return None; }
    // Never follow a replacement symlink or block on a FIFO swapped into an explicit demo path.
    let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path).ok()?;
    let opened = file.metadata().ok()?;
    // Check the opened inode as well: a swapped path/symlink must not change what was validated.
    if !opened.is_file() || opened.dev() != before.dev() || opened.ino() != before.ino() || opened.uid() != uid || opened.mode() & 0o777 != 0o600 || opened.len() > max_bytes { return None; }
    let mut text = String::new();
    file.take(max_bytes + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= max_bytes).then_some(text)
}

#[cfg(not(unix))]
fn read_private_file(_path: &Path, _max_bytes: u64) -> Option<String> { None }

fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn read_demo_token(path: &Path) -> Option<String> {
    let token = read_private_file(path, 64)?;
    valid_token(&token).then_some(token)
}

#[cfg(unix)]
fn read_token(dir: &Path, port: u16, pid: u32) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::geteuid() };
    let directory = std::fs::symlink_metadata(dir).ok()?;
    if !directory.is_dir() || directory.uid() != uid || directory.mode() & 0o077 != 0 { return None; }
    let text = read_private_file(&dir.join("nucleo.json"), 4096)?;
    let lock: serde_json::Value = serde_json::from_str(&text).ok()?;
    if lock.get("port")?.as_u64()? != u64::from(port) || lock.get("pid")?.as_u64()? != u64::from(pid) { return None; }
    let token = lock.get("token")?.as_str()?;
    valid_token(token).then(|| token.to_owned())
}

#[cfg(not(unix))]
fn read_token(_dir: &Path, _port: u16, _pid: u32) -> Option<String> { None }

/// Runs before any page script, only in the top-level owner UI at the exact expected origin.
pub fn initialization_script(port: u16, token: &str) -> String {
    let secret = serde_json::to_string(token).expect("a string serializes");
    format!("if (window === window.top && location.origin === 'http://127.0.0.1:{port}' && (location.pathname === '/ui' || location.pathname.startsWith('/ui/'))) {{ window.__AHRENA_APP__ = true; Object.defineProperty(window, '__AHRENA_OWNER_TOKEN__', {{ value: {secret}, configurable: false, writable: false }}); }}")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn only_a_private_owner_lock_matching_the_core_is_accepted() {
        let dir = std::env::temp_dir().join(format!("ahrena-owner-auth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("nucleo.json");
        let secret = "a".repeat(64);
        std::fs::write(&path, serde_json::json!({ "port": 4720, "pid": 42, "token": secret }).to_string()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_token(&dir, 4720, 42).is_some());
        assert!(read_token(&dir, 4721, 42).is_none());
        assert!(read_token(&dir, 4720, 43).is_none());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_token(&dir, 4720, 42).is_none());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read_token(&dir, 4720, 42).is_none());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::rename(&path, dir.join("other.json")).unwrap();
        symlink(dir.join("other.json"), &path).unwrap();
        assert!(read_token(&dir, 4720, 42).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn demo_bootstrap_requires_an_explicit_private_regular_token_file() {
        let dir = std::env::temp_dir().join(format!("ahrena-demo-auth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("owner-token");
        std::fs::write(&path, "a".repeat(64)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_demo_token(&path).is_some());
        assert!(read_demo_token(&dir).is_none());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_demo_token(&path).is_none());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&path, dir.join("alias")).unwrap();
        assert!(read_demo_token(&dir.join("alias")).is_none());
        for invalid in ["short".to_string(), "A".repeat(64), format!("{}\n", "a".repeat(64))] {
            std::fs::write(&path, invalid).unwrap();
            assert!(read_demo_token(&path).is_none());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bootstrap_is_scoped_to_owner_origin_and_top_level_ui() {
        let script = initialization_script(4720, &"a".repeat(64));
        assert!(script.contains("window === window.top"));
        assert!(script.contains("location.origin === 'http://127.0.0.1:4720'"));
        assert!(script.contains("location.pathname === '/ui'"));
        assert!(script.contains("location.pathname.startsWith('/ui/')"));
        assert!(!script.contains("localStorage"));
    }
}
