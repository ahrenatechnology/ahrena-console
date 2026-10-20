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
// On exit, the app signals nobody: the core it started has the app as `--parent`, exits within a
// second of the app being gone, and deletes its own entry in the instance registry
// (~/.ahrena-console/instances/) as it goes.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Deserialize;

use crate::http;
use crate::menu::EstadoDoNucleo;

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
    pub state: EstadoDoNucleo,
    pub core: Option<Core>,
    pub started: bool,
}

impl Outcome {
    fn stopped(reason: impl Into<String>) -> Self {
        Outcome { state: EstadoDoNucleo::Parado { motivo: reason.into(), sem_node: false }, core: None, started: false }
    }

    fn up(core: Core, started: bool) -> Self {
        Outcome { state: EstadoDoNucleo::DePe { porta: core.port }, core: Some(core), started }
    }
}

/// The `--json` line of the owner's `start` (src/owner/start.ts, `StartOutput`). The keys it had
/// before #221 stay in Portuguese; `installation` and `dataDir` are new, in English.
#[derive(Debug, Deserialize)]
struct StartLine {
    estado: String,
    porta: Option<u16>,
    pid: Option<u32>,
    subiu: Option<bool>,
    motivo: Option<String>,
    installation: Option<String>,
    #[serde(rename = "dataDir")]
    data_dir: Option<String>,
}

