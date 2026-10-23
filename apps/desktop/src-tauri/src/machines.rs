// The machines the tray shows (#180, decision 0008 section 5): this one and the remote ones, read
// from `GET /api/machines` and, per machine, `GET /api/telemetry?machine=<id>` (packages/nucleo
// src/api/telemetry.ts and src/telemetry/model.ts).
//
// Kept apart from Tauri so it is tested without opening the app: this module only parses the core's
// JSON and derives the short texts the menu (menu.rs) and the notifications (notifications.rs) show.
// Only the fields the tray needs are read; extra fields are ignored.

use serde::Deserialize;

use crate::http;

/// The id of this machine in the core.
pub const LOCAL_ID: &str = "local";
/// How the tray names this machine, whatever label the core gives it.
pub const LOCAL_LABEL: &str = "Este Mac";
/// The alert kind for a remote the core cannot read; the row and its reason line already say it.
pub const UNREACHABLE_KIND: &str = "machine-unreachable";

/// One item of `GET /api/machines`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MachineSummary {
    pub id: String,
    pub label: String,
    /// `connected`, `unreachable`, `not-configured` or `incompatible-version`.
    pub state: String,
    /// `port-closed` or `no-response` when `unreachable`.
    #[serde(default)]
    pub reason: Option<String>,
    /// The local port the tunnel forwards; `None` for this machine.
    #[serde(default)]
    pub port: Option<u16>,
    /// The `takenAt` of the newest stored reading (ISO 8601).
    #[serde(rename = "lastReadAt", default)]
    pub last_read_at: Option<String>,
    /// The reconnect of a remote machine (#244, decision 0012); `None` for this machine, for a core
    /// from before #244 and for a value that does not parse (read as "not configured").
    #[serde(default, deserialize_with = "lenient_reconnect")]
    pub reconnect: Option<Reconnect>,
    /// The connection of a remote machine (#278, decision 0013 section 4); `None` for this machine,
    /// for a core from before #278 and for a value that does not parse: then the tray behaves as in #244.
    #[serde(default, deserialize_with = "lenient_option")]
    pub connection: Option<Connection>,
}

/// The part of `connection` the tray reads (#278): the state, why it is down, what can run and the
/// job that runs. The commands, the log and the ports' details stay with the core and the `/ui`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Connection {
    #[serde(default)]
    pub configured: bool,
    /// `up`, `down`, `starting`, `stopping`, `failing` or `stopped`.
    pub state: String,
    #[serde(default)]
    pub since: Option<String>,
    /// This Mac's tunnel ports for the machine; the tray only counts them.
    #[serde(default, deserialize_with = "lenient_list")]
    pub ports: Vec<serde_json::Value>,
    #[serde(default, deserialize_with = "lenient_option")]
    pub cloud: Option<ConnectionCloud>,
    #[serde(rename = "lastError", default, deserialize_with = "lenient_option")]
    pub last_error: Option<ConnectionError>,
    #[serde(default, deserialize_with = "lenient_actions")]
    pub actions: ConnectionActions,
    #[serde(default, deserialize_with = "lenient_option")]
    pub job: Option<ConnectionJob>,
}

/// The cloud profile the tunnel depends on (`cloudProfile` in machines.json).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ConnectionCloud {
    #[serde(default)]
    pub profile: Option<String>,
    /// The SSO session the profile uses; `None` when the profile is not in ~/.aws/config.
    #[serde(default)]
    pub session: Option<String>,
    /// `valid`, `expiring`, `expired`, `never`, `unknown`, `not-found` or `unavailable`.
    #[serde(default)]
    pub state: String,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<String>,
}

/// Why the connection is down: a closed list in the core (`CONNECTION_REASONS`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ConnectionError {
    /// `sso-expired`, `port-busy`, `core-not-answering`, `ssm-agent-offline`, `host-unknown`,
    /// `key-refused` or `exit-code`.
    pub reason: String,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(rename = "exitCode", default)]
    pub exit_code: Option<i64>,
    /// The process holding the port, for `port-busy`.
    #[serde(default)]
    pub holder: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ConnectionActions {
    #[serde(default)]
    pub start: bool,
    #[serde(default)]
    pub stop: bool,
    #[serde(default)]
    pub reconnect: bool,
    #[serde(rename = "loginAndStart", default)]
    pub login_and_start: bool,
}

