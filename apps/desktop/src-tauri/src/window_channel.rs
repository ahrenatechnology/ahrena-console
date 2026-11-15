// The app's end of the window credential channel (decision 0025, issue #619, layer 3). The app makes a socketpair, hands one end to the
// owner's `start` as fd 3 (`--window-channel 3`), and, when `start` reports a core it STARTED, writes one credential line on its own
// end and keeps that end open for as long as the core is the app's: closing it (the app exits, or replaces the core) is the EOF that
// revokes the credential. The credential lives in memory and in the /ui window's injected script; it is never written to a file, a log,
// a URL, an environment variable, an argument or a menu. (#619)

use std::fmt;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;

/// The descriptor number the owner's `start` receives the channel on (#619).
pub const CHANNEL_FD: RawFd = 3;

/// The option that tells the owner's `start` which descriptor carries the channel (#619).
pub const CHANNEL_OPTION: &str = "--window-channel";

/// Bytes of entropy in a credential: 256 bits (#619).
const CREDENTIAL_BYTES: usize = 32;

/// The credential: 64 lowercase hex characters. Its `Debug` never shows the value, so no `{:?}` of a struct that holds it can leak it (#619).
#[derive(Clone, PartialEq)]
pub struct WindowCredential(String);

impl fmt::Debug for WindowCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WindowCredential(<redacted>)")
    }
}

impl WindowCredential {
    /// A credential from the OS CSPRNG (`getentropy`) (#619).
    pub fn generate() -> io::Result<Self> {
        let mut bytes = [0u8; CREDENTIAL_BYTES];
        // SAFETY: `bytes` is a writable buffer of exactly the length passed, and `getentropy` accepts at most 256 bytes (#619).
        if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self::from_bytes(&bytes))
    }

    pub fn from_bytes(bytes: &[u8; CREDENTIAL_BYTES]) -> Self {
        Self(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }

    /// The value, for the one place that needs it: the window's injected script (#619).
    pub fn reveal(&self) -> &str {
        &self.0
    }

    /// What goes on the wire: the value and a newline (#619).
    fn line(&self) -> String {
        format!("{}\n", self.0)
    }
}

/// The end handed to the owner. It is close-on-exec like the app's own end; `pass_as_fd3` clears that for fd 3 of one child only (#619).
pub struct ChildEnd(OwnedFd);

impl ChildEnd {
    /// The far end as a stream, to play the core's part in a test (#619).
    #[cfg(test)]
    pub fn into_stream(self) -> UnixStream {
        UnixStream::from(self.0)
    }

