// The app's own core (decision 0010, issue #221): one core per installation, on a random port.
//
// With a Node 24 on the login PATH, the app runs the core bundled inside it:
//
//   node <core>/src/owner/cli.ts start --installation app --data-dir <app data dir> --port 0 \
//        --parent <app pid> --json
//
// The owner (packages/nucleo/src/owner) adopts a live core only within the same data folder, so the
// app either adopts its own installation's core or starts one; it never adopts the development core,
// the extension's or any other installation's, whatever port they are on. Without Node, the app does
// not look for a core anywhere: it shows the A4 (stopped) menu.
//
// After an update, the previous version's core may still be up (issue #220: the MCP bridges registered
// as its clients keep it alive after its app is gone). The owner replaces a core of an older version
// on its own; the app checks the `version` of the start line against the core it bundles
// (`packages/nucleo/package.json`) and refuses an older one, so the window never shows the old /ui.
// The swap is silent; only a failure reaches the tray, as the stopped state's reason.
//
// On exit, the app signals nobody: the core it started has the app as `--parent`, exits within a
// second of the app being gone, and deletes its own entry in the instance registry
// (~/.ahrena-console/instances/) as it goes.

use std::ffi::OsString;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Deserialize;

use crate::http;
use crate::menu::CoreState;
use crate::window_channel::{self, Grant};

pub const NO_NODE: &str = "Node não encontrado no PATH do login";

/// The installation the app's core belongs to (`--installation`, and `installation` in the output).
pub const INSTALLATION: &str = "app";

/// The owner's command, relative to the core folder.
pub const OWNER_CLI: &str = "src/owner/cli.ts";

/// Environment variables the app's core must not inherit: each would point it at another
/// installation's database, folder or port (a shell that exports them for the development core).
const FOREIGN_ENV: [&str; 4] = ["AHRENA_CONSOLE_DB", "AHRENA_CONSOLE_DATA_DIR", "AHRENA_CONSOLE_CORE_PORT", "AHRENA_CONSOLE_PORT"];

/// What to do, decided before running anything.
#[derive(Debug, PartialEq)]
pub enum Plan {
    /// Run the owner's `start` with this `node`: it adopts the app's own core or starts one.
    Start { node: PathBuf },
    /// Debug override (`AHRENA_CONSOLE_DEMO_PORT`): show the core on this port, start none.
    Watch { port: u16 },
    Stopped { reason: String, no_node: bool },
}

/// `demo_port`: the debug override, if set. `node`: the Node 24+ found on the PATH (or `Err` with
/// the old version found). `bundled`: the bundled core's owner command exists.
pub fn choose(demo_port: Option<u16>, node: Result<PathBuf, Option<String>>, bundled: bool) -> Plan {
    if let Some(port) = demo_port {
        return Plan::Watch { port };
    }
    match node {
        Ok(node) if bundled => Plan::Start { node },
        Ok(_) => Plan::Stopped { reason: "O núcleo não está dentro do app".into(), no_node: false },
        Err(None) => Plan::Stopped { reason: NO_NODE.into(), no_node: true },
        Err(Some(v)) => Plan::Stopped { reason: format!("O núcleo pede o Node 24; o PATH do login tem o {v}"), no_node: true },
    }
}

/// The core the app talks to: its port and, for the core it started or adopted, its pid. Every
/// check that it still answers also checks the pid, so a port reused by another core is not taken
/// for this one.
#[derive(Debug, Clone, PartialEq)]
pub struct Core {
    pub port: u16,
    pub pid: Option<u32>,
}

impl Core {
    pub fn answers(&self) -> bool {
        http::get(self.port, "/api/overview", Duration::from_secs(3))
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .is_some_and(|v| is_the_core(&v, self.pid))
    }
}

/// The result of starting: the tray's state, the core when it is up, and whether this app started it.
#[derive(Debug, PartialEq)]
pub struct Outcome {
    pub state: CoreState,
    pub core: Option<Core>,
    pub started: bool,
}

impl Outcome {
    fn stopped(reason: impl Into<String>) -> Self {
        Outcome { state: CoreState::Stopped { reason: reason.into(), no_node: false }, core: None, started: false }
    }

    fn up(core: Core, started: bool) -> Self {
        Outcome { state: CoreState::Up { port: core.port }, core: Some(core), started }
    }
}

