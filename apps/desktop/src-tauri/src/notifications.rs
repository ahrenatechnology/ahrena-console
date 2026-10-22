// The system notifications (wireframe A3, issue #88) as data: when to notify, what, and who is
// silenced.
//
// Kept apart from Tauri so it is tested without opening the app. The tray rereads `/api/attention`
// on every change and every 25 s; notifying on every read would be noise. The `Detector` keeps each
// session's reason from the previous read and only notifies a session that entered the list or
// changed reason. The first read (on opening, or after losing the core) only records: whoever was
// already waiting does not become a notice. Only the sessions that need you count (#245): an idle
// one (Sua vez, Interrompida, No prompt) never notifies, nor does a blocked one turning idle.
//
// Machine alerts (#180, decision 0008 sections 3 and 5) follow the same rule with their own
// detector: a new alert, or a machine going down (its `machine-unreachable` alert), notifies once,
// on the transition, without sound; the first read and a rediscovery of the core only record.
//
// The AWS SSO sessions (#277, decision 0013 section 7, A10) have a detector of their own too: a session
// entering `expiring` ("Sessão da AWS expira em 15 min") or `expired` ("Sessão da AWS expirada")
// notifies once per session and per token end, without sound, with "Entrar" and "Abrir".
//
// The silence belongs to the app, not to the core: a small JSON in the app's data folder, with the
// menu's main switch ("Notificações") and the sessions silenced by the notification's "Silenciar".

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::clouds;
use crate::http;
use crate::machines;
use crate::menu::{Attention, AttentionItem};

/// The name of the silence file in the app's data folder.
pub const FILE: &str = "notifications.json";
/// Its name before #173 (phase 4): read once, when `FILE` does not exist yet, and then removed.
pub const LEGACY_FILE: &str = "notificacoes.json";

/// A notification to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    /// Every session notice has sound (A3, #245: only blocked sessions notify); machine alerts do not.
    pub sound: bool,
    pub session: String,
    /// Claude Desktop's `local_…`, for "Abrir no Claude Desktop".
    pub local: Option<String>,
    /// Where the click and "Abrir" take the app window: the session's or the machine's screen.
    pub path: String,
    pub origin: Origin,
    /// The machine of a machine notice, for "Reconectar" (#244); `None` for a session.
    pub machine: Option<String>,
    /// The SSO session of a cloud notice, for "Entrar" (#277); `None` otherwise.
    pub cloud_session: Option<String>,
}

/// What a notice is about: it decides the actions the notification offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// "Abrir", "Abrir no Claude Desktop" and "Silenciar" (A3).
    Session,
    /// A session on a remote machine (#180, decision 0008 section 5): "Abrir" and "Silenciar",
    /// no "Abrir no Claude Desktop", since this Mac's Claude Desktop does not know it.
    RemoteSession,
    /// A machine alert (#180): only "Abrir".
    Machine,
    /// "<label> sem conexão" of a machine with a reconnect command (#244, A8): "Reconectar" and "Abrir".
    MachineReconnect,
    /// An AWS session expiring or expired (#277, A10) whose name goes on the command line:
    /// "Entrar" and "Abrir".
    CloudLogin,
    /// The same, for a session the core cannot log in (its name, or no CLI): only "Abrir".
    Cloud,
}

/// An action button of a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// "Abrir": the app window at the notice's `path`.
    Open,
    /// "Abrir no Claude Desktop": `POST /open/<local_…>`.
    OpenInDesktop,
    /// "Silenciar": silences the session.
    Silence,
    /// "Reconectar": `POST /api/machines/<id>/reconnect` (#244).
    Reconnect,
    /// "Entrar": `POST /api/connectors/aws/sessions/<name>/login` (#277).
    CloudLogin,
}

impl Origin {
    /// The actions this kind of notice offers, in the order the notification shows them.
    pub fn actions(self) -> &'static [Action] {
        match self {
            Origin::Session => &[Action::Open, Action::OpenInDesktop, Action::Silence],
            Origin::RemoteSession => &[Action::Open, Action::Silence],
            Origin::Machine => &[Action::Open],
            Origin::MachineReconnect => &[Action::Reconnect, Action::Open],
            Origin::CloudLogin => &[Action::CloudLogin, Action::Open],
            Origin::Cloud => &[Action::Open],
        }
    }
}

impl Notice {
    pub fn from_item(i: &AttentionItem) -> Notice {
        Notice {
            title: title(i),
            body: i.long_reason.clone(),
            sound: true,
            session: i.session.clone(),
            local: i.local.clone(),
            path: session_path(&i.session),
            origin: if i.machine.is_some() { Origin::RemoteSession } else { Origin::Session },
            machine: None,
            cloud_session: None,
        }
    }