/// The job that runs (or the last one), with its steps in order.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ConnectionJob {
    /// `start`, `stop`, `reconnect` or `login-and-start`.
    #[serde(default)]
    pub kind: String,
    /// `login`, `stop`, `start` and `read`, in the order they run.
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub step: String,
    /// `running`, `succeeded`, `failed`, `timed-out` or `canceled`.
    #[serde(default)]
    pub state: String,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<String>,
    #[serde(rename = "stepStartedAt", default)]
    pub step_started_at: Option<String>,
}

/// A value absent, `null` or of an unexpected shape is `None`: an older or newer core never makes
/// `/api/machines` fail to parse, and a field of `connection` that does not parse keeps the rest.
fn lenient_option<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned>(d: D) -> Result<Option<T>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).ok())
}

fn lenient_actions<'de, D: serde::Deserializer<'de>>(d: D) -> Result<ConnectionActions, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

fn lenient_list<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<serde_json::Value>, D::Error> {
    match serde_json::Value::deserialize(d)? {
        serde_json::Value::Array(items) => Ok(items),
        _ => Ok(Vec::new()),
    }
}

impl Connection {
    /// A start, stop, reconnect or login-and-start runs, from the tray or the window.
    pub fn running(&self) -> bool {
        self.job.as_ref().is_some_and(|j| j.state == "running") || matches!(self.state.as_str(), "starting" | "stopping")
    }

    /// Down because the person stopped it ("parada por você", or the stop running): no notice.
    pub fn stopped_by_you(&self) -> bool {
        matches!(self.state.as_str(), "stopped" | "stopping")
    }

    pub fn reason(&self) -> Option<&str> {
        self.last_error.as_ref().map(|e| e.reason.as_str())
    }
}

/// What the tray (and a notification) can ask of a machine's connection (#278). Only these: the
/// path segment comes from here, never from a menu id or a notification's `userInfo`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionVerb {
    /// "Subir o túnel": `connection.start`.
    Start,
    /// "Reconectar a <label>": `connection.stop` (if any), then `connection.start`.
    Reconnect,
    /// "Entrar na AWS e subir o túnel": the linked session's login, then `connection.start`.
    LoginAndStart,
}

impl ConnectionVerb {
    pub const ALL: [ConnectionVerb; 3] = [ConnectionVerb::Start, ConnectionVerb::Reconnect, ConnectionVerb::LoginAndStart];

    pub fn segment(self) -> &'static str {
        match self {
            ConnectionVerb::Start => "start",
            ConnectionVerb::Reconnect => "reconnect",
            ConnectionVerb::LoginAndStart => "login-and-start",
        }
    }

    pub fn from_segment(segment: &str) -> Option<ConnectionVerb> {
        ConnectionVerb::ALL.into_iter().find(|v| v.segment() == segment)
    }
}

/// `POST` here runs `verb` on the connection of `id`; `None` for this machine and for an id that
/// makes no path segment.
pub fn connection_path(id: &str, verb: ConnectionVerb) -> Option<String> {
    if matches!(id, "" | "." | ".." | LOCAL_ID) {
        return None;
    }
    Some(format!("/api/machines/{}/connection/{}", http::encode(id), verb.segment()))
}

#[derive(Deserialize)]
struct ConnectionResponse {
    #[serde(default, deserialize_with = "lenient_option")]
    connection: Option<Connection>,
}

/// The `connection` of the 202 answer, to show the running line before the next read.
pub fn connection_from_response(text: &str) -> Option<Connection> {
    serde_json::from_str::<ConnectionResponse>(text).ok()?.connection
}

/// A length of time the way the tray says it: "menos de 1 min", "14 min", "9 h 50 min", "2 d 3 h".
pub fn span(minutes: u64) -> String {
    match minutes {
        0 => "menos de 1 min".into(),
        m if m < 60 => format!("{m} min"),
        m if m < 60 * 24 => match m % 60 {
            0 => format!("{} h", m / 60),
            r => format!("{} h {r} min", m / 60),
        },
        m => match (m / 60) % 24 {
            0 => format!("{} d", m / (60 * 24)),
            h => format!("{} d {h} h", m / (60 * 24)),
        },
    }
}

