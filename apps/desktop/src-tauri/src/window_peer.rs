// The native peer check of the window credential channel (decision 0025, issue #619, layer 2). The core cannot link Security.framework
// (it runs from source, no build step), so the installed app's own executable is the helper: `ahrena-console-desktop
// --verify-window-peer` reads the channel on its stdin and answers with its exit code. It answers `match` only when the process that
// created the socketpair is the installed app: the cdhash of the running peer, from its audit token, equals the cdhash of the file
// at the constant path, read on disk. It writes nothing to stdout or stderr. (#619)

use std::ffi::{OsStr, OsString};
use std::path::Path;

/// The one place the installed app is looked for. Never taken from an argument, an environment variable, a file or the peer (#619).
pub const INSTALLED_APP: &str =
    "/Applications/Ahrena Console.app/Contents/MacOS/ahrena-console-desktop";

/// The only argument the helper mode answers to (#619).
pub const HELPER_ARG: &str = "--verify-window-peer";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Match,
    Mismatch,
    Unavailable,
}

impl Verdict {
    /// The exit code the core's adapter reads: 100 match, 101 mismatch, 102 unavailable. Not 0, 1 and 2: an installed app from before this
    /// mode exists ignores the argument, and a second instance of it exits 0, which would read as a match for any peer (#619).
    pub fn exit_code(self) -> i32 {
        match self {
            Verdict::Match => 100,
            Verdict::Mismatch => 101,
            Verdict::Unavailable => 102,
        }
    }
}

/// Whether `args` (the whole argv) ask for the helper mode: exactly the executable and the one argument (#619).
pub fn is_helper_invocation(args: &[OsString]) -> bool {
    matches!(args, [_, arg] if arg.as_os_str() == OsStr::new(HELPER_ARG))
}

/// The decision, apart from the system calls: a verdict needs both cdhashes; an unreadable side is `Unavailable`, never `Mismatch` (#619).
pub fn decide(running: Option<&[u8]>, installed: Option<&[u8]>) -> Verdict {
    match (running, installed) {
        (Some(r), Some(i)) if !r.is_empty() && !i.is_empty() => {
            if r == i {
                Verdict::Match
            } else {
                Verdict::Mismatch
            }
        }
        _ => Verdict::Unavailable,
    }
}