    /// A machine alert as a notification, silent: "Workstation: CPU saturada", "Workstation sem
    /// conexão". `session` carries the alert key, the notification's identifier.
    pub fn from_machine_alert(m: &machines::MachineSummary, a: &machines::Alert) -> Notice {
        let label = machines::display_label(m);
        let (title, body) = match a.kind.as_str() {
            machines::UNREACHABLE_KIND => (format!("{label} sem conexão"), a.detail.clone().unwrap_or_default()),
            "load-high" => (format!("{label}: CPU saturada"), a.message.clone()),
            "volume-full" => (format!("{label}: disco quase cheio"), a.message.clone()),
            _ => (format!("{label}: {}", a.message), a.detail.clone().unwrap_or_default()),
        };
        // "Reconectar" only on the "sem conexão" of a machine with a command in machines.json (A8 c).
        let origin = if a.kind == machines::UNREACHABLE_KIND && m.id != machines::LOCAL_ID && m.reconnect_configured() { Origin::MachineReconnect } else { Origin::Machine };
        Notice { title, body, sound: false, session: alert_key(&m.id, &a.id), local: None, path: machines::machine_path(&m.id), origin, machine: Some(m.id.clone()), cloud_session: None }
    }

    /// An AWS session expiring or expired, silent (A10): "Sessão da AWS expira em 15 min",
    /// "Sessão da AWS expirada". `session` is `cloud:aws:<name>`, so the expired notice replaces the
    /// expiring one in the Notification Center. `None` for any other state.
    pub fn from_cloud_session(aws: &clouds::Aws, s: &clouds::Session, now_ms: u64, offset_s: i64) -> Option<Notice> {
        let (title, body) = match s.state.as_str() {
            "expiring" => {
                let minutes = s.expires_ms().map(|at| at.saturating_sub(now_ms).div_ceil(60_000)).unwrap_or(0);
                let title = if minutes > 0 { format!("Sessão da AWS expira em {} min", minutes.min(15)) } else { "Sessão da AWS expira em menos de 1 min".into() };
                (title, s.name.clone())
            }
            "expired" => {
                let body = match s.expires_ms().filter(|at| *at <= now_ms) {
                    Some(at) => format!("{} expirou às {}", s.name, clouds::clock(at, now_ms, offset_s)),
                    None => format!("{} expirou", s.name),
                };
                ("Sessão da AWS expirada".to_string(), body)
            }
            _ => return None,
        };
        let origin = if s.offers_login(aws) { Origin::CloudLogin } else { Origin::Cloud };
        Some(Notice { title, body, sound: false, session: format!("cloud:aws:{}", s.name), local: None, path: clouds::CONNECTIONS_PATH.into(), origin, machine: None, cloud_session: Some(s.name.clone()) })
    }
}

/// The AWS sessions that entered `expiring` or `expired` since the previous read (#277).
#[derive(Debug, Default)]
pub struct CloudSessionDetector {
    /// `<session>|<state>|<expiresAt>` of every condition seen, kept: a session that goes from
    /// `expiring` to `unknown` (a network hiccup) and back does not notify twice for the same token
    /// end, and a new login (a new end) notifies again. `None` before the first read (or after `reset`).
    seen: Option<HashSet<String>>,
}

impl CloudSessionDetector {
    pub fn observe(&mut self, aws: &clouds::Aws, now_ms: u64, offset_s: i64) -> Vec<Notice> {
        let first = self.seen.is_none();
        let seen = self.seen.get_or_insert_with(HashSet::new);
        let mut notices = Vec::new();
        for s in clouds::ordered(aws).into_iter().filter(|s| matches!(s.state.as_str(), "expiring" | "expired")) {
            let key = format!("{}|{}|{}", s.name, s.state, s.expires_at.as_deref().unwrap_or(""));
            if seen.insert(key) && !first {
                notices.extend(Notice::from_cloud_session(aws, s, now_ms, offset_s));
            }
        }
        notices
    }

    /// Forgets what was seen: the next read only records. On losing the core or its connectors.
    pub fn reset(&mut self) {
        self.seen = None;
    }
}

/// The identity of a machine alert across reads, as `/api/changes` names it (`<machine>:<alert>`),
/// with a prefix that never collides with a session id in the silence file or the notification center.
fn alert_key(machine: &str, alert: &str) -> String {
    format!("machine:{machine}:{alert}")
}

/// The machine alerts that opened since the previous read (#180).
#[derive(Debug, Default)]
pub struct MachineAlertDetector {
    /// The alert keys of the previous read; `None` before the first (or after `reset`).
    previous: Option<HashSet<String>>,
}

impl MachineAlertDetector {
    pub fn observe(&mut self, ms: &[machines::Machine]) -> Vec<Notice> {
        let mut now: HashSet<String> = HashSet::new();
        let mut notices = Vec::new();
        for m in ms {
            let Some(t) = &m.telemetry else {
                // The telemetry read failed this time: keep what was open, so it does not notify again.
                let prefix = alert_key(&m.summary.id, "");
                now.extend(self.previous.iter().flatten().filter(|k| k.starts_with(&prefix)).cloned());
                continue;
            };
            for a in &t.alerts {
                let key = alert_key(&m.summary.id, &a.id);
                if self.previous.as_ref().is_some_and(|p| !p.contains(&key)) {
                    notices.push(Notice::from_machine_alert(&m.summary, a));
                }
                now.insert(key);
            }
        }
        self.previous = Some(now);
        notices
    }

    /// Forgets the previous read: the next one only records. On losing the core or its telemetry.
    pub fn reset(&mut self) {
        self.previous = None;
    }
}

