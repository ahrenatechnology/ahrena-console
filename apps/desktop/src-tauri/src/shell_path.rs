// An app opened from the Finder, the Dock or at login inherits a minimal PATH from launchd
// (/usr/bin:/bin:/usr/sbin:/sbin) and finds neither `claude` (in ~/.local/bin) nor `node`
// (in /opt/homebrew/bin or in a version manager). Like CCAM's app (desktop/src/shell-path.ts),
// it runs the login shell once and merges its PATH.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARKER: &str = "__AHRENA_PATH__";

pub fn fix_path() {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    let mut merge = |value: &str| {
        for p in value.split(':') {
            if !p.is_empty() && !parts.iter().any(|x| x == p) {
                parts.push(p.to_string());
            }
        }
    };
    if let Some(p) = shell_path() {
        merge(&p);
    }
    merge(&format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin"));
    merge(&std::env::var("PATH").unwrap_or_default());
    std::env::set_var("PATH", parts.join(":"));
}

fn shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = Command::new(shell);
    command.args(["-ilc", &path_command()]);
    run_for_path(command)
}

// `${PATH}` with braces: right before the marker, a bare `$PATH` reads as the variable
// `PATH__AHRENA_PATH__`, which is empty, and the login PATH never came through (#280).
fn path_command() -> String {
    format!("printf '%s' \"{MARKER}${{PATH}}{MARKER}\"")
}

fn run_for_path(mut command: Command) -> Option<String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // A slow .zshrc must not hold up the app's opening.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut output = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut output).ok()?;
    let start = output.find(MARKER)? + MARKER.len();
    let end = start + output[start..].find(MARKER)?;
    Some(output[start..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_shell_prints_the_path_between_the_markers() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", &path_command()]).env_clear().env("PATH", "/x/bin:/y/bin");
        assert_eq!(run_for_path(command).as_deref(), Some("/x/bin:/y/bin"));
    }
}