/// The `--json` line of the owner's `start` (src/owner/start.ts, `StartOutput`), as the app reads
/// it: `state` (`up`/`stopped`), `port`, `pid`, `started`, `reason`, `installation` and `dataDir`.
/// The Portuguese keys of the cores from before #173 (`estado`, `porta`, `subiu`, `motivo`) are not
/// read since phase 6: the app always runs the core it bundles.
#[derive(Debug, PartialEq, Deserialize)]
struct StartLine {
    #[serde(default, deserialize_with = "start_state")]
    state: StartState,
    port: Option<u16>,
    pid: Option<u32>,
    started: Option<bool>,
    reason: Option<String>,
    installation: Option<String>,
    #[serde(rename = "dataDir")]
    data_dir: Option<String>,
    version: Option<String>,
}

/// The `state` of the line.
#[derive(Debug, PartialEq, Default)]
enum StartState {
    Up,
    Stopped,
    /// Any other value, or none: not up.
    #[default]
    Unknown,
}

fn start_state<'de, D: serde::Deserializer<'de>>(d: D) -> Result<StartState, D::Error> {
    Ok(match Option::<String>::deserialize(d)?.as_deref() {
        Some("up") => StartState::Up,
        Some("stopped") => StartState::Stopped,
        _ => StartState::Unknown,
    })
}

/// -1, 0 or 1, comparing `a.b.c` by number; whatever comes after `-` or `+` does not count (as
/// `compareVersions` in packages/nucleo/src/owner/probe.ts).
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |v: &str| -> Vec<u64> { v.split(['-', '+']).next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (x, y) = (parts(a), parts(b));
    (0..x.len().max(y.len())).map(|i| x.get(i).unwrap_or(&0).cmp(y.get(i).unwrap_or(&0))).find(|o| o.is_ne()).unwrap_or(std::cmp::Ordering::Equal)
}

/// The version of the bundled core (`version` of `<core>/package.json`), if readable.
pub fn bundled_version(core: &Path) -> Option<String> {
    let text = std::fs::read_to_string(core.join("package.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?.get("version")?.as_str().map(str::to_string)
}

/// Reads the last JSON line of `start --json`. A core that is up but says it belongs to another
/// installation, or to another data folder than `data_dir`, is refused: the app only uses its own.
/// With `bundled` (the version of the core inside the app), a core of an older version is refused
/// too (issue #220): the owner should have replaced it, and the window must not show its /ui.
pub fn read_start(output: &str, data_dir: Option<&Path>, bundled: Option<&str>) -> Outcome {
    let line = output.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let Ok(s) = serde_json::from_str::<StartLine>(line) else {
        return Outcome::stopped("O núcleo não respondeu ao subir");
    };
    let port = match (&s.state, s.port) {
        (StartState::Up, Some(port)) if port != 0 => port,
        _ => return Outcome::stopped(s.reason.map(|m| format!("O núcleo não subiu: {m}")).unwrap_or_else(|| "O núcleo não subiu".into())),
    };
    if s.installation.as_deref() != Some(INSTALLATION) {
        let other = s.installation.as_deref().unwrap_or("sem instalação");
        return Outcome::stopped(format!("O núcleo que respondeu não é o do app ({other})"));
    }
    // Fails closed: knowing its folder, the app refuses a line that does not name the same one.
    if let Some(expected) = data_dir {
        match s.data_dir.as_deref() {
            Some(got) if Path::new(got) == expected => {}
            got => return Outcome::stopped(format!("O núcleo que respondeu usa outra pasta de dados ({})", got.unwrap_or("sem pasta"))),
        }
    }
    if let (Some(bundled), Some(running)) = (bundled, s.version.as_deref()) {
        if compare_versions(running, bundled).is_lt() {
            return Outcome::stopped(format!("O núcleo de pé é a versão {running}, mais velha que a do app ({bundled}), e não deu lugar ao novo"));
        }
    }
    Outcome::up(Core { port, pid: s.pid }, s.started.unwrap_or(false))
}

/// The arguments after `node`: the owner's `start` for the app's installation, on a random port.
/// Without `data_dir`, the owner uses the app installation's default folder (the same one).
pub fn start_args(cli: &Path, data_dir: Option<&Path>, parent: u32) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--disable-warning=ExperimentalWarning".into(), cli.into(), "start".into(), "--installation".into(), INSTALLATION.into()];
    if let Some(dir) = data_dir {
        args.extend(["--data-dir".into(), dir.into()]);
    }
    args.extend(["--port".into(), "0".into(), "--parent".into(), parent.to_string().into(), "--json".into()]);
    args
}

/// `v24.1.0` works; `v22.12.0` does not (the core needs `node:sqlite` and TypeScript without a flag).
pub fn node_version_works(v: &str) -> bool {
    v.trim().trim_start_matches('v').split('.').next().and_then(|m| m.parse::<u32>().ok()).is_some_and(|m| m >= 24)
}

/// An environment variable, if set (decision 0009: `AHRENA_CONSOLE_*`; the old names left in phase 6).
pub fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The first `node` on the PATH (already fixed from the login shell), if it is Node 24+.
/// `AHRENA_CONSOLE_NODE` sets the path; empty, pretends there is no Node
/// (to see the A4).
pub fn find_node() -> Result<PathBuf, Option<String>> {
    let node = match env_var("AHRENA_CONSOLE_NODE") {
        Some(p) if p.is_empty() => return Err(None),
        Some(p) => PathBuf::from(p),
        None => {
            let path = std::env::var("PATH").unwrap_or_default();
            path.split(':').map(|d| Path::new(d).join("node")).find(|p| p.is_file()).ok_or(None)?
        }
    };
    let out = Command::new(&node).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|_| None)?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if node_version_works(&version) {
        Ok(node)
    } else {
        Err(Some(version))
    }
}