/// A name from the core shown as is (the process holding a port): at most 40 characters.
pub fn short(text: &str) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(40).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// The row's text after the label, for a machine with a `connection` (#278, A9): "túnel no ar há 9 h
/// 50 min · 4 portas", "sem conexão desde 03:11", "parada por você", "subindo o túnel".
pub fn connection_row(s: &MachineSummary, c: &Connection, now_ms: u64, offset_s: i64) -> String {
    if c.running() {
        return match c.job.as_ref().filter(|j| j.state == "running").map(|j| j.step.as_str()) {
            Some("login") => "entrando na AWS".into(),
            Some("stop") => "parando o túnel".into(),
            Some(_) => "subindo o túnel".into(),
            None if c.state == "stopping" => "parando o túnel".into(),
            None => "subindo o túnel".into(),
        };
    }
    match c.state.as_str() {
        "up" => {
            let mut parts = vec![match c.since.as_deref().and_then(|t| minutes_since(t, now_ms)) {
                Some(m) => format!("túnel no ar há {}", span(m)),
                None => "túnel no ar".to_string(),
            }];
            match c.ports.len() {
                0 => {}
                1 => parts.push("1 porta".into()),
                n => parts.push(format!("{n} portas")),
            }
            parts.join(" · ")
        }
        "stopped" => "parada por você".into(),
        _ => match c.since.as_deref().and_then(parse_iso_ms).filter(|at| *at <= now_ms) {
            Some(at) => format!("sem conexão desde {}", crate::clouds::clock(at, now_ms, offset_s)),
            None => match s.last_read_at.as_deref().and_then(|t| minutes_since(t, now_ms)) {
                Some(m) => format!("sem conexão {}", ago(m)),
                None => "sem conexão".into(),
            },
        },
    }
}

/// The grey lines under a running job (A9, "Enquanto roda"): the step with its count and, for a
/// login or a stop that a start follows, "depois: subir o túnel".
pub fn connection_running_lines(s: &MachineSummary, c: &Connection, now_ms: u64) -> Vec<String> {
    let Some(job) = c.job.as_ref().filter(|j| j.state == "running") else { return Vec::new() };
    let step = match job.step.as_str() {
        "login" => "Entrando na AWS · aguardando o navegador".to_string(),
        "stop" => "Parando o túnel".to_string(),
        "start" => "Subindo o túnel".to_string(),
        "read" => format!("Lendo a {}", display_label(s)),
        _ => return Vec::new(),
    };
    let time = job.step_started_at.as_deref().or(job.started_at.as_deref()).and_then(|t| running_for(t, now_ms));
    let mut lines = vec![match time {
        Some(t) => format!("{step} · {t}"),
        None => step,
    }];
    let start_follows = job.steps.iter().skip_while(|x| **x != job.step).skip(1).any(|x| x == "start");
    if matches!(job.step.as_str(), "login" | "stop") && start_follows {
        lines.push("depois: subir o túnel".into());
    }
    lines
}

/// The grey line under a machine whose connection is down: the reason in plain words (A9), or
/// `None` when the core gave none (then the #244 line of `unreachable_reason`, if any).
pub fn connection_reason_line(s: &MachineSummary, c: &Connection, now_ms: u64) -> Option<String> {
    let e = c.last_error.as_ref()?;
    Some(match e.reason.as_str() {
        "sso-expired" => match sso_expired_at(c, now_ms) {
            Some(at) => format!("Túnel fora: SSO expirado {}", ago(now_ms.saturating_sub(at) / 60_000)),
            None => "Túnel fora: SSO expirado".into(),
        },
        "port-busy" => {
            let port = s.port.map(|p| format!("Porta {p}")).unwrap_or_else(|| "A porta do túnel".into());
            match e.holder.as_deref().filter(|h| !h.is_empty()) {
                Some(h) => format!("{port} ocupada no Mac por {}", short(h)),
                None => format!("{port} ocupada no Mac"),
            }
        }
        "core-not-answering" => "Túnel no ar, núcleo de lá parado".into(),
        "ssm-agent-offline" => format!("Túnel fora: agente SSM da {} offline", display_label(s)),
        "host-unknown" => "Túnel fora: host desconhecido no ~/.ssh/config".into(),
        "key-refused" => "Túnel fora: chave SSH recusada".into(),
        "exit-code" => match e.exit_code {
            Some(code) => format!("Túnel fora: o comando saiu com o código {code}"),
            None => "Túnel fora: o comando de subir não terminou".into(),
        },
        _ => return None,
    })
}