/// The check on the descriptor `fd` against the app at `app`. Only `run_helper` passes the constant path (#619).
pub fn check_peer(fd: i32, app: &Path) -> Verdict {
    #[cfg(target_os = "macos")]
    {
        decide(
            security::running_peer_cdhash(fd).as_deref(),
            security::installed_cdhash(app).as_deref(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (fd, app);
        Verdict::Unavailable
    }
}

/// The calls into Security.framework: the audit token of the socket's peer, its dynamic code and its cdhash, and the cdhash of a file
/// on disk. Every failure is `None`; no status code or text leaves this module (#619).
#[cfg(target_os = "macos")]
mod security {
    use std::ffi::c_void;
    use std::path::Path;

    use core_foundation::base::{CFType, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation::url::CFURL;
    use core_foundation_sys::base::CFRelease;
    use core_foundation_sys::dictionary::CFDictionaryRef;
    use core_foundation_sys::string::CFStringRef;
    use core_foundation_sys::url::CFURLRef;

    type OsStatus = i32;
    type SecRef = *const c_void;

    /// `kSecCSSigningInformation`: asks for the cdhash among the signing information (#619).
    const SIGNING_INFORMATION: u32 = 2;
    /// `sizeof(audit_token_t)`: eight 32-bit words (#619).
    const AUDIT_TOKEN_LEN: usize = 32;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecGuestAttributeAudit: CFStringRef;
        static kSecCodeInfoUnique: CFStringRef;
        fn SecCodeCopyGuestWithAttributes(
            host: SecRef,
            attributes: CFDictionaryRef,
            flags: u32,
            guest: *mut SecRef,
        ) -> OsStatus;
        fn SecCodeCheckValidity(code: SecRef, flags: u32, requirement: SecRef) -> OsStatus;
        fn SecCodeCopySigningInformation(
            code: SecRef,
            flags: u32,
            information: *mut CFDictionaryRef,
        ) -> OsStatus;
        fn SecStaticCodeCreateWithPath(path: CFURLRef, flags: u32, code: *mut SecRef) -> OsStatus;
    }

    /// A `SecCode` or `SecStaticCode` this module owns; released when dropped.
    struct Code(SecRef);

    impl Drop for Code {
        fn drop(&mut self) {
            // SAFETY: `self.0` is a non-null Core Foundation object returned by a Security `Copy`/`Create` call, owned by this value
            // and released exactly once here.
            unsafe { CFRelease(self.0) }
        }
    }

    /// The audit token of the process that created the socket behind `fd`, or `None` if `fd` is not such a socket.
    fn peer_audit_token(fd: i32) -> Option<[u8; AUDIT_TOKEN_LEN]> {
        let mut token = [0u8; AUDIT_TOKEN_LEN];
        let mut len = libc::socklen_t::try_from(AUDIT_TOKEN_LEN).ok()?;
        // SAFETY: `token` is a writable buffer of exactly `len` bytes and both outlive the call; getsockopt writes at most `len`
        // bytes and reports the written length through `len`; a bad `fd` makes it fail with -1, never touch memory.
        let status = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_LOCAL,
                libc::LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast(),
                &mut len,
            )
        };
        (status == 0 && usize::try_from(len).ok()? == AUDIT_TOKEN_LEN).then_some(token)
    }

    /// The signed code of the process the audit token names, once its signature is valid for what it is running.
    fn running_code(token: &[u8; AUDIT_TOKEN_LEN]) -> Option<Code> {
        // SAFETY: the extern static is a constant CFString the framework exports; it is read, never written, and never released.
        let key = unsafe { CFString::wrap_under_get_rule(kSecGuestAttributeAudit) };
        let attributes = CFDictionary::from_CFType_pairs(&[(key, CFData::from_buffer(token))]);
        let mut guest: SecRef = std::ptr::null();
        // SAFETY: a null host asks the system; `attributes` is a live CFDictionary for the call; `guest` is a valid out pointer.
        let status = unsafe {
            SecCodeCopyGuestWithAttributes(
                std::ptr::null(),
                attributes.as_concrete_TypeRef(),
                0,
                &mut guest,
            )
        };
        if status != 0 || guest.is_null() {
            return None;
        }
        let code = Code(guest);
        // SAFETY: `code.0` is a live SecCode; no requirement (null) means the signature is checked for validity only.
        (unsafe { SecCodeCheckValidity(code.0, 0, std::ptr::null()) } == 0).then_some(code)
    }

    /// The cdhash (`kSecCodeInfoUnique`) of a code object.
    fn cdhash(code: &Code) -> Option<Vec<u8>> {
        let mut info: CFDictionaryRef = std::ptr::null();
        // SAFETY: `code.0` is a live SecCode or SecStaticCode (the one CF type serves both); `info` is a valid out pointer.
        let status =
            unsafe { SecCodeCopySigningInformation(code.0, SIGNING_INFORMATION, &mut info) };
        if status != 0 || info.is_null() {
            return None;
        }
        // SAFETY: the Copy call returned `info` with a +1 count, which the wrapper takes over and releases.
        let info: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_create_rule(info) };
        // SAFETY: the extern static is a constant CFString; it is read, never written, and never released.
        let key = unsafe { CFString::wrap_under_get_rule(kSecCodeInfoUnique) };
        let value = info.find(&key)?;
        Some(value.downcast::<CFData>()?.bytes().to_vec())
    }

    /// The cdhash of the process at the other end of the socket `fd`, if that process is validly signed.
    pub fn running_peer_cdhash(fd: i32) -> Option<Vec<u8>> {
        cdhash(&running_code(&peer_audit_token(fd)?)?)
    }

    /// The cdhash of the code at `path`, read on disk.
    pub fn installed_cdhash(path: &Path) -> Option<Vec<u8>> {
        let url = CFURL::from_path(path, false)?;
        let mut code: SecRef = std::ptr::null();
        // SAFETY: `url` is a live CFURL for the call; `code` is a valid out pointer.
        let status =
            unsafe { SecStaticCodeCreateWithPath(url.as_concrete_TypeRef(), 0, &mut code) };
        if status != 0 || code.is_null() {
            return None;
        }
        cdhash(&Code(code))
    }
}

