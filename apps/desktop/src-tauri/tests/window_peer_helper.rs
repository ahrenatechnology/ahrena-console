// The helper mode of the app's executable, run as the core runs it (#619, layer 2): the channel on its stdin, the answer in its exit
// code, nothing on stdout or stderr. The test process created the socketpair, and it is not the installed app, so the answer is never
// `match`: `mismatch` where the installed app is present, `unavailable` where it is not.

#![cfg(target_os = "macos")]

use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};

fn run(args: &[&str]) -> std::process::Output {
    let (ours, theirs) = UnixStream::pair().expect("socketpair");
    let output = Command::new(env!("CARGO_BIN_EXE_ahrena-console-desktop"))
        .args(args)
        .stdin(Stdio::from(OwnedFd::from(theirs)))
        .output()
        .expect("spawn the helper");
    drop(ours);
    output
}

#[test]
fn a_peer_that_is_not_the_installed_app_never_matches_and_the_helper_stays_silent() {
    let output = run(&["--verify-window-peer"]);
    let code = output.status.code();
    assert!(matches!(code, Some(101) | Some(102)), "unexpected exit {code:?}");
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