/// `/api/overview` answers as the Ahrena Console core: `name` is `ahrena-console`; with `pid`, the
/// overview's `pid` must be that one.
fn is_the_core(v: &serde_json::Value, pid: Option<u32>) -> bool {
    let name = v.get("name").and_then(|n| n.as_str());
    let same_pid = match pid {
        Some(pid) => v.get("pid").and_then(|p| p.as_u64()) == Some(u64::from(pid)),
        None => true,
    };
    name == Some("ahrena-console") && same_pid
}

/// Where the core is: `AHRENA_CONSOLE_CORE_DIR`, else the app's
/// resources (`packages/nucleo`), else the checkout (in development, `cargo run`).
pub fn core_dir(resources: Option<PathBuf>) -> PathBuf {
    if let Some(p) = env_var("AHRENA_CONSOLE_CORE_DIR") {
        return PathBuf::from(p);
    }
    if let Some(r) = resources.map(|r| r.join("packages/nucleo")).filter(|p| p.join(OWNER_CLI).is_file()) {
        return r;
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/nucleo"))
}

/// Debug override for the tray screenshots: `AHRENA_CONSOLE_DEMO_PORT`, the port of a simulator
/// `--demo`. Set, the app starts no core and only
/// shows that one. Never set by the app itself.
pub fn demo_port() -> Option<u16> {
    env_var("AHRENA_CONSOLE_DEMO_PORT").and_then(|p| p.parse().ok()).filter(|p| *p != 0)
}

/// The options that hand the owner's `start` the window credential channel (decision 0025, #619).
pub fn window_channel_args() -> [String; 2] {
    [window_channel::CHANNEL_OPTION.to_string(), window_channel::CHANNEL_FD.to_string()]
}

/// Whether a credential is issued for this result of the start: only for a core this app STARTED and that is up (#619).
fn is_issued_for(outcome: &Outcome) -> bool {
    outcome.started && outcome.core.is_some() && matches!(outcome.state, CoreState::Up { .. })
}

/// The credential for this result of the start, written on the app's end of the channel, which the grant then keeps open. For a core
/// the app did not start, or without a channel, or when the write fails, none exists and the end is closed (dropped) (#619).
pub fn issue_for(outcome: &Outcome, channel: Option<UnixStream>) -> Option<Grant> {
    let channel = channel?;
    if !is_issued_for(outcome) {
        return None;
    }
    window_channel::issue(channel).ok()
}

/// Runs the owner's `start`, with the channel's far end as its fd 3 when there is one. The command owns the far end, and is dropped
/// right after the spawn, which closes the app's copy at once (#619).
fn run_start(mut command: Command, far_end: Option<window_channel::ChildEnd>) -> std::io::Result<std::process::Output> {
    command.stdout(Stdio::piped());
    if let Some(end) = far_end {
        end.pass_as_fd3(&mut command);
        command.args(window_channel_args());
    }
    let child = command.spawn();
    drop(command);
    child?.wait_with_output()
}

/// The arguments after `node`: the owner's `stop` for the app's installation and folder (src/owner/cli.ts `stop`) (#619).
pub fn stop_args(cli: &Path, data_dir: Option<&Path>) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--disable-warning=ExperimentalWarning".into(), cli.into(), "stop".into(), "--installation".into(), INSTALLATION.into()];
    if let Some(dir) = data_dir {
        args.extend(["--data-dir".into(), dir.into()]);
    }
    args.push("--json".into());
    args
}