/// The A3 title: the session and the reason ("motor-de-regras pede permissão").
pub fn title(i: &AttentionItem) -> String {
    // A remote session carries its machine's label (#180): "motor-de-regras · Workstation pede permissão".
    let t = match &i.machine {
        Some(m) => format!("{} · {}", i.title, m.label),
        None => i.title.clone(),
    };
    match i.reason.as_str() {
        "permission" => format!("{t} pede permissão"),
        "question" => format!("{t} fez uma pergunta"),
        "plan" => format!("{t} tem um plano para aprovar"),
        "decision" => format!("{t} pede uma decisão"),
        "error" => format!("{t} parou com erro"),
        _ => format!("{t}: {}", i.short_reason),
    }
}

/// Who entered the "precisam de você" list (blocked, #245) or changed reason since the previous read.
#[derive(Debug, Default)]
pub struct Detector {
    /// `session` → `reason` of the previous read; `None` before the first (or after `reset`).
    previous: Option<HashMap<String, String>>,
}

impl Detector {
    pub fn observe(&mut self, a: &Attention) -> Vec<Notice> {
        let blocked = a.blocked_items();
        let now: HashMap<String, String> = blocked.iter().map(|i| (i.session.clone(), i.reason.clone())).collect();
        let notices = match &self.previous {
            None => Vec::new(),
            Some(before) => blocked.into_iter().filter(|i| before.get(&i.session) != Some(&i.reason)).map(Notice::from_item).collect(),
        };
        self.previous = Some(now);
        notices
    }

    /// Forgets the previous read: the next one only records. On losing the core or the list.
    pub fn reset(&mut self) {
        self.previous = None;
    }
}

/// The main switch and the silenced sessions, as they go in the JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Silence {
    /// The "Notificações" check in the menu; off, nothing notifies.
    /// `alias`: the keys of the file written before #173 (phase 4).
    #[serde(alias = "ligadas", default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(alias = "sessoes", default)]
    pub sessions: BTreeSet<String>,
}

fn enabled_by_default() -> bool {
    true
}

impl Default for Silence {
    fn default() -> Self {
        Silence { enabled: true, sessions: BTreeSet::new() }
    }
}

impl Silence {
    pub fn filter(&self, notices: Vec<Notice>) -> Vec<Notice> {
        if !self.enabled {
            return Vec::new();
        }
        notices.into_iter().filter(|n| !self.sessions.contains(&n.session)).collect()
    }

    /// Missing or unreadable: the default (on, nobody silenced).
    pub fn load(path: &Path) -> Silence {
        std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Writes to a temporary file next to it and renames, so as not to leave half a file.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        let tmp = path.with_extension("json.tmp");
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    }
}

/// The detector, the silence and where it is saved: what the app keeps of the notifications.
#[derive(Debug, Default)]
pub struct Notices {
    pub detector: Detector,
    /// The machine alerts' detector (#180), behind the same switch.
    pub machines: MachineAlertDetector,
    /// The AWS sessions' detector (#277), behind the same switch.
    pub clouds: CloudSessionDetector,
    pub silence: Silence,
    /// `None` when the app has no data folder: the silence only lasts until it quits.
    pub file: Option<PathBuf>,
}

impl Notices {
    pub fn open(file: Option<PathBuf>) -> Notices {
        let silence = file.as_deref().map(load_or_migrate).unwrap_or_default();
        Notices { detector: Detector::default(), machines: MachineAlertDetector::default(), clouds: CloudSessionDetector::default(), silence, file }
    }

    /// The notices of this read that pass the silence.
    pub fn read(&mut self, a: &Attention) -> Vec<Notice> {
        let new = self.detector.observe(a);
        self.silence.filter(new)
    }

    /// The machine notices of this read that pass the silence (#180).
    pub fn read_machines(&mut self, ms: &[machines::Machine]) -> Vec<Notice> {
        let new = self.machines.observe(ms);
        self.silence.filter(new)
    }

    /// The AWS session notices of this read that pass the silence (#277).
    pub fn read_clouds(&mut self, aws: &clouds::Aws, now_ms: u64, offset_s: i64) -> Vec<Notice> {
        let new = self.clouds.observe(aws, now_ms, offset_s);
        self.silence.filter(new)
    }

    /// The click on "Notificações". Returns the switch's new state.
    pub fn toggle(&mut self) -> bool {
        self.silence.enabled = !self.silence.enabled;
        self.save();
        self.silence.enabled
    }

    /// The notification's "Silenciar" action.
    pub fn silence_session(&mut self, session: &str) {
        if self.silence.sessions.insert(session.to_string()) {
            self.save();
        }
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        if let Err(err) = self.silence.save(file) {
            eprintln!("[ahrena-console] save {}: {err}", file.display());
        }
    }
}

/// The silence in `file`; when it does not exist yet, the one in `LEGACY_FILE` next to it, saved as
/// `file` and removed, so the switch and the silenced sessions survive the rename.
fn load_or_migrate(file: &Path) -> Silence {
    let legacy = file.with_file_name(LEGACY_FILE);
    if file.exists() || !legacy.exists() {
        return Silence::load(file);
    }
    let silence = Silence::load(&legacy);
    match silence.save(file) {
        Ok(()) => {
            let _ = std::fs::remove_file(&legacy);
        }
        Err(err) => eprintln!("[ahrena-console] migrate {}: {err}", legacy.display()),
    }
    silence
}