/// When the linked SSO session expired: the token's end, else when the core saw it; `None` in the future.
pub fn sso_expired_at(c: &Connection, now_ms: u64) -> Option<u64> {
    let cloud = c.cloud.as_ref().and_then(|x| x.expires_at.as_deref()).and_then(parse_iso_ms);
    let seen = c.last_error.as_ref().and_then(|e| e.at.as_deref()).and_then(parse_iso_ms);
    cloud.or(seen).filter(|at| *at <= now_ms)
}

/// The SSO sessions the machines' tunnels depend on, with the machine's label: "· a Workstation usa"
/// in the "Nuvens" block and "· a Workstation cai junto" in the 15-minute notice (A9, A10).
pub fn cloud_links(ms: &[Machine]) -> Vec<(String, String)> {
    ms.iter()
        .filter_map(|m| {
            let session = m.summary.connection.as_ref()?.cloud.as_ref()?.session.clone()?;
            Some((session, display_label(&m.summary).to_string()))
        })
        .collect()
}

/// The part of `reconnect` the tray reads (#244): whether a command is configured and whether one
/// runs. The command itself, its output and its log stay with the core and the `/ui`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Reconnect {
    #[serde(default)]
    pub configured: bool,
    /// `idle`, `running`, `succeeded`, `failed`, `timed-out` or `canceled`.
    #[serde(default)]
    pub state: Option<String>,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<String>,
}

/// `reconnect` absent, `null` or of an unexpected shape is `None`: an older or newer core never
/// makes `/api/machines` fail to parse.
fn lenient_reconnect<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Reconnect>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).ok())
}

/// The body of `POST /api/machines/<id>/reconnect` (202): `{ reconnect }`.
#[derive(Deserialize)]
struct ReconnectResponse {
    #[serde(default, deserialize_with = "lenient_reconnect")]
    reconnect: Option<Reconnect>,
}

/// The `reconnect` of the 202 answer, to show "Reconectando…" before the next read.
pub fn reconnect_from_response(text: &str) -> Option<Reconnect> {
    serde_json::from_str::<ReconnectResponse>(text).ok()?.reconnect
}

impl MachineSummary {
    /// The machine has a reconnect command in machines.json.
    pub fn reconnect_configured(&self) -> bool {
        self.reconnect.as_ref().is_some_and(|r| r.configured)
    }

    /// A reconnect runs for this machine, from the tray or the window.
    pub fn reconnect_running(&self) -> bool {
        self.reconnect.as_ref().is_some_and(|r| r.state.as_deref() == Some("running"))
    }
}

/// `POST` here starts the reconnect of `id`; `None` for an id that makes no path segment.
pub fn reconnect_path(id: &str) -> Option<String> {
    if matches!(id, "" | "." | "..") {
        return None;
    }
    Some(format!("/api/machines/{}/reconnect", http::encode(id)))
}

/// `m:ss` from `started_at` to `now_ms`, as the running line counts it; `None` when it does not parse.
pub fn running_for(started_at: &str, now_ms: u64) -> Option<String> {
    let seconds = now_ms.saturating_sub(parse_iso_ms(started_at)?) / 1_000;
    Some(format!("{}:{:02}", seconds / 60, seconds % 60))
}