/// The helper mode: the check on fd 0 against the constant path, as the process's exit code (#619).
pub fn run_helper() -> i32 {
    check_peer(0, Path::new(INSTALLED_APP)).exit_code()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn equal_cdhashes_match() {
        assert_eq!(decide(Some(&[1, 2, 3]), Some(&[1, 2, 3])), Verdict::Match);
    }

    #[test]
    fn different_cdhashes_mismatch() {
        assert_eq!(
            decide(Some(&[1, 2, 3]), Some(&[1, 2, 4])),
            Verdict::Mismatch
        );
    }

    #[test]
    fn an_unreadable_side_is_unavailable_not_mismatch() {
        assert_eq!(decide(None, Some(&[1])), Verdict::Unavailable);
        assert_eq!(decide(Some(&[1]), None), Verdict::Unavailable);
        assert_eq!(decide(None, None), Verdict::Unavailable);
    }

    #[test]
    fn empty_cdhashes_are_never_a_match() {
        assert_eq!(decide(Some(&[]), Some(&[])), Verdict::Unavailable);
    }

    #[test]
    fn exit_codes_are_the_protocol() {
        assert_eq!(Verdict::Match.exit_code(), 100);
        assert_eq!(Verdict::Mismatch.exit_code(), 101);
        assert_eq!(Verdict::Unavailable.exit_code(), 102);
    }

    #[test]
    fn only_the_exact_argv_is_the_helper_mode() {
        assert!(is_helper_invocation(&args(&[
            "app",
            "--verify-window-peer"
        ])));
        assert!(!is_helper_invocation(&args(&["app"])));
        assert!(!is_helper_invocation(&args(&[
            "app",
            "--verify-window-peer",
            "x"
        ])));
        assert!(!is_helper_invocation(&args(&[
            "app",
            "--verify-window-peer=1"
        ])));
        assert!(!is_helper_invocation(&args(&[
            "app",
            "x",
            "--verify-window-peer"
        ])));
    }

    #[test]
    fn a_non_utf8_argument_is_not_the_helper_mode_and_does_not_panic() {
        // (#619)
        use std::os::unix::ffi::OsStringExt;
        let argv = [OsString::from("app"), OsString::from_vec(vec![0xff])];
        assert!(!is_helper_invocation(&argv));
    }

    #[cfg(target_os = "macos")]
    mod macos {
        use super::*;
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;

        #[test]
        fn the_peer_that_is_the_app_at_the_path_matches() {
            // The test process created the socketpair, and its own executable stands in for the installed app (#619).
            let (a, _b) = UnixStream::pair().unwrap();
            let me = std::env::current_exe().unwrap();
            assert_eq!(check_peer(a.as_raw_fd(), &me), Verdict::Match);
        }

        #[test]
        fn a_peer_that_is_another_binary_mismatches() {
            let (a, _b) = UnixStream::pair().unwrap();
            assert_eq!(
                check_peer(a.as_raw_fd(), Path::new("/bin/ls")),
                Verdict::Mismatch
            );
        }

        #[test]
        fn an_absent_app_is_unavailable() {
            let (a, _b) = UnixStream::pair().unwrap();
            assert_eq!(
                check_peer(
                    a.as_raw_fd(),
                    Path::new("/nonexistent/Ahrena Console.app/x")
                ),
                Verdict::Unavailable
            );
        }

        #[test]
        fn a_descriptor_that_is_not_a_socket_is_unavailable() {
            let file = std::fs::File::open("/dev/null").unwrap();
            let me = std::env::current_exe().unwrap();
            assert_eq!(check_peer(file.as_raw_fd(), &me), Verdict::Unavailable);
            assert_eq!(check_peer(-1, &me), Verdict::Unavailable);
        }
    }
}