/// Reads the last JSON line of `start --json`. A core that is up but says it belongs to another
/// installation, or to another data folder than `data_dir`, is refused: the app only uses its own.
pub fn read_start(output: &str, data_dir: Option<&Path>) -> Outcome {
    let line = output.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let Ok(s) = serde_json::from_str::<StartLine>(line) else {
        return Outcome::stopped("O núcleo não respondeu ao subir");
    };
    let port = match (s.estado.as_str(), s.porta) {
        ("de-pe", Some(port)) if port != 0 => port,
        _ => return Outcome::stopped(s.motivo.map(|m| format!("O núcleo não subiu: {m}")).unwrap_or_else(|| "O núcleo não subiu".into())),
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
    Outcome::up(Core { port, pid: s.pid }, s.subiu.unwrap_or(false))
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

/// An environment variable by its new name, else by its old one (decision 0009: the new one wins).
fn env_var(new: &str, old: &str) -> Option<String> {
    std::env::var(new).or_else(|_| std::env::var(old)).ok()
}

/// The first `node` on the PATH (already fixed from the login shell), if it is Node 24+.
/// `AHRENA_CONSOLE_NODE` (old name `AHRENA_NODE`) sets the path; empty, pretends there is no Node
/// (to see the A4).
pub fn find_node() -> Result<PathBuf, Option<String>> {
    let node = match env_var("AHRENA_CONSOLE_NODE", "AHRENA_NODE") {
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

/// `/api/overview` answers as the Ahrena Console core: `name` (#173 phase 2b) or, on an older
/// core, `nome` is `ahrena-console`; with `pid`, the overview's `pid` must be that one.
fn is_the_core(v: &serde_json::Value, pid: Option<u32>) -> bool {
    let name = v.get("name").or_else(|| v.get("nome")).and_then(|n| n.as_str());
    let same_pid = match pid {
        Some(pid) => v.get("pid").and_then(|p| p.as_u64()) == Some(u64::from(pid)),
        None => true,
    };
    name == Some("ahrena-console") && same_pid
}

/// Where the core is: `AHRENA_CONSOLE_CORE_DIR` (old name `AHRENA_NUCLEO_DIR`), else the app's
/// resources (`packages/nucleo`), else the checkout (in development, `cargo run`).
pub fn core_dir(resources: Option<PathBuf>) -> PathBuf {
    if let Some(p) = env_var("AHRENA_CONSOLE_CORE_DIR", "AHRENA_NUCLEO_DIR") {
        return PathBuf::from(p);
    }
    if let Some(r) = resources.map(|r| r.join("packages/nucleo")).filter(|p| p.join(OWNER_CLI).is_file()) {
        return r;
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/nucleo"))
}

/// Debug override for the tray screenshots: `AHRENA_CONSOLE_DEMO_PORT` (old name
/// `AHRENA_NUCLEO_PORTA`), the port of a simulator `--demo`. Set, the app starts no core and only
/// shows that one. Never set by the app itself.
pub fn demo_port() -> Option<u16> {
    env_var("AHRENA_CONSOLE_DEMO_PORT", "AHRENA_NUCLEO_PORTA").and_then(|p| p.parse().ok()).filter(|p| *p != 0)
}

/// Starts (or, within its own installation, adopts) the app's core. `data_dir`: the app's data
/// folder, from Tauri (`~/Library/Application Support/dev.ahrena.console`).
pub fn start_own_core(core: &Path, data_dir: Option<&Path>) -> Outcome {
    let cli = core.join(OWNER_CLI);
    match choose(demo_port(), find_node(), cli.is_file()) {
        Plan::Watch { port } => {
            let demo = Core { port, pid: None };
            if demo.answers() {
                Outcome::up(demo, false)
            } else {
                Outcome::stopped(format!("Nada responde como núcleo na porta {port} (AHRENA_CONSOLE_DEMO_PORT)"))
            }
        }
        Plan::Stopped { reason, no_node } => Outcome { state: EstadoDoNucleo::Parado { motivo: reason, sem_node: no_node }, core: None, started: false },
        Plan::Start { node } => {
            let mut command = Command::new(node);
            command.args(start_args(&cli, data_dir, std::process::id())).current_dir(core).stdin(Stdio::null()).stderr(Stdio::null());
            for name in FOREIGN_ENV {
                command.env_remove(name);
            }
            match command.output() {
                Ok(out) => read_start(&String::from_utf8_lossy(&out.stdout), data_dir),
                Err(e) => Outcome::stopped(format!("node: {e}")),
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
        let started = format!(r#"{{"estado":"de-pe","url":"http://127.0.0.1:53817","porta":53817,"pid":4242,"versao":"0.0.1","inicio":"x","pai":777,"subiu":true,"commit":null,"installation":"app","dataDir":"{DIR}"}}"#);
        assert_eq!(read_start(&started, Some(Path::new(DIR))), Outcome::up(Core { port: 53817, pid: Some(4242) }, true));
        let adopted = format!(r#"{{"estado":"de-pe","porta":53900,"pid":5151,"subiu":false,"aviso":"versão mais velha","installation":"app","dataDir":"{DIR}/"}}"#);
        assert_eq!(read_start(&format!("[log] something\n{adopted}\n"), Some(Path::new(DIR))), Outcome::up(Core { port: 53900, pid: Some(5151) }, false));
        let no_dir_given = r#"{"estado":"de-pe","porta":53817,"pid":1,"subiu":true,"installation":"app","dataDir":"/elsewhere"}"#;
        assert!(read_start(no_dir_given, None).core.is_some());
    }

    #[test]
    fn refuses_a_core_of_another_installation_or_folder() {
        let dev = r#"{"estado":"de-pe","porta":4720,"pid":1,"subiu":false,"installation":"dev","dataDir":"/Users/x/.ahrena-console"}"#;
        let r = read_start(dev, Some(Path::new(DIR)));
        assert_eq!(r.core, None);
        assert!(matches!(r.state, EstadoDoNucleo::Parado { ref motivo, sem_node: false } if motivo.contains("dev")));
        let old = r#"{"estado":"de-pe","porta":4720,"pid":1,"subiu":false}"#;
        assert_eq!(read_start(old, Some(Path::new(DIR))).core, None, "a core from before #221 does not say it is the app's");
        let folder = r#"{"estado":"de-pe","porta":53817,"pid":1,"subiu":true,"installation":"app","dataDir":"/tmp/other"}"#;
        assert_eq!(read_start(folder, Some(Path::new(DIR))).core, None);
        let no_folder = r#"{"estado":"de-pe","porta":53817,"pid":1,"subiu":true,"installation":"app"}"#;
        assert_eq!(read_start(no_folder, Some(Path::new(DIR))).core, None, "fails closed without dataDir");
    }

    #[test]
    fn reads_a_failed_start() {
        let stopped = r#"{"estado":"parado","motivo":"o núcleo saiu com código 1","installation":"app"}"#;
        let r = read_start(stopped, Some(Path::new(DIR)));
        assert!(!r.started);
        assert!(matches!(r.state, EstadoDoNucleo::Parado { ref motivo, sem_node: false } if motivo.contains("código 1")));
        assert!(matches!(read_start("", None).state, EstadoDoNucleo::Parado { .. }));
        assert_eq!(read_start(r#"{"estado":"de-pe","porta":0,"installation":"app"}"#, None).core, None);
    }

    #[test]
    fn overview_by_name_and_pid() {
        let v = |t: &str| serde_json::from_str::<serde_json::Value>(t).unwrap();
        assert!(is_the_core(&v(r#"{"ok":true,"name":"ahrena-console","version":"0.2.0","pid":42}"#), Some(42)));
        assert!(!is_the_core(&v(r#"{"ok":true,"name":"ahrena-console","pid":43}"#), Some(42)), "another core reused the port");
        assert!(!is_the_core(&v(r#"{"ok":true,"name":"ahrena-console"}"#), Some(42)));
        assert!(is_the_core(&v(r#"{"ok":true,"name":"ahrena-console"}"#), None));
        assert!(is_the_core(&v(r#"{"ok":true,"nome":"ahrena-console","versao":"0.1.0"}"#), None), "a core from before #173");
        assert!(!is_the_core(&v(r#"{"name":"outro"}"#), None));
        assert!(!is_the_core(&v(r#"{"ok":true}"#), None));
    }

    #[test]
    fn node_version() {
        assert!(node_version_works("v24.0.0"));
        assert!(node_version_works("v26.8.1\n"));
        assert!(!node_version_works("v22.18.0"));
        assert!(!node_version_works("garbage"));
    }
}