/// The session's detail screen in the core's `/ui`, where "Abrir" leads. Empty, "." or ".." do not
/// make a path segment: then, the `/ui`.
pub fn session_path(session: &str) -> String {
    if matches!(session, "" | "." | "..") {
        return "/ui".into();
    }
    format!("/ui/sessions/{}", http::encode(session))
}

/// The `local_…` the core's `POST /open/` accepts: `local_` and 8 to 64 of `[0-9a-fA-F-]`.
pub fn valid_local(local: &str) -> bool {
    let Some(rest) = local.strip_prefix("local_") else { return false };
    (8..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Where the JSON lives: in `AHRENA_CONSOLE_DATA_DIR`, if set, or in
/// the app's data folder. Only this file: the app's core always uses the app's data folder (core.rs).
pub fn file_path(app_data: Option<PathBuf>) -> Option<PathBuf> {
    let dir = crate::core::env_var("AHRENA_CONSOLE_DATA_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).or(app_data)?;
    Some(dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::menu::{ItemAttention, BLOCKED, IDLE};

    const IDLE_REASONS: [&str; 3] = ["turn_ended", "interrupted", "first_prompt"];

    fn item(session: &str, title: &str, reason: &str) -> AttentionItem {
        let idle = IDLE_REASONS.contains(&reason);
        AttentionItem {
            session: session.into(),
            title: title.into(),
            account: None,
            level: if idle { "your-turn" } else { "needs" }.into(),
            reason: reason.into(),
            short_reason: format!("curto de {reason}"),
            long_reason: format!("longo de {reason}"),
            minutes: 1,
            local: None,
            machine: None,
            attention: Some(ItemAttention { level: if idle { IDLE } else { BLOCKED }.into(), reason: reason.into() }),
        }
    }

    fn attention(items: Vec<AttentionItem>) -> Attention {
        Attention { cursor: None, total: items.len() as u64, active: 0, with_error: 0, items, blocked: None, idle: None, needs: None, your_turn: None }
    }

    fn sessions(notices: &[Notice]) -> Vec<&str> {
        notices.iter().map(|n| n.session.as_str()).collect()
    }

    /// A folder of this test alone in `temp_dir`, deleted at the end.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> TempDir {
            let p = std::env::temp_dir().join(format!("ahrena-console-test-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            TempDir(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn first_read_does_not_notify() {
        let mut d = Detector::default();
        assert!(d.observe(&attention(vec![item("s1", "a", "permission"), item("s2", "b", "error")])).is_empty());
    }

    #[test]
    fn entering_notifies_once() {
        let mut d = Detector::default();
        d.observe(&attention(vec![]));
        let list = attention(vec![item("s1", "a", "permission")]);
        assert_eq!(sessions(&d.observe(&list)), ["s1"]);
        assert!(d.observe(&list).is_empty(), "the repeated read does not notify");
        assert!(d.observe(&list).is_empty());
    }

    #[test]
    fn reason_change_notifies() {
        let mut d = Detector::default();
        d.observe(&attention(vec![item("s1", "a", "plan"), item("s2", "b", "question")]));
        let notices = d.observe(&attention(vec![item("s1", "a", "permission"), item("s2", "b", "question")]));
        assert_eq!(sessions(&notices), ["s1"]);
        assert_eq!(notices[0].title, "a pede permissão");
    }

    #[test]
    fn left_and_came_back_notifies() {
        let mut d = Detector::default();
        d.observe(&attention(vec![item("s1", "a", "permission")]));
        assert!(d.observe(&attention(vec![])).is_empty());
        assert_eq!(sessions(&d.observe(&attention(vec![item("s1", "a", "permission")]))), ["s1"]);
    }

    #[test]
    fn reconnection_does_not_notify() {
        let mut d = Detector::default();
        d.observe(&attention(vec![]));
        d.reset();
        assert!(d.observe(&attention(vec![item("s1", "a", "error")])).is_empty());
        assert_eq!(sessions(&d.observe(&attention(vec![item("s1", "a", "error"), item("s2", "b", "error")]))), ["s2"]);
    }

    #[test]
    fn every_session_notice_has_sound() {
        for r in ["permission", "question", "plan", "decision", "error"] {
            assert!(Notice::from_item(&item("s", "t", r)).sound, "{r}");
        }
    }

    #[test]
    fn idle_never_notifies() {
        let mut d = Detector::default();
        d.observe(&attention(vec![]));
        let idle: Vec<_> = IDLE_REASONS.iter().enumerate().map(|(n, r)| item(&format!("s{n}"), "a", r)).collect();
        assert!(d.observe(&attention(idle.clone())).is_empty(), "entering idle does not notify");
        let mut with_blocked = idle;
        with_blocked.push(item("s9", "b", "question"));
        assert_eq!(sessions(&d.observe(&attention(with_blocked))), ["s9"], "only the blocked one");
    }

    #[test]
    fn blocked_turning_idle_does_not_notify() {
        let mut d = Detector::default();
        d.observe(&attention(vec![item("s1", "a", "permission")]));
        assert!(d.observe(&attention(vec![item("s1", "a", "turn_ended")])).is_empty(), "blocked to idle");
        assert!(d.observe(&attention(vec![item("s1", "a", "interrupted")])).is_empty(), "idle to idle");
        assert_eq!(sessions(&d.observe(&attention(vec![item("s1", "a", "question")]))), ["s1"], "idle to blocked notifies");
    }

    #[test]
    fn error_notifies_like_blocked() {
        let mut d = Detector::default();
        d.observe(&attention(vec![item("s1", "a", "turn_ended")]));
        let notices = d.observe(&attention(vec![item("s1", "a", "error")]));
        assert_eq!(sessions(&notices), ["s1"]);
        assert_eq!(notices[0].title, "a parou com erro");
    }

    #[test]
    fn older_core_level_decides_who_notifies() {
        // A core from before #245: no `attention`, only `level`.
        const OLD: &str = r#"{ "cursor": "c1", "total": 2, "needs": 1, "yourTurn": 1, "active": 2, "withError": 0, "items": [
          { "session": "s1", "title": "a", "account": null, "level": "needs", "reason": "permission", "shortReason": "Pede permissão", "longReason": "pede permissão", "minutes": 1, "local": null },
          { "session": "s2", "title": "b", "account": null, "level": "your-turn", "reason": "your-turn", "shortReason": "Sua vez", "longReason": "terminou o turno", "minutes": 1, "local": null } ] }"#;
        let mut d = Detector::default();
        d.observe(&attention(vec![]));
        let a = Attention::from_json(OLD).unwrap();
        assert_eq!(sessions(&d.observe(&a)), ["s1"]);
    }

    #[test]
    fn a3_titles() {
        let a = |t: &str, r: &str| title(&item("s", t, r));
        assert_eq!(a("motor-de-regras", "permission"), "motor-de-regras pede permissão");
        assert_eq!(a("painel-de-metricas", "error"), "painel-de-metricas parou com erro");
        assert_eq!(a("x", "question"), "x fez uma pergunta");
        assert_eq!(a("x", "motivo-novo"), "x: curto de motivo-novo");
    }

    #[test]
    fn body_and_local() {
        let mut i = item("s1", "a", "permission");
        i.local = Some("local_1".into());
        let n = Notice::from_item(&i);
        assert_eq!((n.body.as_str(), n.local.as_deref()), ("longo de permission", Some("local_1")));
    }

    #[test]
    fn session_screen_path() {
        assert_eq!(session_path("c3f09b52"), "/ui/sessions/c3f09b52");
        assert_eq!(session_path("a:b/c"), "/ui/sessions/a%3Ab%2Fc");
        for empty in ["", ".", ".."] {
            assert_eq!(session_path(empty), "/ui", "{empty:?}");
        }
    }

    #[test]
    fn local_like_the_core() {
        assert!(valid_local("local_716ecd97-6a9b-4452-9770-e2c155279784"));
        assert!(valid_local("local_ABCDEF01"));
        assert!(valid_local(&format!("local_{}", "a".repeat(64))));
        assert!(!valid_local("local_1234567"), "fewer than 8");
        assert!(!valid_local(&format!("local_{}", "a".repeat(65))), "more than 64");
        assert!(!valid_local("local_1234567g"));
        assert!(!valid_local("local_12345678/../x"));
        assert!(!valid_local("remoto_12345678"));
        assert!(!valid_local(""));
    }

    #[test]
    fn global_silence() {
        let notices = vec![Notice::from_item(&item("s1", "a", "error"))];
        let s = Silence { enabled: false, ..Silence::default() };
        assert!(s.filter(notices.clone()).is_empty());
        assert_eq!(Silence::default().filter(notices.clone()), notices);
    }

    #[test]
    fn per_session_silence() {
        let notices = vec![Notice::from_item(&item("s1", "a", "error")), Notice::from_item(&item("s2", "b", "error"))];
        let mut s = Silence::default();
        s.sessions.insert("s1".into());
        assert_eq!(sessions(&s.filter(notices)), ["s2"]);
    }

    #[test]
    fn notices_read_and_filter() {
        let mut n = Notices::open(None);
        n.read(&attention(vec![]));
        n.silence_session("s1");
        assert_eq!(sessions(&n.read(&attention(vec![item("s1", "a", "error"), item("s2", "b", "error")]))), ["s2"]);
        assert!(!n.toggle());
        assert!(n.read(&attention(vec![item("s3", "c", "error")])).is_empty());
    }

    #[test]
    fn global_silence_does_not_stop_the_detector() {
        let p = TempDir::new("global-off");
        let mut n = Notices::open(Some(p.0.join(FILE)));
        n.read(&attention(vec![]));
        assert!(!n.toggle());
        assert!(n.read(&attention(vec![item("s1", "a", "error")])).is_empty(), "off does not notify");
        assert!(n.toggle());
        assert!(n.read(&attention(vec![item("s1", "a", "error")])).is_empty(), "turning back on does not notify who was already there");
    }

    #[test]
    fn persistence_round_trip() {
        let p = TempDir::new("round-trip");
        let file = p.0.join("sub").join(FILE);
        let mut n = Notices::open(Some(file.clone()));
        assert_eq!(n.silence, Silence::default());
        n.silence_session("s1");
        n.toggle();
        let read = Silence::load(&file);
        assert_eq!(read, Silence { enabled: false, sessions: ["s1".to_string()].into() });
        assert_eq!(Notices::open(Some(file.clone())).silence, read);
        assert!(!file.with_extension("json.tmp").exists());
    }

    // ---- #180: machine alerts ----

    fn alert(id: &str, kind: &str, message: &str, detail: Option<&str>) -> machines::Alert {
        machines::Alert { id: id.into(), kind: kind.into(), level: "error".into(), message: message.into(), detail: detail.map(Into::into), since: "2026-10-18T22:58:00.000Z".into() }
    }

    fn machine(id: &str, label: &str, state: &str, alerts: Option<Vec<machines::Alert>>) -> machines::Machine {
        machines::Machine {
            summary: machines::MachineSummary { id: id.into(), label: label.into(), state: state.into(), reason: None, port: Some(14720), last_read_at: None, reconnect: None },
            telemetry: alerts.map(|alerts| machines::Telemetry { current: None, alerts }),
        }
    }

    fn load() -> machines::Alert {
        alert("load-high", "load-high", "CPU saturada: carga de 24,6 em 16 núcleos", None)
    }

    fn down() -> machines::Alert {
        alert("machine-unreachable", "machine-unreachable", "Workstation sem conexão", Some("A porta 14720 deste Mac não aceita conexão: o túnel está caído"))
    }

    fn ids(notices: &[Notice]) -> Vec<&str> {
        notices.iter().map(|n| n.session.as_str()).collect()
    }

    #[test]
    fn criterion_5_first_read_of_machines_does_not_notify() {
        let mut d = MachineAlertDetector::default();
        assert!(d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]).is_empty());
    }

    #[test]
    fn criterion_5_new_alert_notifies_once_silently() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![]))]);
        let with = [machine("workstation", "Workstation", "connected", Some(vec![load()]))];
        let notices = d.observe(&with);
        assert_eq!(ids(&notices), ["machine:workstation:load-high"]);
        let n = &notices[0];
        assert_eq!((n.title.as_str(), n.body.as_str()), ("Workstation: CPU saturada", "CPU saturada: carga de 24,6 em 16 núcleos"));
        assert!(!n.sound, "machine notifications are silent");
        assert_eq!((n.path.as_str(), n.origin, n.local.as_deref()), ("/ui/machines/workstation", Origin::Machine, None));
        assert!(d.observe(&with).is_empty(), "the repeated read does not notify");
    }

    #[test]
    fn criterion_5_machine_going_down_notifies_once() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("local", "Esta máquina", "connected", Some(vec![])), machine("workstation", "Workstation", "connected", Some(vec![]))]);
        let gone = [machine("local", "Esta máquina", "connected", Some(vec![])), machine("workstation", "Workstation", "unreachable", Some(vec![down()]))];
        let notices = d.observe(&gone);
        assert_eq!(ids(&notices), ["machine:workstation:machine-unreachable"]);
        assert_eq!(notices[0].title, "Workstation sem conexão");
        assert_eq!(notices[0].body, "A porta 14720 deste Mac não aceita conexão: o túnel está caído");
        assert!(!notices[0].sound);
        assert!(d.observe(&gone).is_empty());
    }

    #[test]
    fn criterion_5_this_mac_is_named_este_mac() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("local", "Esta máquina", "connected", Some(vec![]))]);
        let notices = d.observe(&[machine("local", "Esta máquina", "connected", Some(vec![load()]))]);
        assert_eq!(notices[0].title, "Este Mac: CPU saturada");
        assert_eq!(notices[0].path, "/ui/machines/local");
    }

    #[test]
    fn criterion_5_a_telemetry_read_that_failed_does_not_renotify() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]);
        assert!(d.observe(&[machine("workstation", "Workstation", "connected", None)]).is_empty());
        assert!(d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]).is_empty(), "the alert never left");
    }

    #[test]
    fn criterion_5_rediscovery_does_not_notify() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![]))]);
        d.reset();
        assert!(d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]).is_empty());
    }

    #[test]
    fn criterion_5_respects_the_notifications_switch() {
        let mut n = Notices::open(None);
        n.read_machines(&[machine("workstation", "Workstation", "connected", Some(vec![]))]);
        assert!(!n.toggle());
        assert!(n.read_machines(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]).is_empty(), "off: nothing");
        assert!(n.toggle());
        let notices = n.read_machines(&[machine("workstation", "Workstation", "connected", Some(vec![load(), down()]))]);
        assert_eq!(ids(&notices), ["machine:workstation:machine-unreachable"], "turning back on does not notify what was already open");
    }

    fn configured(mut m: machines::Machine) -> machines::Machine {
        m.summary.reconnect = Some(machines::Reconnect { configured: true, state: Some("idle".into()), started_at: None });
        m
    }

    #[test]
    fn a8_unreachable_notice_offers_reconnect_only_when_configured() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[configured(machine("workstation", "Workstation", "connected", Some(vec![])))]);
        let notices = d.observe(&[configured(machine("workstation", "Workstation", "unreachable", Some(vec![down()])))]);
        let n = &notices[0];
        assert_eq!((n.title.as_str(), n.origin, n.machine.as_deref()), ("Workstation sem conexão", Origin::MachineReconnect, Some("workstation")));
        assert_eq!(n.origin.actions(), [Action::Reconnect, Action::Open], "Abrir stays");
        assert_eq!(n.path, "/ui/machines/workstation");

        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![]))]);
        let notices = d.observe(&[machine("workstation", "Workstation", "unreachable", Some(vec![down()]))]);
        assert_eq!(notices[0].origin, Origin::Machine, "without reconnect, as in A7");
        assert_eq!(notices[0].origin.actions(), [Action::Open]);
    }

    #[test]
    fn a8_other_machine_alerts_never_offer_reconnect() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[configured(machine("workstation", "Workstation", "connected", Some(vec![])))]);
        let notices = d.observe(&[configured(machine("workstation", "Workstation", "connected", Some(vec![load()])))]);
        assert_eq!(notices[0].origin, Origin::Machine);
    }

    fn remote(session: &str, title: &str, reason: &str) -> AttentionItem {
        AttentionItem { machine: Some(crate::menu::SessionMachine { id: "workstation".into(), label: "Workstation".into() }), ..item(session, title, reason) }
    }

    #[test]
    fn remote_session_title_carries_the_machine_label() {
        let n = Notice::from_item(&remote("s1", "motor-de-regras", "permission"));
        assert_eq!(n.title, "motor-de-regras · Workstation pede permissão");
        assert_eq!(title(&remote("s3", "fila-de-tarefas", "error")), "fila-de-tarefas · Workstation parou com erro");
    }

    #[test]
    fn remote_session_has_no_desktop_action() {
        let notice = Notice::from_item(&remote("s1", "motor-de-regras", "permission"));
        assert_eq!(notice.origin, Origin::RemoteSession);
        assert_eq!(notice.origin.actions(), [Action::Open, Action::Silence], "Silenciar stays, Abrir no Claude Desktop goes");
        assert_eq!((notice.path.as_str(), notice.session.as_str(), notice.local.as_deref()), ("/ui/sessions/s1", "s1", None), "the click opens the session screen");
        let mut n = Notices::open(None);
        n.read(&attention(vec![]));
        n.silence_session("s1");
        assert!(n.read(&attention(vec![remote("s1", "motor-de-regras", "permission")])).is_empty(), "Silenciar works as for a local session");
    }

    #[test]
    fn local_session_notice_is_unchanged() {
        let mut i = item("s1", "motor-de-regras", "permission");
        i.local = Some("local_00000000-0000-4000-8000-000000000001".into());
        let n = Notice::from_item(&i);
        assert_eq!(n.title, "motor-de-regras pede permissão");
        assert_eq!(n.origin, Origin::Session);
        assert_eq!(n.origin.actions(), [Action::Open, Action::OpenInDesktop, Action::Silence]);
        assert_eq!(Origin::Machine.actions(), [Action::Open]);
    }

    #[test]
    fn session_notices_open_the_session_screen() {
        let n = Notice::from_item(&item("c3f09b52", "a", "permission"));
        assert_eq!((n.path.as_str(), n.origin), ("/ui/sessions/c3f09b52", Origin::Session));
    }

    #[test]
    fn bad_or_missing_file_is_the_default() {
        let p = TempDir::new("bad");
        assert_eq!(Silence::load(&p.0.join(FILE)), Silence::default());
        std::fs::create_dir_all(&p.0).unwrap();
        let bad = p.0.join(FILE);
        std::fs::write(&bad, "não é json").unwrap();
        assert_eq!(Silence::load(&bad), Silence::default());
        std::fs::write(&bad, r#"{ "sessoes": ["s9"] }"#).unwrap();
        assert_eq!(Silence::load(&bad), Silence { enabled: true, sessions: ["s9".to_string()].into() });
    }

    #[test]
    fn saves_the_english_keys_and_reads_the_old_ones() {
        let p = TempDir::new("keys");
        let file = p.0.join(FILE);
        Silence { enabled: false, sessions: ["s1".to_string()].into() }.save(&file).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"enabled\"") && text.contains("\"sessions\""), "{text}");
        std::fs::write(&file, r#"{ "ligadas": false, "sessoes": ["s2"] }"#).unwrap();
        assert_eq!(Silence::load(&file), Silence { enabled: false, sessions: ["s2".to_string()].into() });
    }

    #[test]
    fn migrates_the_file_from_before_the_rename() {
        let p = TempDir::new("migrate");
        std::fs::create_dir_all(&p.0).unwrap();
        let legacy = p.0.join(LEGACY_FILE);
        std::fs::write(&legacy, r#"{ "ligadas": false, "sessoes": ["s1"] }"#).unwrap();
        let file = p.0.join(FILE);
        let n = Notices::open(Some(file.clone()));
        assert_eq!(n.silence, Silence { enabled: false, sessions: ["s1".to_string()].into() });
        assert!(file.exists() && !legacy.exists(), "saved under the new name, the old one removed");
        assert_eq!(Silence::load(&file), n.silence);
    }

    #[test]
    fn the_new_file_wins_over_the_old_one() {
        let p = TempDir::new("both");
        std::fs::create_dir_all(&p.0).unwrap();
        std::fs::write(p.0.join(LEGACY_FILE), r#"{ "ligadas": false }"#).unwrap();
        std::fs::write(p.0.join(FILE), r#"{ "enabled": true, "sessions": ["s3"] }"#).unwrap();
        assert_eq!(Notices::open(Some(p.0.join(FILE))).silence, Silence { enabled: true, sessions: ["s3".to_string()].into() });
    }

    // ---- #277: AWS sessions (A10) ----

    fn with_state(mut aws: clouds::Aws, name: &str, state: &str, expires_at: Option<&str>) -> clouds::Aws {
        let s = aws.sessions.iter_mut().find(|s| s.name == name).unwrap();
        s.state = state.into();
        s.expires_at = expires_at.map(String::from);
        aws
    }

    #[test]
    fn a10_first_read_of_the_clouds_does_not_notify() {
        let mut d = CloudSessionDetector::default();
        assert!(d.observe(&clouds::tests::a9(), clouds::tests::now(), 0).is_empty());
    }

    #[test]
    fn a10_expiring_notifies_once_silently_with_entrar_and_abrir() {
        let (mut d, now) = (CloudSessionDetector::default(), clouds::tests::now());
        let end = "2026-10-18T18:15:00.000Z";
        d.observe(&with_state(clouds::tests::a9(), "sessao-exemplo", "valid", Some(end)), now, 0);
        let expiring = with_state(clouds::tests::a9(), "sessao-exemplo", "expiring", Some(end));
        let notices = d.observe(&expiring, now, 0);
        assert_eq!(notices.len(), 1);
        let n = &notices[0];
        assert_eq!((n.title.as_str(), n.body.as_str()), ("Sessão da AWS expira em 15 min", "sessao-exemplo"));
        assert!(!n.sound, "cloud notifications are silent");
        assert_eq!((n.session.as_str(), n.path.as_str(), n.cloud_session.as_deref()), ("cloud:aws:sessao-exemplo", "/ui/connections", Some("sessao-exemplo")));
        assert_eq!(n.origin.actions(), [Action::CloudLogin, Action::Open]);
        assert!(d.observe(&expiring, now + 60_000, 0).is_empty(), "the repeated read does not notify");
        d.observe(&with_state(clouds::tests::a9(), "sessao-exemplo", "unknown", Some(end)), now, 0);
        assert!(d.observe(&expiring, now, 0).is_empty(), "once per session and token end, across a hiccup");
    }

    #[test]
    fn a10_expired_notifies_once_and_a_new_login_rearms() {
        let (mut d, now) = (CloudSessionDetector::default(), clouds::tests::now());
        let end = "2026-10-18T17:59:00.000Z";
        d.observe(&with_state(clouds::tests::a9(), "sessao-exemplo", "expiring", Some(end)), now, 0);
        let expired = with_state(clouds::tests::a9(), "sessao-exemplo", "expired", Some(end));
        let notices = d.observe(&expired, now, -3 * 3_600);
        assert_eq!(notices.len(), 1);
        assert_eq!((notices[0].title.as_str(), notices[0].body.as_str()), ("Sessão da AWS expirada", "sessao-exemplo expirou às 14:59"));
        assert_eq!(notices[0].origin.actions(), [Action::CloudLogin, Action::Open]);
        assert!(d.observe(&expired, now, 0).is_empty());
        let new_end = "2026-10-19T02:00:00.000Z";
        d.observe(&with_state(clouds::tests::a9(), "sessao-exemplo", "valid", Some(new_end)), now, 0);
        let again = d.observe(&with_state(clouds::tests::a9(), "sessao-exemplo", "expiring", Some(new_end)), now, 0);
        assert_eq!(again.len(), 1, "a new token end notifies again");
    }

    #[test]
    fn a10_session_without_login_only_opens() {
        let (mut d, now) = (CloudSessionDetector::default(), clouds::tests::now());
        let mut aws = clouds::tests::a9();
        aws.sessions.retain(|s| s.name == "sessao com espaco");
        aws.sessions[0].state = "valid".into();
        d.observe(&aws, now, 0);
        aws.sessions[0].state = "expired".into();
        let notices = d.observe(&aws, now, 0);
        assert_eq!((notices[0].body.as_str(), notices[0].origin), ("sessao com espaco expirou", Origin::Cloud));
        assert_eq!(Origin::Cloud.actions(), [Action::Open]);
    }

    #[test]
    fn a10_respects_the_notifications_switch_and_never_entering_does_not_notify() {
        let now = clouds::tests::now();
        let mut n = Notices::default();
        n.read_clouds(&with_state(clouds::tests::a9(), "sessao-nova", "never", None), now, 0);
        assert!(n.read_clouds(&with_state(clouds::tests::a9(), "sessao-nova", "valid", Some("2026-10-18T20:00:00.000Z")), now, 0).is_empty());
        n.silence.enabled = false;
        assert!(n.read_clouds(&with_state(clouds::tests::a9(), "sessao-nova", "expiring", Some("2026-10-18T18:10:00.000Z")), now, 0).is_empty());
    }
}