/// Whether the last JSON line of `stop --json` says the core is gone: `state` `stopped` (the owner prints `up` and exits 1 when the
/// core did not leave) (#619).
pub fn read_stop(output: &str) -> bool {
    let line = output.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    serde_json::from_str::<StartLine>(line).is_ok_and(|s| s.state == StartState::Stopped)
}

/// What to do with the window credential after a start reported `outcome` (#619).
#[derive(Debug, PartialEq)]
pub enum GrantDecision {
    /// The turn ended against the same core (same pid and port) the app already holds a grant for: keep the grant and publish it again.
    Keep,
    /// The app started this core and issued a credential: the new grant replaces any previous one.
    Replace,
    /// The core was not started by the app in this run and the run's restart is unspent: stop it and start it again with a fresh channel.
    Restart,
    /// Hold no grant: no core answers, the core has no pid to tell it by, or the run's restart is already spent.
    None,
}

/// A loop turn of `follow` is not one core lifetime: `watch_core` also returns on a hiccup while the same core is up, so the grant is
/// kept across turns while the next start reports the same core (`previous`, by pid and port), and dropped when it is another core or
/// none answers. Decision 0025 restarts only a core the app did not start in this run: that happens at most once per run
/// (`restart_spent`, set by the first core the app starts or the first restart it attempts), never in a loop (#619).
pub fn decide_grant(previous: Option<&Core>, outcome: &Outcome, issued: bool, restart_spent: bool) -> GrantDecision {
    let Some(core) = &outcome.core else { return GrantDecision::None };
    if issued {
        return GrantDecision::Replace;
    }
    if outcome.started {
        return GrantDecision::None;
    }
    if previous == Some(core) {
        return GrantDecision::Keep;
    }
    if !restart_spent && core.pid.is_some() {
        return GrantDecision::Restart;
    }
    GrantDecision::None
}

/// The core the app holds a window credential for, with its grant, and whether the run's one restart is spent (#619).
#[derive(Default)]
pub struct Holding {
    held: Option<(Core, Grant)>,
    restart_spent: bool,
}

impl Holding {
    /// The credential in force for the core of the last `start`, if any.
    pub fn grant(&self) -> Option<&Grant> {
        self.held.as_ref().map(|(_, grant)| grant)
    }

    /// Spends the run's restart when the app started a core (whatever the grant) or is about to restart one (#619).
    fn note(&mut self, outcome: &Outcome, decision: &GrantDecision) {
        if outcome.started || *decision == GrantDecision::Restart {
            self.restart_spent = true;
        }
    }

    /// Starts (or adopts) the app's core and settles the grant: kept for the same core, replaced for a core this call started, none
    /// otherwise. Adopting a core the app did not start in this run restarts it once per run, because an adopted core cannot receive
    /// a credential (decision 0025): restarting closes open requests as `core_restarted` and rotates the owner token, as 0025
    /// accepts. A core the app started without getting a grant is never restarted later (#619).
    pub fn start(&mut self, core: &Path, data_dir: Option<&Path>) -> Outcome {
        let (mut outcome, mut grant) = start_own_core(core, data_dir);
        let mut decision = decide_grant(self.held.as_ref().map(|(c, _)| c), &outcome, grant.is_some(), self.restart_spent);
        self.note(&outcome, &decision);
        if decision == GrantDecision::Restart {
            // Spent whatever the result: a failed stop or a second adoption gives up, it never loops.
            if stop_own_core(core, data_dir) {
                (outcome, grant) = start_own_core(core, data_dir);
                decision = decide_grant(None, &outcome, grant.is_some(), true);
            } else {
                decision = GrantDecision::None;
            }
        }
        match (decision, outcome.core.clone(), grant) {
            (GrantDecision::Keep, ..) => {}
            (GrantDecision::Replace, Some(core), Some(grant)) => self.held = Some((core, grant)),
            _ => {
                self.held = None;
                window_channel::clear();
            }
        }
        outcome
    }
}

/// Stops the app's core through the owner's `stop`; true when it is gone (#619).
fn stop_own_core(core: &Path, data_dir: Option<&Path>) -> bool {
    let cli = core.join(OWNER_CLI);
    let Ok(node) = find_node() else { return false };
    let mut command = Command::new(node);
    command.args(stop_args(&cli, data_dir)).current_dir(core).stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped());
    for name in FOREIGN_ENV {
        command.env_remove(name);
    }
    command.output().is_ok_and(|out| read_stop(&String::from_utf8_lossy(&out.stdout)))
}