    /// Makes `command`'s child see this end as fd 3. Both ends of the pair are close-on-exec, so no other child inherits either (#619).
    pub fn pass_as_fd3(&self, command: &mut Command) {
        let fd = self.0.as_raw_fd();
        // SAFETY: the closure runs between fork and exec and only calls `dup2` and `fcntl`, which are async-signal-safe, on a descriptor
        // that stays open in the parent until after the spawn (#619).
        unsafe {
            command.pre_exec(move || {
                if fd == CHANNEL_FD {
                    // `dup2` onto itself does nothing and would leave close-on-exec set.
                    if libc::fcntl(CHANNEL_FD, libc::F_SETFD, 0) == -1 {
                        return Err(io::Error::last_os_error());
                    }
                } else if libc::dup2(fd, CHANNEL_FD) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
}

/// The socketpair: the app's end, and the end for the owner. `UnixStream::pair` makes both close-on-exec (#619).
pub fn open() -> io::Result<(UnixStream, ChildEnd)> {
    let (app, child) = UnixStream::pair()?;
    Ok((app, ChildEnd(OwnedFd::from(child))))
}

/// A credential in force: the value, and the app's end of its channel. Dropping it closes the channel, which revokes the credential (#619).
#[derive(Debug)]
pub struct Grant {
    credential: WindowCredential,
    _channel: UnixStream,
}

impl Grant {
    pub fn credential(&self) -> &WindowCredential {
        &self.credential
    }
}

/// Generates a credential and writes it as one line on `channel`. On any failure no credential exists: the channel is dropped (closed) (#619).
pub fn issue(mut channel: UnixStream) -> io::Result<Grant> {
    let credential = WindowCredential::generate()?;
    channel.write_all(credential.line().as_bytes())?;
    Ok(Grant {
        credential,
        _channel: channel,
    })
}

static CURRENT: Mutex<Option<(u16, WindowCredential)>> = Mutex::new(None);

/// Makes `credential` the one the /ui window of the core on `port` gets (#619).
pub fn publish(port: u16, credential: &WindowCredential) {
    *CURRENT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((port, credential.clone()));
}

pub fn clear() {
    *CURRENT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// The credential for the window of the core on `port`, if the app holds one for that core (#619).
pub fn current(port: u16) -> Option<WindowCredential> {
    CURRENT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(p, _)| *p == port)
        .map(|(_, c)| c.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn a_credential_is_64_lowercase_hex_and_a_line_adds_a_newline() {
        let c = WindowCredential::from_bytes(&[0xab; 32]);
        assert_eq!(c.reveal(), "ab".repeat(32));
        assert_eq!(c.line(), format!("{}\n", "ab".repeat(32)));
        let g = WindowCredential::generate().unwrap();
        assert_eq!(g.reveal().len(), 64);
        assert!(g
            .reveal()
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }

    #[test]
    fn two_credentials_differ() {
        assert_ne!(
            WindowCredential::generate().unwrap(),
            WindowCredential::generate().unwrap()
        );
    }

    #[test]
    fn debug_never_prints_the_value() {
        let c = WindowCredential::from_bytes(&[0xcd; 32]);
        assert!(!format!("{c:?}").contains("cdcd"));
        let (app, _child) = open().unwrap();
        let grant = Grant {
            credential: c,
            _channel: app,
        };
        assert!(!format!("{grant:?}").contains("cdcd"));
    }

    #[test]
    fn the_window_gets_the_credential_of_its_own_core_only() {
        let c = WindowCredential::from_bytes(&[0x01; 32]);
        clear();
        assert!(current(4720).is_none());
        publish(4720, &c);
        assert_eq!(current(4720), Some(c));
        assert!(current(4721).is_none(), "another port");
        clear();
        assert!(current(4720).is_none());
    }

    /// Runs `sh -c script` with the channel's far end as fd 3, and returns its stdout.
    fn run_on_channel(script: &str, child: &ChildEnd) -> std::process::Child {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        child.pass_as_fd3(&mut command);
        command.spawn().unwrap()
    }

    #[test]
    fn the_child_reads_the_issued_credential_on_fd_3() {
        let (app, child) = open().unwrap();
        let process = run_on_channel("head -c 65 <&3", &child);
        drop(child);
        let grant = issue(app).unwrap();
        let out = process.wait_with_output().unwrap();
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            format!("{}\n", grant.credential().reveal())
        );
    }

    #[test]
    fn the_apps_end_is_inherited_by_no_child_so_dropping_it_is_eof_for_the_core() {
        let (app, child) = open().unwrap();
        // A child that outlives the exchange and was spawned after the pair existed: it must not hold the app's end.
        let mut bystander = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let process = run_on_channel("cat <&3", &child);
        drop(child);
        let grant = issue(app).unwrap();
        let value = grant.credential().reveal().to_string();
        drop(grant);
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut out = String::new();
            let mut p = process;
            p.stdout.take().unwrap().read_to_string(&mut out).unwrap();
            let _ = p.wait();
            let _ = tx.send(out);
        });
        let got = rx.recv_timeout(Duration::from_secs(10));
        let _ = bystander.kill();
        let _ = bystander.wait();
        assert_eq!(
            got.expect("EOF never arrived: the app's end leaked into a child"),
            format!("{value}\n")
        );
    }

    #[test]
    fn a_closed_channel_issues_nothing() {
        let (app, child) = open().unwrap();
        drop(child);
        // The first write after the peer closed may succeed into the buffer on some systems; the second cannot.
        let first = issue(app.try_clone().unwrap());
        let second = issue(app);
        assert!(first.is_err() || second.is_err());
    }
}