/// The part of `GET /api/telemetry?machine=<id>` the tray reads.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Telemetry {
    /// `None` before the first sample.
    #[serde(default)]
    pub current: Option<Reading>,
    #[serde(default)]
    pub alerts: Vec<Alert>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Reading {
    pub cpu: Cpu,
    pub disk: Disk,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Cpu {
    pub cores: u32,
    #[serde(rename = "usedPct", default)]
    pub used_pct: Option<f64>,
    pub load: Load,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Load {
    pub one: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Disk {
    pub volumes: Vec<Volume>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Volume {
    pub mount: String,
    #[serde(rename = "usedPct")]
    pub used_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Alert {
    /// Stable while the condition lasts: `load-high`, `volume-full:/`, `machine-unreachable`.
    pub id: String,
    pub kind: String,
    /// `error` or `warning`.
    pub level: String,
    /// Screen text, pt-BR.
    pub message: String,
    #[serde(default)]
    pub detail: Option<String>,
    pub since: String,
}

/// A machine as the tray sees it: the summary and, when it could be read, its telemetry.
#[derive(Debug, Clone, PartialEq)]
pub struct Machine {
    pub summary: MachineSummary,
    pub telemetry: Option<Telemetry>,
}

/// `GET /api/machines`; the serde error when it does not parse, for the caller to log.
pub fn summaries_from_json(text: &str) -> Result<Vec<MachineSummary>, serde_json::Error> {
    serde_json::from_str(text)
}

/// `GET /api/telemetry`; the serde error when it does not parse, for the caller to log.
pub fn telemetry_from_json(text: &str) -> Result<Telemetry, serde_json::Error> {
    serde_json::from_str(text)
}

/// The name in the tray: "Este Mac" for this machine, the core's label for a remote one.
pub fn display_label(s: &MachineSummary) -> &str {
    if s.id == LOCAL_ID {
        LOCAL_LABEL
    } else {
        &s.label
    }
}

/// The machine's screen in the core's `/ui`, where a click on its row or alert leads.
pub fn machine_path(id: &str) -> String {
    if matches!(id, "" | "." | "..") {
        return "/ui".into();
    }
    format!("/ui/machines/{}", http::encode(id))
}

/// A number the pt-BR way, with one decimal: `24,6`.
pub fn decimal(x: f64) -> String {
    format!("{x:.1}").replace('.', ",")
}

/// "há 12 min", from `elapsed` in menu.rs, with "menos de 1 min" for zero.
pub fn ago(minutes: u64) -> String {
    if minutes == 0 {
        "há menos de 1 min".into()
    } else {
        format!("há {}", crate::menu::elapsed(minutes))
    }
}

/// Whole minutes from an ISO 8601 instant to `now_ms`; `None` when it does not parse.
pub fn minutes_since(iso: &str, now_ms: u64) -> Option<u64> {
    let at = parse_iso_ms(iso)?;
    Some(now_ms.saturating_sub(at) / 60_000)
}

/// Milliseconds since the epoch of `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`, as `Date.toISOString`
/// writes it. No date crate for one format.
pub fn parse_iso_ms(iso: &str) -> Option<u64> {
    let b = iso.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    // An unsigned decimal field: digits only, so a sign such as "-1" does not pass `parse`.
    let digit_field = |text: &str, from: usize, to: usize| -> Option<i64> {
        text.get(from..to).filter(|s| s.bytes().all(|b| b.is_ascii_digit()))?.parse().ok()
    };
    let num = |from: usize, to: usize| digit_field(iso, from, to);
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut rest = &iso[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let first3 = &frac[..digits.min(3)];
        millis = first3.parse::<i64>().ok()? * 10i64.pow(3 - first3.len() as u32);
        rest = &frac[digits..];
    }
    let offset_min = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) && rest.as_bytes()[3] == b':' => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            sign * (digit_field(rest, 1, 3)? * 60 + digit_field(rest, 4, 6)?)
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_min * 60;
    u64::try_from(secs * 1_000 + millis).ok()
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The figure that matters in a connected machine's row: CPU (or load against cores when the load
/// exceeds them) and the fullest volume. "CPU 34% · disco 61%", "carga 24,6 de 16 · disco 86%".
pub fn figures(r: &Reading) -> String {
    let mut parts = Vec::new();
    if r.cpu.cores > 0 && r.cpu.load.one > f64::from(r.cpu.cores) {
        parts.push(format!("carga {} de {}", decimal(r.cpu.load.one), r.cpu.cores));
    } else if let Some(p) = r.cpu.used_pct {
        parts.push(format!("CPU {}%", p.round() as i64));
    }
    if let Some(v) = r.disk.volumes.iter().max_by(|a, b| a.used_pct.total_cmp(&b.used_pct)) {
        parts.push(format!("disco {}%", v.used_pct.round() as i64));
    }
    parts.join(" · ")
}

/// The disabled line under an unreachable remote: what the core saw.
pub fn unreachable_reason(s: &MachineSummary) -> Option<String> {
    match s.reason.as_deref()? {
        "port-closed" => Some(match s.port {
            Some(p) => format!("A porta {p} não aceita conexão: o túnel parece caído"),
            None => "A porta do túnel não aceita conexão: o túnel parece caído".into(),
        }),
        "no-response" => Some("O túnel está de pé, mas o núcleo de lá não respondeu".into()),
        _ => None,
    }
}

/// The short name of an alert, as the menu item and the notification title use it: "CPU saturada
/// há 12 min", "Volume / em 86%". Unknown kinds fall back to the core's message.
pub fn alert_text(a: &Alert, reading: Option<&Reading>, now_ms: u64) -> String {
    match a.kind.as_str() {
        "load-high" => match minutes_since(&a.since, now_ms) {
            Some(m) => format!("CPU saturada {}", ago(m)),
            None => "CPU saturada".into(),
        },
        "volume-full" => {
            let mount = a.id.strip_prefix("volume-full:").unwrap_or("");
            let pct = reading.and_then(|r| r.disk.volumes.iter().find(|v| v.mount == mount)).map(|v| v.used_pct.round() as i64);
            match (mount, pct) {
                ("", _) => a.message.clone(),
                (m, Some(p)) => format!("Volume {m} em {p}%"),
                (m, None) => format!("Volume {m} quase cheio"),
            }
        }
        _ => a.message.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-18T23:10:00.000Z";

    #[test]
    fn iso_instants_parse_like_date_parse() {
        // 2026-10-18T23:10:00Z, checked against `Date.parse`.
        assert_eq!(parse_iso_ms(NOW), Some(1_792_365_000_000));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-18T23:10:00.5Z"), Some(1_792_365_000_500));
        assert_eq!(parse_iso_ms("2026-10-18T20:10:00-03:00"), Some(1_792_365_000_000));
        for bad in ["", "ontem", "2026-13-01T00:00:00Z", "2026-10-18T23:10:00", "2026-10-18T23:10:00.Z", "2026-10-18T-1:10:00Z", "2026-10-18T20:10:00+-1:30"] {
            assert_eq!(parse_iso_ms(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn minutes_and_ago() {
        let now = parse_iso_ms(NOW).unwrap();
        assert_eq!(minutes_since("2026-10-18T22:56:00.000Z", now), Some(14));
        assert_eq!(minutes_since("2026-10-18T23:11:00.000Z", now), Some(0), "a clock ahead is zero, not a panic");
        assert_eq!([ago(0), ago(14), ago(90)], ["há menos de 1 min", "há 14 min", "há 1 h"]);
    }

    #[test]
    fn machine_path_is_encoded() {
        assert_eq!(machine_path("local"), "/ui/machines/local");
        assert_eq!(machine_path("workstation"), "/ui/machines/workstation");
        assert_eq!(machine_path("a/b"), "/ui/machines/a%2Fb");
        assert_eq!(machine_path(".."), "/ui");
    }

    #[test]
    fn reconnect_is_read_leniently() {
        let one = |extra: &str| -> MachineSummary {
            let json = format!(r#"[{{ "id": "workstation", "label": "Workstation", "state": "unreachable", "port": 14720 {extra} }}]"#);
            summaries_from_json(&json).expect("parses").remove(0)
        };
        for older in ["", r#", "reconnect": null"#, r#", "reconnect": "x""#, r#", "reconnect": { "configured": "yes" }"#] {
            let s = one(older);
            assert_eq!(s.reconnect, None, "{older:?}");
            assert!(!s.reconnect_configured() && !s.reconnect_running());
        }
        let s = one(
            r#", "reconnect": { "configured": true, "command": ["/x/conectar.sh"], "timeoutSeconds": 180, "state": "running",
                "startedAt": "2026-10-18T23:08:48.000Z", "endedAt": null, "exitCode": null, "startedBy": "local", "logFile": "/d/reconnect.log" }"#,
        );
        assert!(s.reconnect_configured() && s.reconnect_running());
        assert_eq!(s.reconnect.unwrap().started_at.as_deref(), Some("2026-10-18T23:08:48.000Z"));
        let idle = one(r#", "reconnect": { "configured": false, "state": "idle" }"#);
        assert!(!idle.reconnect_configured() && !idle.reconnect_running());
    }

    #[test]
    fn reconnect_response_and_path() {
        let r = reconnect_from_response(r#"{ "reconnect": { "configured": true, "state": "running", "startedAt": null } }"#).unwrap();
        assert_eq!((r.configured, r.state.as_deref()), (true, Some("running")));
        assert_eq!(reconnect_from_response(r#"{ "error": "não configurado" }"#), None);
        assert_eq!(reconnect_path("workstation").as_deref(), Some("/api/machines/workstation/reconnect"));
        assert_eq!(reconnect_path("a/b").as_deref(), Some("/api/machines/a%2Fb/reconnect"));
        assert_eq!(reconnect_path(".."), None);
    }

    #[test]
    fn running_for_counts_minutes_and_seconds() {
        let now = parse_iso_ms(NOW).unwrap();
        assert_eq!(running_for("2026-10-18T23:08:48.000Z", now).as_deref(), Some("1:12"));
        assert_eq!(running_for("2026-10-18T23:10:00.000Z", now).as_deref(), Some("0:00"));
        assert_eq!(running_for("2026-10-18T23:11:00.000Z", now).as_deref(), Some("0:00"), "a clock ahead is zero");
        assert_eq!(running_for("ontem", now), None);
    }

    #[test]
    fn connection_is_read_leniently() {
        let one = |connection: &str| -> MachineSummary {
            let json = format!(r#"[{{ "id": "workstation", "label": "Workstation", "state": "connected", "port": 14720, "connection": {connection} }}]"#);
            summaries_from_json(&json).expect("parses").remove(0)
        };
        for older in ["null", r#""x""#, r#"{ "configured": true }"#, "[]"] {
            assert_eq!(one(older).connection, None, "{older}");
        }
        let c = one(r#"{ "configured": true, "state": "down", "since": null, "ports": "x", "cloud": 3, "lastError": { "at": "x" }, "actions": null, "job": "running" }"#).connection.expect("the state is enough");
        assert!(!c.running() && !c.stopped_by_you());
        assert_eq!((c.ports.len(), c.cloud, c.last_error, c.actions, c.job), (0, None, None, ConnectionActions::default(), None), "each bad field alone is dropped");
        let c = one(
            r#"{ "configured": true, "state": "starting", "since": "2026-10-18T23:08:48.000Z", "ports": [{}, {}], "cloud": null,
                 "lastError": null, "actions": { "start": false, "stop": false, "reconnect": false, "loginAndStart": false },
                 "job": { "kind": "login-and-start", "steps": ["login", "start", "read"], "step": "login", "state": "running", "startedAt": "2026-10-18T23:08:48.000Z", "stepStartedAt": "2026-10-18T23:08:48.000Z" } }"#,
        )
        .connection
        .unwrap();
        assert!(c.running());
        assert_eq!(c.job.unwrap().steps, ["login", "start", "read"]);
    }

    #[test]
    fn connection_paths_carry_only_the_id_and_a_known_verb() {
        assert_eq!(connection_path("workstation", ConnectionVerb::LoginAndStart).as_deref(), Some("/api/machines/workstation/connection/login-and-start"));
        assert_eq!(connection_path("workstation", ConnectionVerb::Reconnect).as_deref(), Some("/api/machines/workstation/connection/reconnect"));
        assert_eq!(connection_path("a/b", ConnectionVerb::Start).as_deref(), Some("/api/machines/a%2Fb/connection/start"));
        for bad in ["", ".", "..", "local"] {
            assert_eq!(connection_path(bad, ConnectionVerb::Start), None, "{bad:?}");
        }
        for v in ConnectionVerb::ALL {
            assert_eq!(ConnectionVerb::from_segment(v.segment()), Some(v));
        }
        assert_eq!(ConnectionVerb::from_segment("stop"), None, "the tray never stops by itself");
        assert_eq!(ConnectionVerb::from_segment("../reconnect"), None);
        let c = connection_from_response(r#"{ "connection": { "configured": true, "state": "starting", "job": null } }"#).unwrap();
        assert_eq!(c.state, "starting");
        assert_eq!(connection_from_response(r#"{ "error": "x", "reason": "busy" }"#), None);
    }

    #[test]
    fn spans_in_hours_and_minutes() {
        assert_eq!([span(0), span(14), span(60), span(590), span(60 * 24), span(60 * 27 + 5)], ["menos de 1 min", "14 min", "1 h", "9 h 50 min", "1 d", "1 d 3 h"]);
        assert_eq!(short("node"), "node");
        assert_eq!(short(&"x".repeat(50)), format!("{}…", "x".repeat(40)));
    }

    #[test]
    fn decimal_uses_a_comma() {
        assert_eq!([decimal(24.6), decimal(16.0), decimal(2.04)], ["24,6", "16,0", "2,0"]);
    }
}