/// Starts (or, within its own installation, adopts) the app's core. `data_dir`: the app's data
/// folder, from Tauri (`~/Library/Application Support/dev.ahrena.console`). The `Grant` is the
/// window credential, only for a core this call started: the caller keeps it for as long as that
/// core is the app's, and dropping it revokes the credential (#619).
pub fn start_own_core(core: &Path, data_dir: Option<&Path>) -> (Outcome, Option<Grant>) {
    let cli = core.join(OWNER_CLI);
    match choose(demo_port(), find_node(), cli.is_file()) {
        Plan::Watch { port } => {
            let demo = Core { port, pid: None };
            let outcome = if demo.answers() {
                Outcome::up(demo, false)
            } else {
                Outcome::stopped(format!("Nada responde como núcleo na porta {port} (AHRENA_CONSOLE_DEMO_PORT)"))
            };
            (outcome, None)
        }
        Plan::Stopped { reason, no_node } => (Outcome { state: CoreState::Stopped { reason, no_node }, core: None, started: false }, None),
        Plan::Start { node } => {
            let mut command = Command::new(node);
            command.args(start_args(&cli, data_dir, std::process::id())).current_dir(core).stdin(Stdio::null()).stderr(Stdio::null());
            for name in FOREIGN_ENV {
                command.env_remove(name);
            }
            // Without a channel the core still starts, and the capability stays unavailable.
            let (app_end, far_end) = match window_channel::open() {
                Ok((app, far)) => (Some(app), Some(far)),
                Err(_) => (None, None),
            };
            match run_start(command, far_end) {
                Ok(out) => {
                    let outcome = read_start(&String::from_utf8_lossy(&out.stdout), data_dir, bundled_version(core).as_deref());
                    let grant = issue_for(&outcome, app_end);
                    (outcome, grant)
                }
                Err(e) => (Outcome::stopped(format!("node: {e}")), None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> Result<PathBuf, Option<String>> {
        Ok(PathBuf::from("/opt/homebrew/bin/node"))
    }

    const DIR: &str = "/Users/x/Library/Application Support/dev.ahrena.console";

    #[test]
    fn with_node_starts_the_own_core() {
        assert_eq!(choose(None, node(), true), Plan::Start { node: PathBuf::from("/opt/homebrew/bin/node") });
    }

    #[test]
    fn without_node_it_is_the_a4_and_never_looks_for_another_core() {
        assert_eq!(choose(None, Err(None), true), Plan::Stopped { reason: NO_NODE.into(), no_node: true });
        let Plan::Stopped { reason, no_node } = choose(None, Err(Some("v22.12.0".into())), true) else { panic!() };
        assert!(no_node);
        assert!(reason.contains("v22.12.0"), "{reason}");
    }

    #[test]
    fn without_the_bundled_core_it_is_stopped() {
        assert!(matches!(choose(None, node(), false), Plan::Stopped { no_node: false, .. }));
    }

    #[test]
    fn the_demo_override_only_watches() {
        assert_eq!(choose(Some(4797), node(), true), Plan::Watch { port: 4797 });
        assert_eq!(choose(Some(4797), Err(None), false), Plan::Watch { port: 4797 });
    }

    #[test]
    fn start_runs_the_owner_for_the_app_on_a_random_port() {
        let args = start_args(Path::new("/r/packages/nucleo/src/owner/cli.ts"), Some(Path::new(DIR)), 777);
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(
            args,
            ["--disable-warning=ExperimentalWarning", "/r/packages/nucleo/src/owner/cli.ts", "start", "--installation", "app", "--data-dir", DIR, "--port", "0", "--parent", "777", "--json"]
        );
        let without_dir = start_args(Path::new("cli.ts"), None, 1);
        assert!(!without_dir.iter().any(|a| a == "--data-dir"));
        assert!(without_dir.windows(2).any(|w| w[0] == "--installation" && w[1] == "app"));
    }

    #[test]
    fn reads_the_start_line_of_the_own_core() {
        let started = format!(r#"{{"state":"up","url":"http://127.0.0.1:53817","port":53817,"pid":4242,"version":"0.0.1","startedAt":"x","parent":777,"started":true,"commit":null,"installation":"app","dataDir":"{DIR}"}}"#);
        assert_eq!(read_start(&started, Some(Path::new(DIR)), None), Outcome::up(Core { port: 53817, pid: Some(4242) }, true));
        let adopted = format!(r#"{{"state":"up","port":53900,"pid":5151,"started":false,"warning":"versão mais velha","installation":"app","dataDir":"{DIR}/"}}"#);
        assert_eq!(read_start(&format!("[log] something\n{adopted}\n"), Some(Path::new(DIR)), None), Outcome::up(Core { port: 53900, pid: Some(5151) }, false));
        let no_dir_given = r#"{"state":"up","port":53817,"pid":1,"started":true,"installation":"app","dataDir":"/elsewhere"}"#;
        assert!(read_start(no_dir_given, None, None).core.is_some());
    }

    #[test]
    fn refuses_a_core_of_another_installation_or_folder() {
        let dev = r#"{"state":"up","port":4720,"pid":1,"started":false,"installation":"dev","dataDir":"/Users/x/.ahrena-console"}"#;
        let r = read_start(dev, Some(Path::new(DIR)), None);
        assert_eq!(r.core, None);
        assert!(matches!(r.state, CoreState::Stopped { ref reason, no_node: false } if reason.contains("dev")));
        let old = r#"{"state":"up","port":4720,"pid":1,"started":false}"#;
        assert_eq!(read_start(old, Some(Path::new(DIR)), None).core, None, "a core from before #221 does not say it is the app's");
        let folder = r#"{"state":"up","port":53817,"pid":1,"started":true,"installation":"app","dataDir":"/tmp/other"}"#;
        assert_eq!(read_start(folder, Some(Path::new(DIR)), None).core, None);
        let no_folder = r#"{"state":"up","port":53817,"pid":1,"started":true,"installation":"app"}"#;
        assert_eq!(read_start(no_folder, Some(Path::new(DIR)), None).core, None, "fails closed without dataDir");
    }

    #[test]
    fn reads_a_failed_start() {
        let stopped = r#"{"state":"stopped","reason":"o núcleo saiu com código 1","installation":"app"}"#;
        let r = read_start(stopped, Some(Path::new(DIR)), None);
        assert!(!r.started);
        assert!(matches!(r.state, CoreState::Stopped { ref reason, no_node: false } if reason.contains("código 1")));
        assert!(matches!(read_start("", None, None).state, CoreState::Stopped { .. }));
        assert_eq!(read_start(r#"{"state":"up","port":0,"installation":"app"}"#, None, None).core, None);
        assert_eq!(read_start(r#"{"state":"starting","port":53817,"installation":"app"}"#, None, None).core, None);
    }

    #[test]
    fn the_portuguese_start_line_of_an_old_core_is_not_read() {
        // #173 phase 6: `estado`/`porta`/`subiu` are not read; the app runs the core it bundles.
        let old = format!(r#"{{"estado":"de-pe","porta":53817,"pid":1,"subiu":true,"installation":"app","dataDir":"{DIR}"}}"#);
        let r = read_start(&old, Some(Path::new(DIR)), None);
        assert_eq!(r.core, None);
        assert!(matches!(r.state, CoreState::Stopped { .. }));
        let line = |t: &str| serde_json::from_str::<StartLine>(t).unwrap();
        assert_eq!(line(r#"{"state":"up"}"#).state, StartState::Up);
        assert_eq!(line(r#"{"state":"stopped"}"#).state, StartState::Stopped);
        assert_eq!(line(r#"{"estado":"de-pe"}"#).state, StartState::Unknown);
        assert_eq!(line("{}").state, StartState::Unknown);
        assert_eq!(line(r#"{"motivo":"old"}"#).reason, None);
    }

    #[test]
    fn overview_by_name_and_pid() {
        let v = |t: &str| serde_json::from_str::<serde_json::Value>(t).unwrap();
        assert!(is_the_core(&v(r#"{"ok":true,"name":"ahrena-console","version":"0.2.0","pid":42}"#), Some(42)));
        assert!(!is_the_core(&v(r#"{"ok":true,"name":"ahrena-console","pid":43}"#), Some(42)), "another core reused the port");
        assert!(!is_the_core(&v(r#"{"ok":true,"name":"ahrena-console"}"#), Some(42)));
        assert!(is_the_core(&v(r#"{"ok":true,"name":"ahrena-console"}"#), None));
        assert!(!is_the_core(&v(r#"{"ok":true,"nome":"ahrena-console","versao":"0.1.0"}"#), None), "a core from before #173 phase 2b is not read since phase 6");
        assert!(!is_the_core(&v(r#"{"name":"outro"}"#), None));
        assert!(!is_the_core(&v(r#"{"ok":true}"#), None));
    }

    #[test]
    fn versions_compare_by_number() {
        use std::cmp::Ordering::*;
        assert_eq!(compare_versions("0.0.1", "0.0.6"), Less);
        assert_eq!(compare_versions("0.0.10", "0.0.9"), Greater);
        assert_eq!(compare_versions("0.1", "0.1.0"), Equal);
        assert_eq!(compare_versions("1.0.0-beta", "1.0.0"), Equal);
        assert_eq!(compare_versions("garbage", "0.0.1"), Less);
    }

    #[test]
    fn an_older_core_than_the_bundled_one_is_refused() {
        // Issue #220: the app 0.0.6 adopted the 0.0.1 core of its previous version.
        let adopted_old = format!(r#"{{"state":"up","port":53900,"pid":5151,"version":"0.0.1","started":false,"installation":"app","dataDir":"{DIR}"}}"#);
        let r = read_start(&adopted_old, Some(Path::new(DIR)), Some("0.0.6"));
        assert_eq!(r.core, None);
        assert!(matches!(r.state, CoreState::Stopped { ref reason, no_node: false } if reason.contains("0.0.1") && reason.contains("0.0.6")), "{:?}", r.state);
        // The same line without knowing the bundled version: adopted, as before.
        assert!(read_start(&adopted_old, Some(Path::new(DIR)), None).core.is_some());
        // Same or newer (a development core): adopted.
        for v in ["0.0.6", "0.0.7", "0.1.0"] {
            let line = format!(r#"{{"state":"up","port":53900,"pid":5151,"version":"{v}","started":false,"installation":"app","dataDir":"{DIR}"}}"#);
            assert_eq!(read_start(&line, Some(Path::new(DIR)), Some("0.0.6")), Outcome::up(Core { port: 53900, pid: Some(5151) }, false), "{v}");
        }
        // The owner could not stop the old one: its reason reaches the tray.
        let failed = r#"{"state":"stopped","reason":"o núcleo antigo (versão 0.0.1, pid 5151) não saiu para dar lugar a este","installation":"app"}"#;
        let r = read_start(failed, Some(Path::new(DIR)), Some("0.0.6"));
        assert!(matches!(r.state, CoreState::Stopped { ref reason, .. } if reason.contains("não saiu")));
    }

    #[test]
    fn reads_the_bundled_version() {
        let core = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/nucleo"));
        assert_eq!(bundled_version(core).as_deref(), Some(env!("CARGO_PKG_VERSION")), "the core follows the app (#261)");
        assert_eq!(bundled_version(Path::new("/nonexistent")), None);
    }

    #[test]
    fn only_a_core_the_app_started_and_that_is_up_gets_a_credential() {
        let up = |started| Outcome::up(Core { port: 4720, pid: Some(9) }, started);
        assert!(is_issued_for(&up(true)));
        assert!(!is_issued_for(&up(false)), "an adopted core");
        let stopped = Outcome { state: CoreState::Stopped { reason: "x".into(), no_node: false }, core: None, started: true };
        assert!(!is_issued_for(&stopped));
    }

    #[test]
    fn the_owner_is_told_the_channel_is_fd_3() {
        assert_eq!(window_channel_args(), ["--window-channel", "3"]);
    }

    #[test]
    fn a_started_core_gets_a_credential_on_the_app_end() {
        use std::io::Read;
        let (app, child) = crate::window_channel::open().unwrap();
        let up = Outcome::up(Core { port: 4720, pid: Some(9) }, true);
        let grant = issue_for(&up, Some(app)).expect("a started core gets one");
        let mut line = vec![0u8; 65];
        child.into_stream().read_exact(&mut line).unwrap();
        assert_eq!(String::from_utf8(line).unwrap(), format!("{}\n", grant.credential().reveal()));
    }

    #[test]
    fn an_adopted_core_gets_none_and_the_app_end_is_closed() {
        use std::io::Read;
        for outcome in [Outcome::up(Core { port: 4720, pid: Some(9) }, false), Outcome::stopped("x")] {
            let (app, child) = crate::window_channel::open().unwrap();
            assert!(issue_for(&outcome, Some(app)).is_none());
            let mut rest = Vec::new();
            child.into_stream().read_to_end(&mut rest).unwrap();
            assert!(rest.is_empty(), "nothing was written and the end is closed (EOF)");
        }
        assert!(issue_for(&Outcome::up(Core { port: 1, pid: None }, true), None).is_none(), "no channel, no credential");
    }

    fn adopted(port: u16, pid: u32) -> Outcome {
        Outcome::up(Core { port, pid: Some(pid) }, false)
    }

    #[test]
    fn a_core_the_app_started_replaces_the_grant() {
        let started = Outcome::up(Core { port: 4721, pid: Some(10) }, true);
        assert_eq!(decide_grant(None, &started, true, true), GrantDecision::Replace);
        let previous = Core { port: 4720, pid: Some(9) };
        assert_eq!(decide_grant(Some(&previous), &started, true, true), GrantDecision::Replace);
    }

    #[test]
    fn a_turn_that_ends_against_the_same_core_keeps_its_grant() {
        let previous = Core { port: 4720, pid: Some(9) };
        assert_eq!(decide_grant(Some(&previous), &adopted(4720, 9), false, true), GrantDecision::Keep);
        assert_eq!(decide_grant(Some(&previous), &adopted(4720, 9), false, false), GrantDecision::Keep);
    }

    #[test]
    fn a_different_core_than_the_held_one_never_restarts_once_the_app_started_a_core() {
        let previous = Core { port: 4720, pid: Some(9) };
        assert_eq!(decide_grant(Some(&previous), &adopted(4720, 10), false, true), GrantDecision::None, "another pid on the port");
        assert_eq!(decide_grant(Some(&previous), &adopted(4799, 9), false, true), GrantDecision::None, "the pid on another port");
    }

    #[test]
    fn the_first_adoption_of_the_run_is_restarted_and_a_later_one_is_not() {
        assert_eq!(decide_grant(None, &adopted(4720, 9), false, false), GrantDecision::Restart, "the first adoption at open");
        assert_eq!(decide_grant(None, &adopted(4720, 11), false, true), GrantDecision::None, "another pid later in the run");
        assert_eq!(decide_grant(None, &adopted(4720, 9), false, true), GrantDecision::None, "the same pid after the restart was spent");
    }

    #[test]
    fn a_started_core_without_a_credential_is_not_restarted_when_the_next_turn_adopts_it() {
        let started = Outcome::up(Core { port: 4721, pid: Some(10) }, true);
        assert_eq!(decide_grant(None, &started, false, false), GrantDecision::None, "the credential could not be written");
        // Holding::start records the start as the run's restart: the next turn adopts the same pid with nothing held.
        let mut holding = Holding::default();
        holding.note(&started, &GrantDecision::None);
        assert_eq!(decide_grant(None, &adopted(4721, 10), false, holding.restart_spent), GrantDecision::None);
    }

    #[test]
    fn a_restart_attempt_spends_the_runs_restart() {
        let mut holding = Holding::default();
        holding.note(&adopted(4720, 9), &GrantDecision::Restart);
        assert!(holding.restart_spent);
    }

    #[test]
    fn nothing_is_restarted_without_a_pid_or_a_core() {
        let demo = Outcome::up(Core { port: 4797, pid: None }, false);
        assert_eq!(decide_grant(None, &demo, false, false), GrantDecision::None);
        assert_eq!(decide_grant(None, &Outcome::stopped("x"), false, false), GrantDecision::None);
        let previous = Core { port: 4720, pid: Some(9) };
        assert_eq!(decide_grant(Some(&previous), &Outcome::stopped("x"), false, true), GrantDecision::None, "no core answers: the grant is dropped");
    }

    #[test]
    fn stop_runs_the_owner_for_the_app_installation_and_folder() {
        let args = stop_args(Path::new("/r/packages/nucleo/src/owner/cli.ts"), Some(Path::new(DIR)));
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(args, ["--disable-warning=ExperimentalWarning", "/r/packages/nucleo/src/owner/cli.ts", "stop", "--installation", "app", "--data-dir", DIR, "--json"]);
        let without_dir = stop_args(Path::new("cli.ts"), None);
        assert!(!without_dir.iter().any(|a| a == "--data-dir"));
        assert!(!without_dir.iter().any(|a| a == "--window-channel" || a == "--port" || a == "--parent"));
    }

    #[test]
    fn the_stop_line_says_whether_the_core_is_gone() {
        assert!(read_stop(r#"{"state":"stopped","pid":5151}"#));
        assert!(read_stop("[log]\n{\"state\":\"stopped\"}\n"), "no core up is as good as stopped");
        assert!(!read_stop(r#"{"state":"up","pid":5151,"reason":"não saiu"}"#));
        assert!(!read_stop(""));
        assert!(!read_stop("not json"));
    }

    #[test]
    fn node_version() {
        assert!(node_version_works("v24.0.0"));
        assert!(node_version_works("v26.8.1\n"));
        assert!(!node_version_works("v22.18.0"));
        assert!(!node_version_works("garbage"));
    }
}
