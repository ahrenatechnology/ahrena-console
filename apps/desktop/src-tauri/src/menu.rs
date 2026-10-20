// The tray menu as data, built from the JSON of `GET /api/attention` and the core's state.
//
// Kept apart from Tauri so it is tested without opening the app: `build` returns the list of items
// in the order of wireframes A1 (nobody waiting), A2 (3 waiting) and A4 (core stopped), and
// `main.rs` only translates it into the native menu.
//
// #180 adds the "Máquinas" block of A6 and A7 (machines.rs) and the remote sessions' label (A2).
// #244 adds, under an unreachable remote, Reconectar, its running line and the way to set it up (A8).

use serde::Deserialize;

use crate::machines;

/// One item of `GET /api/attention` (packages/nucleo/src/api/attention-route.ts). The keys are in
/// English (#173 phase 2b); the `alias` also reads those of an older core, which the app may adopt
/// (its `/api/overview` still answers with `nome`, core.rs), and `from_json` maps its values to
/// the new ones.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AttentionItem {
    #[serde(alias = "sessao")]
    pub session: String,
    #[serde(alias = "titulo")]
    pub title: String,
    #[serde(alias = "conta")]
    pub account: Option<Account>,
    /// `needs` (the session is blocked) or `your-turn` (idle): the level from before #245, which
    /// `from_json` turns into `attention` when the core does not send it.
    #[serde(alias = "nivel")]
    pub level: String,
    #[serde(alias = "motivo")]
    pub reason: String,
    #[serde(rename = "shortReason", alias = "motivoCurto")]
    pub short_reason: String,
    #[serde(rename = "longReason", alias = "motivoLongo")]
    pub long_reason: String,
    #[serde(alias = "minutos")]
    pub minutes: u64,
    pub local: Option<String>,
    /// The remote machine the session runs on (#176); `None` for this machine and for a core
    /// from before the remote machines.
    #[serde(default)]
    pub machine: Option<SessionMachine>,
    /// #245: `blocked` (it waits on you or stopped on an error) or `idle` (the turn ended and nothing
    /// blocks it). A core from before #245 does not send it: `from_json` derives it from `level`.
    #[serde(default)]
    pub attention: Option<ItemAttention>,
}

impl AttentionItem {
    /// Needs you (#245): the only sessions that get a menu item, the bar's number and a notice.
    pub fn is_blocked(&self) -> bool {
        self.attention.as_ref().is_some_and(|a| a.level == BLOCKED)
    }

    #[cfg(test)]
    pub fn is_idle(&self) -> bool {
        self.attention.as_ref().is_some_and(|a| a.level == IDLE)
    }
}

/// `attention: { level, reason }` of an item (#245).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ItemAttention {
    /// `blocked` or `idle`.
    pub level: String,
    /// `permission`, `question`, `plan`, `decision`, `error` (blocked); `turn_ended`, `interrupted`,
    /// `first_prompt` (idle).
    pub reason: String,
}

pub const BLOCKED: &str = "blocked";
pub const IDLE: &str = "idle";

/// `machine: { id, label }` of a remote session in `/api/attention`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SessionMachine {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Account {
    #[serde(alias = "rotulo")]
    pub label: String,
    #[serde(alias = "cor")]
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Attention {
    pub cursor: Option<String>,
    pub total: u64,
    #[serde(alias = "ativas")]
    pub active: u64,
    #[serde(rename = "withError", alias = "comErro")]
    pub with_error: u64,
    #[serde(alias = "itens")]
    pub items: Vec<AttentionItem>,
    /// #245: the sessions that need you, the bar's number. A core from before #245 does not send
    /// it: `from_json` fills it from `needs` or from the items.
    #[serde(default)]
    pub blocked: Option<u64>,
    /// #245: the idle sessions, only a grey count in the menu. Filled like `blocked`.
    #[serde(default)]
    pub idle: Option<u64>,
    /// The counts from before #245 (`blocked` and `idle` under their old names).
    #[serde(default, alias = "precisam")]
    pub needs: Option<u64>,
    #[serde(default, rename = "yourTurn", alias = "suaVez")]
    pub your_turn: Option<u64>,
}

impl Attention {
    pub fn from_json(text: &str) -> Option<Attention> {
        let mut a: Attention = serde_json::from_str(text).ok()?;
        for i in &mut a.items {
            if let Some(new) = english_level(&i.level) {
                i.level = new.to_owned();
            }
            if let Some(new) = english_reason(&i.reason) {
                i.reason = new.to_owned();
            }
            if i.attention.is_none() {
                i.attention = attention_from_level(&i.level, &i.reason);
            }
        }
        let count = |level: &str| a.items.iter().filter(|i| i.attention.as_ref().is_some_and(|x| x.level == level)).count() as u64;
        if a.blocked.is_none() {
            a.blocked = Some(a.needs.unwrap_or_else(|| count(BLOCKED)));
        }
        if a.idle.is_none() {
            a.idle = Some(a.your_turn.unwrap_or_else(|| count(IDLE)));
        }
        Some(a)
    }

    /// The sessions that need you, whoever waits the longest first (#245): the menu list and the
    /// notices. The idle ones are left out.
    pub fn blocked_items(&self) -> Vec<&AttentionItem> {
        let mut items: Vec<&AttentionItem> = self.items.iter().filter(|i| i.is_blocked()).collect();
        items.sort_by_key(|i| std::cmp::Reverse(i.minutes));
        items
    }

    pub fn blocked_count(&self) -> u64 {
        self.blocked.unwrap_or_default()
    }

    pub fn idle_count(&self) -> u64 {
        self.idle.unwrap_or_default()
    }
}

/// The #245 attention of an item from a core that only sends `level`: `needs` is blocked and
/// `your-turn` idle, with the reason in the #245 names. `None` for an unknown level.
fn attention_from_level(level: &str, reason: &str) -> Option<ItemAttention> {
    let level = match level {
        "needs" => BLOCKED,
        "your-turn" => IDLE,
        _ => return None,
    };
    let reason = match reason {
        "your-turn" => "turn_ended",
        "no-prompt" => "first_prompt",
        r => r,
    };
    Some(ItemAttention { level: level.into(), reason: reason.into() })
}

/// The `nivel` of a core from before #173 (phase 2b) as the new value; `None` if it already is.
fn english_level(level: &str) -> Option<&'static str> {
    match level {
        "precisa" => Some("needs"),
        "sua-vez" => Some("your-turn"),
        _ => None,
    }
}

/// The `motivo` of a core from before #173 (phase 2b) as the new value; `None` if it already is
/// (`no-prompt` did not change).
fn english_reason(reason: &str) -> Option<&'static str> {
    match reason {
        "permissao" => Some("permission"),
        "pergunta" => Some("question"),
        "plano" => Some("plan"),
        "decisao" => Some("decision"),
        "erro" => Some("error"),
        "sua-vez" => Some("your-turn"),
        "interrompida" => Some("interrupted"),
        _ => None,
    }
}

/// The core as the tray sees it.
#[derive(Debug, Clone, PartialEq)]
pub enum CoreState {
    /// On opening and on "Procurar o núcleo de novo", until the core is adopted or started.
    Searching,
    Up { port: u16 },
    /// `no_node`: nobody started the core and there is no Node on the login PATH (A4).
    Stopped { reason: String, no_node: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dot {
    Green,
    Red,
    Yellow,
    Orange,
    Empty,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    /// A grey line, with no action.
    Text { text: String, dot: Option<Dot> },
    /// Indented grey text, under an item with a dot.
    Detail(String),
    /// A section header; with ⌥, it becomes `alternate`.
    Header { text: String, alternate: String },
    /// A session. The click opens it in Claude Desktop through `local`; with ⌥, the `alternate`
    /// item. A remote session (#180) has no alternate: this Mac's Claude Desktop does not know it.
    Session { id: String, text: String, alternate: Option<String>, dot: Dot, tooltip: String, local: Option<String> },
    /// A machine row or one of its open alerts (#180): the click opens the window at
    /// `/ui/machines/<id>`.
    Machine { id: String, text: String, dot: Dot },
    /// Indented, with no dot, under a machine row (#244, A8): the click opens the window at
    /// `/ui/machines/<id>`, like the row ("Como reconectar daqui…").
    MachineLink { id: String, text: String },
    /// "Reconectar a <label>" (#244, A8): the click asks the core to run the machine's reconnect
    /// command (`POST /api/machines/<id>/reconnect`). Indented, with no dot.
    Reconnect { id: String, text: String },
    Action { id: &'static str, text: String, shortcut: Option<&'static str> },
    Check { id: &'static str, text: &'static str, checked: bool },
    Separator,
}

pub struct Input<'a> {
    pub core: &'a CoreState,
    pub attention: Option<&'a Attention>,
    /// The core that is up has no `/api/attention` (one from before #87).
    pub no_attention: bool,
    pub notifications: bool,
    pub login: bool,
    pub version: &'a str,
    /// The new version the updater found and that is not installed yet.
    pub update: Option<&'a str>,
    /// The machines of `/api/machines` (#180); `None` when the core has no telemetry (404).
    pub machines: Option<&'a [machines::Machine]>,
    /// Now, in ms since the epoch: the age of an unreachable machine and of an alert.
    pub now_ms: u64,
}

pub const ID_OPEN: &str = "open";
pub const ID_NOTIFICATIONS: &str = "notifications";
pub const ID_LOGIN: &str = "login";
pub const ID_QUIT: &str = "quit";
pub const ID_INSTALL_NODE: &str = "install-node";
pub const ID_SEARCH_AGAIN: &str = "search-again";
pub const ID_UPDATE: &str = "update";
/// Prefixes of the session ids: the main item and the alternate one (⌥).
pub const SESSION: &str = "session:";
pub const SESSION_IN_DESKTOP: &str = "desktop:";
/// Prefix of the ids of the machine rows and alerts (#180).
pub const MACHINE: &str = "machine:";
/// Prefix of the ids of the "Reconectar a <label>" items (#244).
pub const RECONNECT: &str = "reconnect:";

/// The number next to the icon: only the sessions that need you (blocked or with an error, #245);
/// the idle ones never count. Zero or a stopped core: only the icon.
pub fn tray_title(core: &CoreState, attention: Option<&Attention>) -> Option<String> {
    match (core, attention) {
        (CoreState::Up { .. }, Some(a)) if a.blocked_count() > 0 => Some(a.blocked_count().to_string()),
        _ => None,
    }
}

pub fn elapsed(minutes: u64) -> String {
    match minutes {
        0 => "agora".into(),
        m if m < 60 => format!("{m} min"),
        m if m < 60 * 24 => format!("{} h", m / 60),
        m => format!("{} d", m / (60 * 24)),
    }
}

fn session_dot(i: &AttentionItem) -> Dot {
    if i.reason == "error" {
        Dot::Red
    } else {
        Dot::Yellow
    }
}

pub fn build(input: &Input) -> Vec<Item> {
    let mut m = vec![Item::Text { text: "Ahrena Console".into(), dot: None }];
    match input.core {
        CoreState::Up { port } => {
            m.push(Item::Text { text: format!("Núcleo de pé · 127.0.0.1:{port}"), dot: Some(Dot::Green) });
            m.push(Item::Separator);
            if input.no_attention && input.attention.is_none() {
                m.push(Item::Detail("Este núcleo não lista quem precisa de você: atualize-o".into()));
            } else {
                let block = input.machines.map(|ms| machines_block(ms, input.now_ms)).unwrap_or_default();
                sessions(&mut m, input.attention, block);
            }
        }
        CoreState::Searching => {
            m.push(Item::Text { text: "Procurando o núcleo…".into(), dot: None });
        }
        CoreState::Stopped { reason, no_node } => {
            m.push(Item::Text { text: "Núcleo parado".into(), dot: Some(Dot::Red) });
            m.push(Item::Detail(reason.clone()));
            m.push(Item::Separator);
            if *no_node {
                m.push(Item::Action { id: ID_INSTALL_NODE, text: "Como instalar o Node 24".into(), shortcut: None });
            }
            m.push(Item::Action { id: ID_SEARCH_AGAIN, text: "Procurar o núcleo de novo".into(), shortcut: None });
        }
    }
    m.push(Item::Separator);
    m.push(Item::Action { id: ID_OPEN, text: "Abrir o console".into(), shortcut: Some("CmdOrCtrl+O") });
    m.push(Item::Check { id: ID_NOTIFICATIONS, text: "Notificações", checked: input.notifications });
    m.push(Item::Check { id: ID_LOGIN, text: "Abrir no login", checked: input.login });
    m.push(Item::Separator);
    m.push(Item::Text { text: format!("Ahrena Console {}", input.version), dot: None });
    if let Some(new) = input.update {
        m.push(Item::Action { id: ID_UPDATE, text: format!("Atualizar para a versão {new}"), shortcut: None });
    }
    m.push(Item::Action { id: ID_QUIT, text: "Sair do Ahrena Console".into(), shortcut: Some("CmdOrCtrl+Q") });
    m
}

/// `machines`: the "Máquinas" block (A6, A7), empty when there is nothing to show. It goes between
/// the "precisam de você" list and the active count; in A1 (nobody waiting), after the three lines.
fn sessions(m: &mut Vec<Item>, attention: Option<&Attention>, machines: Vec<Item>) {
    let Some(a) = attention else {
        m.push(Item::Text { text: "Lendo as sessões…".into(), dot: None });
        return;
    };
    let blocked = a.blocked_items();
    if blocked.is_empty() {
        // A1: one item per dot (the native menu does not put two on one line). With the list
        // empty there is no session with an error: one would be in the list.
        m.push(Item::Text { text: "Ninguém precisa de você".into(), dot: Some(Dot::Empty) });
        summary(m, a);
        m.push(Item::Text { text: "nenhuma com erro".into(), dot: Some(Dot::Red) });
        if !machines.is_empty() {
            m.push(Item::Separator);
            m.extend(machines);
        }
        return;
    }
    let n = blocked.len();
    let who = if n == 1 { "1 precisa de você".to_string() } else { format!("{n} precisam de você") };
    m.push(Item::Header { text: format!("{who} · abrir na janela"), alternate: format!("{who} · abrir no Claude Desktop") });
    for i in blocked {
        let account = i.account.as_ref().map(|c| c.label.as_str()).unwrap_or("Sem conta");
        let (text, alternate) = match &i.machine {
            Some(machine) => (format!("{} · {} · {} · {}", i.title, machine.label, i.short_reason, elapsed(i.minutes)), None),
            None => (format!("{} · {} · {}", i.title, i.short_reason, elapsed(i.minutes)), Some(format!("{} · Abrir no Claude Desktop", i.title))),
        };
        m.push(Item::Session {
            id: i.session.clone(),
            text,
            alternate,
            dot: session_dot(i),
            tooltip: format!("{account} · {}", i.long_reason),
            local: i.local.clone(),
        });
    }
    m.push(Item::Separator);
    if !machines.is_empty() {
        m.extend(machines);
        m.push(Item::Separator);
    }
    summary(m, a);
}

/// The summary: the active count and, when there are idle sessions, their grey count with the
/// hollow dot (#245), with no item to click and no number in the bar.
fn summary(m: &mut Vec<Item>, a: &Attention) {
    m.push(Item::Text { text: active_count(a.active), dot: Some(Dot::Orange) });
    match a.idle_count() {
        0 => {}
        1 => m.push(Item::Text { text: "1 ociosa".into(), dot: Some(Dot::Empty) }),
        n => m.push(Item::Text { text: format!("{n} ociosas"), dot: Some(Dot::Empty) }),
    }
}

/// The "Máquinas" block (A6, A7): a header, one row per machine and one item per open alert of a
/// connected machine. Empty without machines to show, so a core without telemetry shows no block.
fn machines_block(ms: &[machines::Machine], now_ms: u64) -> Vec<Item> {
    let mut b = Vec::new();
    for x in ms.iter().filter(|x| x.summary.state != "not-configured") {
        let s = &x.summary;
        let label = machines::display_label(s);
        let row = |text: String, dot: Dot| Item::Machine { id: s.id.clone(), text, dot };
        let reading = x.telemetry.as_ref().and_then(|t| t.current.as_ref());
        match s.state.as_str() {
            "unreachable" if s.reconnect_running() => {
                // A8 b: one at a time, so the item becomes a grey line with the count, no click.
                b.push(row(format!("{label} · reconectando"), Dot::Yellow));
                let time = s.reconnect.as_ref().and_then(|r| r.started_at.as_deref()).and_then(|t| machines::running_for(t, now_ms));
                b.push(Item::Detail(match time {
                    Some(t) => format!("Reconectando… aguardando login · {t}"),
                    None => "Reconectando… aguardando login".into(),
                }));
            }
            "unreachable" => {
                let age = s.last_read_at.as_deref().and_then(|t| machines::minutes_since(t, now_ms));
                let since = age.map(|m| format!("sem conexão {}", machines::ago(m))).unwrap_or_else(|| "sem conexão".into());
                b.push(row(format!("{label} · {since}"), Dot::Empty));
                if let Some(reason) = machines::unreachable_reason(s) {
                    b.push(Item::Detail(reason));
                }
                // A8 a and c: Reconectar with a command in machines.json; without one, the way to
                // set it up, on the machine's screen (C50, state 5), instead of a dead button.
                if s.id != machines::LOCAL_ID {
                    if s.reconnect_configured() {
                        b.push(Item::Reconnect { id: s.id.clone(), text: format!("Reconectar a {label}") });
                    } else {
                        b.push(Item::MachineLink { id: s.id.clone(), text: "Como reconectar daqui…".into() });
                    }
                }
            }
            "incompatible-version" => b.push(row(format!("{label} · versão incompatível do núcleo"), Dot::Empty)),
            _ => {
                let figures = reading.map(machines::figures).unwrap_or_default();
                b.push(row(if figures.is_empty() { label.to_string() } else { format!("{label} · {figures}") }, Dot::Green));
                for a in x.telemetry.iter().flat_map(|t| &t.alerts).filter(|a| a.kind != machines::UNREACHABLE_KIND) {
                    let dot = if a.level == "error" { Dot::Red } else { Dot::Yellow };
                    b.push(row(format!("{} · {label}", machines::alert_text(a, reading, now_ms)), dot));
                }
            }
        }
    }
    if !b.is_empty() {
        b.insert(0, Item::Text { text: "Máquinas".into(), dot: None });
    }
    b
}

fn active_count(n: u64) -> String {
    if n == 1 {
        "1 ativa".into()
    } else {
        format!("{n} ativas")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The JSON of `/api/attention` (#245), in the route's format (extra fields are ignored), in the
    // core's order (the error after the other blocked ones, the idle ones last): wireframe A2, three
    // that need you and two idle.
    const THREE: &str = r##"{
      "generatedAt": "2026-10-18T23:10:00.000Z", "cursor": "c42", "total": 5, "needs": 3, "yourTurn": 2, "blocked": 3, "idle": 2,
      "active": 4, "withError": 1,
      "items": [
        { "session": "s4", "title": "agenda-ficticia", "project": null, "account": { "label": "equipe", "color": "#f47c20" },
          "level": "needs", "reason": "plan", "attention": { "level": "blocked", "reason": "plan" }, "shortReason": "Plano para aprovar",
          "longReason": "tem um plano para aprovar", "since": "2026-10-18T23:03:00.000Z", "minutes": 7, "local": null },
        { "session": "s1", "title": "motor-de-regras", "project": null, "account": { "label": "equipe", "color": "#f47c20" },
          "level": "needs", "reason": "permission", "attention": { "level": "blocked", "reason": "permission" }, "shortReason": "Pede permissão",
          "longReason": "pede permissão para usar Bash", "since": "2026-10-18T23:08:00.000Z", "minutes": 2, "local": "local_00000000-0000-4000-8000-000000000001" },
        { "session": "s2", "title": "painel-de-metricas", "project": null, "account": null,
          "level": "needs", "reason": "error", "attention": { "level": "blocked", "reason": "error" }, "shortReason": "Com erro",
          "longReason": "parou num erro", "since": "2026-10-18T23:07:00.000Z", "minutes": 3, "local": null },
        { "session": "s3", "title": "fila-de-tarefas", "project": null, "account": { "label": "cliente", "color": "#3b82f6" },
          "level": "your-turn", "reason": "your-turn", "attention": { "level": "idle", "reason": "turn_ended" }, "shortReason": "Sua vez",
          "longReason": "terminou o turno, sua vez", "since": "2026-10-18T23:09:00.000Z", "minutes": 1, "local": null },
        { "session": "s5", "title": "catalogo-exemplo", "project": null, "account": null,
          "level": "your-turn", "reason": "interrupted", "attention": { "level": "idle", "reason": "interrupted" }, "shortReason": "Interrompida",
          "longReason": "foi interrompida", "since": "2026-10-18T23:00:00.000Z", "minutes": 10, "local": null }
      ]
    }"##;

    const ZERO: &str = r#"{ "cursor": "c1", "total": 0, "needs": 0, "yourTurn": 0, "blocked": 0, "idle": 0, "active": 4, "withError": 0, "items": [] }"#;

    /// A1 with idle sessions (#245): nobody needs you, two idle.
    const ONLY_IDLE: &str = r##"{
      "cursor": "c2", "total": 2, "needs": 0, "yourTurn": 2, "blocked": 0, "idle": 2, "active": 4, "withError": 0,
      "items": [
        { "session": "s3", "title": "fila-de-tarefas", "account": null, "level": "your-turn", "reason": "your-turn",
          "attention": { "level": "idle", "reason": "turn_ended" }, "shortReason": "Sua vez", "longReason": "terminou o turno", "minutes": 1, "local": null },
        { "session": "s6", "title": "nova", "account": null, "level": "your-turn", "reason": "no-prompt",
          "attention": { "level": "idle", "reason": "first_prompt" }, "shortReason": "No prompt", "longReason": "sessão nova", "minutes": 4, "local": null }
      ]
    }"##;

    fn input<'a>(core: &'a CoreState, attention: Option<&'a Attention>) -> Input<'a> {
        Input { core, attention, no_attention: false, notifications: true, login: false, version: "0.0.1", update: None, machines: None, now_ms: 0 }
    }

    fn texts(m: &[Item]) -> Vec<String> {
        m.iter()
            .map(|i| match i {
                Item::Text { text, .. } | Item::Header { text, .. } | Item::Session { text, .. } | Item::Action { text, .. } | Item::Machine { text, .. } => text.clone(),
                Item::MachineLink { text, .. } | Item::Reconnect { text, .. } => format!("  {text}"),
                Item::Detail(t) => format!("  {t}"),
                Item::Check { text, checked, .. } => format!("{}{text}", if *checked { "✓ " } else { "" }),
                Item::Separator => "—".into(),
            })
            .collect()
    }

    #[test]
    fn a2_three_waiting() {
        let a = Attention::from_json(THREE).unwrap();
        let n = CoreState::Up { port: 4720 };
        let m = build(&input(&n, Some(&a)));
        assert_eq!(
            texts(&m),
            [
                "Ahrena Console",
                "Núcleo de pé · 127.0.0.1:4720",
                "—",
                "3 precisam de você · abrir na janela",
                "agenda-ficticia · Plano para aprovar · 7 min",
                "painel-de-metricas · Com erro · 3 min",
                "motor-de-regras · Pede permissão · 2 min",
                "—",
                "4 ativas",
                "2 ociosas",
                "—",
                "Abrir o console",
                "✓ Notificações",
                "Abrir no login",
                "—",
                "Ahrena Console 0.0.1",
                "Sair do Ahrena Console",
            ]
        );
        assert_eq!(tray_title(&n, Some(&a)).as_deref(), Some("3"), "only the blocked ones; the 2 idle do not count");
        let idle = m.iter().find(|i| matches!(i, Item::Text { text, .. } if text == "2 ociosas"));
        assert_eq!(idle, Some(&Item::Text { text: "2 ociosas".into(), dot: Some(Dot::Empty) }), "grey, hollow dot, no action");
        assert!(!m.iter().any(|i| matches!(i, Item::Session { id, .. } if id == "s3" || id == "s5")), "no item for an idle session");
    }

    #[test]
    fn a1_idle_only_in_the_summary() {
        let a = Attention::from_json(ONLY_IDLE).unwrap();
        let n = CoreState::Up { port: 4720 };
        let m = build(&input(&n, Some(&a)));
        assert_eq!(&texts(&m)[..8], ["Ahrena Console", "Núcleo de pé · 127.0.0.1:4720", "—", "Ninguém precisa de você", "4 ativas", "2 ociosas", "nenhuma com erro", "—"]);
        let dots: Vec<_> = m[3..7].iter().map(|i| if let Item::Text { dot, .. } = i { *dot } else { None }).collect();
        assert_eq!(dots, [Some(Dot::Empty), Some(Dot::Orange), Some(Dot::Empty), Some(Dot::Red)]);
        assert_eq!(tray_title(&n, Some(&a)), None, "idle sessions never put a number in the bar");
        assert!(!m.iter().any(|i| matches!(i, Item::Session { .. } | Item::Header { .. })));
    }

    #[test]
    fn error_counts_as_blocked() {
        let a = Attention::from_json(THREE).unwrap();
        let e = a.items.iter().find(|i| i.session == "s2").unwrap();
        assert!(e.is_blocked());
        assert_eq!(session_dot(e), Dot::Red);
        assert!(a.blocked_items().iter().any(|i| i.session == "s2"));
        assert_eq!(a.blocked_count(), 3);
    }

    #[test]
    fn a2_alternates_dots_and_account() {
        let a = Attention::from_json(THREE).unwrap();
        let n = CoreState::Up { port: 4720 };
        let m = build(&input(&n, Some(&a)));
        let Item::Header { alternate, .. } = &m[3] else { panic!("header") };
        assert_eq!(alternate, "3 precisam de você · abrir no Claude Desktop");
        let sessions: Vec<_> = m
            .iter()
            .filter_map(|i| match i {
                Item::Session { alternate, dot, tooltip, local, .. } => Some((alternate.as_deref().unwrap_or(""), *dot, tooltip.as_str(), local.is_some())),
                _ => None,
            })
            .collect();
        assert_eq!(
            sessions,
            [
                ("agenda-ficticia · Abrir no Claude Desktop", Dot::Yellow, "equipe · tem um plano para aprovar", false),
                ("painel-de-metricas · Abrir no Claude Desktop", Dot::Red, "Sem conta · parou num erro", false),
                ("motor-de-regras · Abrir no Claude Desktop", Dot::Yellow, "equipe · pede permissão para usar Bash", true),
            ]
        );
    }

    #[test]
    fn a1_nobody_waiting() {
        let a = Attention::from_json(ZERO).unwrap();
        let n = CoreState::Up { port: 4720 };
        let m = build(&input(&n, Some(&a)));
        assert_eq!(&texts(&m)[..7], ["Ahrena Console", "Núcleo de pé · 127.0.0.1:4720", "—", "Ninguém precisa de você", "4 ativas", "nenhuma com erro", "—"]);
        let dots: Vec<_> = m[3..6].iter().map(|i| if let Item::Text { dot, .. } = i { *dot } else { None }).collect();
        assert_eq!(dots, [Some(Dot::Empty), Some(Dot::Orange), Some(Dot::Red)]);
        assert_eq!(tray_title(&n, Some(&a)), None);
    }

    #[test]
    fn a4_core_stopped_without_node() {
        let n = CoreState::Stopped { reason: "Node não encontrado no PATH do login".into(), no_node: true };
        let m = build(&input(&n, None));
        assert_eq!(
            &texts(&m)[..7],
            ["Ahrena Console", "Núcleo parado", "  Node não encontrado no PATH do login", "—", "Como instalar o Node 24", "Procurar o núcleo de novo", "—"]
        );
        assert_eq!(tray_title(&n, None), None);
    }

    #[test]
    fn stopped_with_node_does_not_offer_to_install() {
        let n = CoreState::Stopped { reason: "O núcleo não respondeu".into(), no_node: false };
        let m = build(&input(&n, None));
        assert!(!texts(&m).iter().any(|t| t.contains("instalar")));
        assert!(texts(&m).iter().any(|t| t == "Procurar o núcleo de novo"));
    }

    #[test]
    fn singular_and_elapsed() {
        let mut a = Attention::from_json(THREE).unwrap();
        a.items.truncate(1);
        a.total = 1;
        a.blocked = Some(1);
        a.idle = Some(1);
        a.active = 1;
        let n = CoreState::Up { port: 4720 };
        let t = texts(&build(&input(&n, Some(&a))));
        assert!(t.contains(&"1 precisa de você · abrir na janela".to_string()));
        assert!(t.contains(&"1 ativa".to_string()));
        assert!(t.contains(&"1 ociosa".to_string()));
        assert_eq!([elapsed(0), elapsed(59), elapsed(60), elapsed(150), elapsed(60 * 24 * 2)], ["agora", "59 min", "1 h", "2 h", "2 d"]);
    }

    #[test]
    fn core_without_the_route() {
        let n = CoreState::Up { port: 4720 };
        let m = build(&Input { no_attention: true, ..input(&n, None) });
        assert_eq!(&texts(&m)[..5], ["Ahrena Console", "Núcleo de pé · 127.0.0.1:4720", "—", "  Este núcleo não lista quem precisa de você: atualize-o", "—"]);
    }

    #[test]
    fn searching() {
        let n = CoreState::Searching;
        let m = build(&input(&n, None));
        assert_eq!(&texts(&m)[..4], ["Ahrena Console", "Procurando o núcleo…", "—", "Abrir o console"]);
    }

    #[test]
    fn update_right_below_the_version() {
        let n = CoreState::Up { port: 4720 };
        let without = texts(&build(&input(&n, None)));
        assert!(!without.iter().any(|t| t.starts_with("Atualizar")));
        let m = build(&Input { update: Some("0.0.2"), ..input(&n, None) });
        let t = texts(&m);
        assert_eq!(&t[t.len() - 4..], ["—", "Ahrena Console 0.0.1", "Atualizar para a versão 0.0.2", "Sair do Ahrena Console"]);
        assert!(m.iter().any(|i| matches!(i, Item::Action { id: ID_UPDATE, .. })));
    }

    // ---- #180: the "Máquinas" block (wireframes A6 and A7) ----

    /// 2026-10-18T23:10:00Z, the wireframes' clock.
    const NOW_MS: u64 = 1_792_365_000_000;

    /// A6: two of the three sessions that need you on the remote Workstation (`machine` set,
    /// `local: null`), and two idle ones. In the format of a core from before #245 (no `attention`,
    /// no `blocked`/`idle`): the tray derives them from `level` and `needs`/`yourTurn`.
    const REMOTE_THREE: &str = r##"{
      "cursor": "c43", "total": 5, "needs": 3, "yourTurn": 2, "active": 4, "withError": 1,
      "items": [
        { "session": "s1", "title": "motor-de-regras", "project": null, "account": { "label": "equipe", "color": "#f47c20" },
          "level": "needs", "reason": "permission", "shortReason": "Pede permissão", "longReason": "pede permissão para usar Bash",
          "since": "2026-10-18T23:08:00.000Z", "minutes": 2, "local": null, "machine": { "id": "workstation", "label": "Workstation" } },
        { "session": "s2", "title": "painel-de-metricas", "project": null, "account": null,
          "level": "needs", "reason": "error", "shortReason": "Com erro", "longReason": "parou num erro",
          "since": "2026-10-18T23:07:00.000Z", "minutes": 3, "local": null, "machine": { "id": "workstation", "label": "Workstation" } },
        { "session": "s4", "title": "agenda-ficticia", "project": null, "account": { "label": "cliente", "color": "#3b82f6" },
          "level": "needs", "reason": "plan", "shortReason": "Plano para aprovar", "longReason": "tem um plano para aprovar",
          "since": "2026-10-18T23:03:00.000Z", "minutes": 7, "local": "local_00000000-0000-4000-8000-000000000004", "machine": null },
        { "session": "s3", "title": "fila-de-tarefas", "project": null, "account": null,
          "level": "your-turn", "reason": "your-turn", "shortReason": "Sua vez", "longReason": "terminou o turno, sua vez",
          "since": "2026-10-18T23:09:00.000Z", "minutes": 1, "local": null, "machine": null },
        { "session": "s5", "title": "catalogo-exemplo", "project": null, "account": null,
          "level": "your-turn", "reason": "interrupted", "shortReason": "Interrompida", "longReason": "foi interrompida",
          "since": "2026-10-18T23:00:00.000Z", "minutes": 10, "local": null, "machine": null }
      ]
    }"##;

    /// A7: one local session that needs you and two idle ones.
    const ONE_LOCAL: &str = r##"{
      "cursor": "c44", "total": 3, "needs": 1, "yourTurn": 2, "blocked": 1, "idle": 2, "active": 1, "withError": 0,
      "items": [
        { "session": "s4", "title": "agenda-ficticia", "project": null, "account": null,
          "level": "needs", "reason": "plan", "attention": { "level": "blocked", "reason": "plan" }, "shortReason": "Plano para aprovar",
          "longReason": "tem um plano para aprovar", "since": "2026-10-18T23:03:00.000Z", "minutes": 7, "local": null, "machine": null },
        { "session": "s3", "title": "fila-de-tarefas", "project": null, "account": null,
          "level": "your-turn", "reason": "your-turn", "attention": { "level": "idle", "reason": "turn_ended" }, "shortReason": "Sua vez",
          "longReason": "terminou o turno, sua vez", "since": "2026-10-18T23:09:00.000Z", "minutes": 1, "local": null, "machine": null },
        { "session": "s5", "title": "catalogo-exemplo", "project": null, "account": null,
          "level": "your-turn", "reason": "interrupted", "attention": { "level": "idle", "reason": "interrupted" }, "shortReason": "Interrompida",
          "longReason": "foi interrompida", "since": "2026-10-18T23:00:00.000Z", "minutes": 10, "local": null, "machine": null }
      ]
    }"##;

    /// `GET /api/telemetry` of a machine, synthetic: CPU, load, cores, volumes and alerts.
    fn telemetry(used_pct: f64, load: f64, cores: u32, volumes: &[(&str, f64)], alerts: &str) -> machines::Telemetry {
        let vols: Vec<String> = volumes.iter().map(|(m, p)| format!(r#"{{ "mount": "{m}", "totalBytes": 100, "usedBytes": 1, "freeBytes": 1, "usedPct": {p} }}"#)).collect();
        let json = format!(
            r#"{{ "version": 1, "hours": 1, "series": {{}},
                 "current": {{ "takenAt": "2026-10-18T23:09:40.000Z", "cpu": {{ "cores": {cores}, "model": null, "usedPct": {used_pct}, "load": {{ "one": {load}, "five": 1, "fifteen": 1 }} }},
                              "disk": {{ "volumes": [{}] }} }},
                 "alerts": [{alerts}] }}"#,
            vols.join(",")
        );
        machines::telemetry_from_json(&json).expect("synthetic telemetry parses")
    }

    fn summaries(json: &str) -> Vec<machines::MachineSummary> {
        machines::summaries_from_json(json).expect("synthetic machines parse")
    }

    const LOCAL_SUMMARY: &str = r#"{ "id": "local", "label": "Esta máquina", "state": "connected", "reason": null, "version": 1, "port": null, "lastReadAt": "2026-10-18T23:09:40.000Z", "alerts": 0 }"#;

    const LOAD_ALERT: &str = r#"{ "id": "load-high", "kind": "load-high", "level": "error", "message": "CPU saturada: carga de 24,6 em 16 núcleos", "detail": null, "since": "2026-10-18T22:58:00.000Z" }"#;
    const VOLUME_ALERT: &str = r#"{ "id": "volume-full:/", "kind": "volume-full", "level": "warning", "message": "O volume / passou de 85%", "detail": null, "since": "2026-10-18T22:00:00.000Z" }"#;
    const UNREACHABLE_ALERT: &str = r#"{ "id": "machine-unreachable", "kind": "machine-unreachable", "level": "error", "message": "Workstation sem conexão", "detail": "A porta 14720 deste Mac não aceita conexão: o túnel está caído", "since": "2026-10-18T22:56:30.000Z" }"#;

    /// A6: this Mac and the Workstation connected, with the load and volume alerts open.
    fn a6_machines() -> Vec<machines::Machine> {
        let s = summaries(&format!(
            r#"[{LOCAL_SUMMARY},
               {{ "id": "workstation", "label": "Workstation", "state": "connected", "reason": null, "version": 1, "port": 14720, "lastReadAt": "2026-10-18T23:09:50.000Z", "alerts": 2 }}]"#
        ));
        vec![
            machines::Machine { summary: s[0].clone(), telemetry: Some(telemetry(34.2, 2.1, 10, &[("/", 61.0), ("/System/Volumes/Data", 40.0)], "")) },
            machines::Machine { summary: s[1].clone(), telemetry: Some(telemetry(97.0, 24.6, 16, &[("/", 86.0), ("/data", 30.0)], &format!("{LOAD_ALERT},{VOLUME_ALERT}"))) },
        ]
    }

    /// A7: the Workstation unreachable for 14 min, port closed.
    fn a7_machines(reason: &str) -> Vec<machines::Machine> {
        a8_machines(reason, "null")
    }

    /// A7 with the Workstation's `reconnect` (#244): `null` as a core from before it sends.
    fn a8_machines(reason: &str, reconnect: &str) -> Vec<machines::Machine> {
        let s = summaries(&format!(
            r#"[{LOCAL_SUMMARY},
               {{ "id": "workstation", "label": "Workstation", "state": "unreachable", "reason": "{reason}", "version": 1, "port": 14720, "lastReadAt": "2026-10-18T22:56:00.000Z", "alerts": 1, "reconnect": {reconnect} }}]"#
        ));
        vec![
            machines::Machine { summary: s[0].clone(), telemetry: Some(telemetry(34.0, 2.1, 10, &[("/", 61.0)], "")) },
            machines::Machine { summary: s[1].clone(), telemetry: Some(telemetry(20.0, 1.0, 16, &[("/", 86.0)], UNREACHABLE_ALERT)) },
        ]
    }

    fn with_machines<'a>(core: &'a CoreState, attention: Option<&'a Attention>, ms: Option<&'a [machines::Machine]>) -> Input<'a> {
        Input { machines: ms, now_ms: NOW_MS, ..input(core, attention) }
    }

    const FOOTER: [&str; 6] = ["Abrir o console", "✓ Notificações", "Abrir no login", "—", "Ahrena Console 0.0.1", "Sair do Ahrena Console"];

    fn with_footer(head: &[&str]) -> Vec<String> {
        head.iter().chain(FOOTER.iter()).map(|s| s.to_string()).collect()
    }

    #[test]
    fn criterion_1_a6_machines_block_between_the_list_and_the_footer() {
        let a = Attention::from_json(REMOTE_THREE).unwrap();
        let n = CoreState::Up { port: 4720 };
        let ms = a6_machines();
        let m = build(&with_machines(&n, Some(&a), Some(&ms)));
        assert_eq!(
            texts(&m),
            with_footer(&[
                "Ahrena Console",
                "Núcleo de pé · 127.0.0.1:4720",
                "—",
                "3 precisam de você · abrir na janela",
                "agenda-ficticia · Plano para aprovar · 7 min",
                "painel-de-metricas · Workstation · Com erro · 3 min",
                "motor-de-regras · Workstation · Pede permissão · 2 min",
                "—",
                "Máquinas",
                "Este Mac · CPU 34% · disco 61%",
                "Workstation · carga 24,6 de 16 · disco 86%",
                "CPU saturada há 12 min · Workstation",
                "Volume / em 86% · Workstation",
                "—",
                "4 ativas",
                "2 ociosas",
                "—",
            ])
        );
    }

    #[test]
    fn criterion_1_rows_and_alerts_open_the_machine_screen() {
        let a = Attention::from_json(REMOTE_THREE).unwrap();
        let n = CoreState::Up { port: 4720 };
        let ms = a6_machines();
        let m = build(&with_machines(&n, Some(&a), Some(&ms)));
        let rows: Vec<_> = m
            .iter()
            .filter_map(|i| match i {
                Item::Machine { id, dot, .. } => Some((id.as_str(), *dot)),
                _ => None,
            })
            .collect();
        assert_eq!(rows, [("local", Dot::Green), ("workstation", Dot::Green), ("workstation", Dot::Red), ("workstation", Dot::Yellow)]);
        assert_eq!(machines::machine_path("local"), "/ui/machines/local");
    }

    #[test]
    fn criterion_1_cpu_percent_when_load_fits_the_cores() {
        let r = telemetry(34.4, 16.0, 16, &[("/", 10.0), ("/data", 70.4)], "").current.unwrap();
        assert_eq!(machines::figures(&r), "CPU 34% · disco 70%", "load equal to cores is not saturated; the fullest volume wins");
        let r = telemetry(90.0, 16.1, 16, &[], "").current.unwrap();
        assert_eq!(machines::figures(&r), "carga 16,1 de 16");
    }

    #[test]
    fn criterion_2_a2_remote_sessions_carry_the_label_and_no_desktop_alternate() {
        let a = Attention::from_json(REMOTE_THREE).unwrap();
        let n = CoreState::Up { port: 4720 };
        let m = build(&input(&n, Some(&a)));
        let sessions: Vec<_> = m
            .iter()
            .filter_map(|i| match i {
                Item::Session { text, alternate, tooltip, .. } => Some((text.as_str(), alternate.as_deref(), tooltip.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(
            sessions,
            [
                ("agenda-ficticia · Plano para aprovar · 7 min", Some("agenda-ficticia · Abrir no Claude Desktop"), "cliente · tem um plano para aprovar"),
                ("painel-de-metricas · Workstation · Com erro · 3 min", None, "Sem conta · parou num erro"),
                ("motor-de-regras · Workstation · Pede permissão · 2 min", None, "equipe · pede permissão para usar Bash"),
            ]
        );
    }

    #[test]
    fn criterion_3_machine_alerts_do_not_add_to_the_menu_bar_number() {
        let a = Attention::from_json(REMOTE_THREE).unwrap();
        let n = CoreState::Up { port: 4720 };
        assert_eq!(tray_title(&n, Some(&a)).as_deref(), Some("3"), "3 sessions; the 2 Workstation alerts do not count");
        let zero = Attention::from_json(ZERO).unwrap();
        assert_eq!(tray_title(&n, Some(&zero)), None, "alerts alone never put a number in the bar");
    }

    #[test]
    fn criterion_4_a7_unreachable_remote_is_grey_with_age_and_reason() {
        let a = Attention::from_json(ONE_LOCAL).unwrap();
        let n = CoreState::Up { port: 4720 };
        let ms = a7_machines("port-closed");
        let m = build(&with_machines(&n, Some(&a), Some(&ms)));
        assert_eq!(
            texts(&m),
            with_footer(&[
                "Ahrena Console",
                "Núcleo de pé · 127.0.0.1:4720",
                "—",
                "1 precisa de você · abrir na janela",
                "agenda-ficticia · Plano para aprovar · 7 min",
                "—",
                "Máquinas",
                "Este Mac · CPU 34% · disco 61%",
                "Workstation · sem conexão há 14 min",
                "  A porta 14720 não aceita conexão: o túnel parece caído",
                "  Como reconectar daqui…",
                "—",
                "1 ativa",
                "2 ociosas",
                "—",
            ])
        );
        assert!(m.iter().any(|i| matches!(i, Item::Machine { id, dot: Dot::Empty, .. } if id == "workstation")), "grey dot");
        let actions: Vec<_> = m.iter().filter_map(|i| if let Item::Action { id, .. } = i { Some(*id) } else { None }).collect();
        assert_eq!(actions, [ID_OPEN, ID_QUIT], "no item brings a tunnel up");
        assert!(m.iter().any(|i| matches!(i, Item::Detail(t) if t.contains("túnel parece caído"))), "the reason is a disabled line");
    }

    // ---- #244: Reconectar (wireframe A8) ----

    const CONFIGURED_IDLE: &str = r#"{ "configured": true, "command": ["/caminho/para/conectar.sh", "tunnel", "restart"], "timeoutSeconds": 180, "state": "idle",
        "startedAt": null, "endedAt": null, "exitCode": null, "startedBy": null, "logFile": null }"#;
    const CONFIGURED_RUNNING: &str = r#"{ "configured": true, "command": ["/caminho/para/conectar.sh"], "timeoutSeconds": 180, "state": "running",
        "startedAt": "2026-10-18T23:08:48.000Z", "endedAt": null, "exitCode": null, "startedBy": "local", "logFile": "/dados/reconnect.log" }"#;
    const NOT_CONFIGURED: &str = r#"{ "configured": false, "command": null, "timeoutSeconds": null, "state": "idle",
        "startedAt": null, "endedAt": null, "exitCode": null, "startedBy": null, "logFile": null }"#;

    fn machines_block_texts(ms: &[machines::Machine]) -> Vec<String> {
        let a = Attention::from_json(ONE_LOCAL).unwrap();
        let n = CoreState::Up { port: 4720 };
        let t = texts(&build(&with_machines(&n, Some(&a), Some(ms))));
        let from = t.iter().position(|x| x == "Máquinas").unwrap();
        let to = from + t[from..].iter().position(|x| x == "—").unwrap();
        t[from..to].to_vec()
    }

    #[test]
    fn a8_a_configured_offers_reconnect_under_the_row() {
        let ms = a8_machines("port-closed", CONFIGURED_IDLE);
        assert_eq!(
            machines_block_texts(&ms),
            [
                "Máquinas",
                "Este Mac · CPU 34% · disco 61%",
                "Workstation · sem conexão há 14 min",
                "  A porta 14720 não aceita conexão: o túnel parece caído",
                "  Reconectar a Workstation",
            ]
        );
        let a = Attention::from_json(ONE_LOCAL).unwrap();
        let n = CoreState::Up { port: 4720 };
        let m = build(&with_machines(&n, Some(&a), Some(&ms)));
        let reconnects: Vec<_> = m.iter().filter_map(|i| if let Item::Reconnect { id, .. } = i { Some(id.as_str()) } else { None }).collect();
        assert_eq!(reconnects, ["workstation"], "the click carries only the machine id");
        assert!(!m.iter().any(|i| matches!(i, Item::MachineLink { .. })), "no setup item when configured");
    }

    #[test]
    fn a8_b_running_is_a_grey_line_with_the_count() {
        let ms = a8_machines("port-closed", CONFIGURED_RUNNING);
        assert_eq!(
            machines_block_texts(&ms),
            ["Máquinas", "Este Mac · CPU 34% · disco 61%", "Workstation · reconectando", "  Reconectando… aguardando login · 1:12"]
        );
        let a = Attention::from_json(ONE_LOCAL).unwrap();
        let n = CoreState::Up { port: 4720 };
        let m = build(&with_machines(&n, Some(&a), Some(&ms)));
        assert!(!m.iter().any(|i| matches!(i, Item::Reconnect { .. } | Item::MachineLink { .. })), "nothing to click while it runs");
        assert!(m.iter().any(|i| matches!(i, Item::Detail(t) if t.starts_with("Reconectando…"))), "a disabled line");
        assert!(m.iter().any(|i| matches!(i, Item::Machine { id, dot: Dot::Yellow, .. } if id == "workstation")), "the row opens the screen, where Cancelar is");
    }

    #[test]
    fn a8_b_running_without_a_start_time_shows_no_count() {
        let ms = a8_machines("port-closed", r#"{ "configured": true, "state": "running" }"#);
        assert_eq!(machines_block_texts(&ms)[3], "  Reconectando… aguardando login");
    }

    #[test]
    fn a8_c_not_configured_teaches_how_on_the_machine_screen() {
        for reconnect in [NOT_CONFIGURED, "null", r#""inesperado""#] {
            let ms = a8_machines("no-response", reconnect);
            assert_eq!(
                machines_block_texts(&ms),
                [
                    "Máquinas",
                    "Este Mac · CPU 34% · disco 61%",
                    "Workstation · sem conexão há 14 min",
                    "  O túnel está de pé, mas o núcleo de lá não respondeu",
                    "  Como reconectar daqui…",
                ],
                "{reconnect}"
            );
            let a = Attention::from_json(ONE_LOCAL).unwrap();
            let n = CoreState::Up { port: 4720 };
            let m = build(&with_machines(&n, Some(&a), Some(&ms)));
            assert!(m.iter().any(|i| matches!(i, Item::MachineLink { id, .. } if id == "workstation")));
            assert!(!m.iter().any(|i| matches!(i, Item::Reconnect { .. })));
        }
    }

    #[test]
    fn a8_connected_machine_offers_no_reconnect() {
        let mut ms = a6_machines();
        ms[1].summary.reconnect = machines::summaries_from_json(&format!(r#"[{{ "id": "w", "label": "W", "state": "connected", "reconnect": {CONFIGURED_IDLE} }}]"#)).unwrap()[0].reconnect.clone();
        let a = Attention::from_json(ONE_LOCAL).unwrap();
        let n = CoreState::Up { port: 4720 };
        let m = build(&with_machines(&n, Some(&a), Some(&ms)));
        assert!(!m.iter().any(|i| matches!(i, Item::Reconnect { .. } | Item::MachineLink { .. })));
    }

    #[test]
    fn criterion_4_no_response_reason() {
        let a = Attention::from_json(ONE_LOCAL).unwrap();
        let n = CoreState::Up { port: 4720 };
        let ms = a7_machines("no-response");
        let t = texts(&build(&with_machines(&n, Some(&a), Some(&ms))));
        assert!(t.contains(&"  O túnel está de pé, mas o núcleo de lá não respondeu".to_string()), "{t:?}");
    }

    #[test]
    fn criterion_7_only_this_mac_without_machines_json() {
        let a = Attention::from_json(ZERO).unwrap();
        let n = CoreState::Up { port: 4720 };
        let ms = vec![machines::Machine { summary: summaries(&format!("[{LOCAL_SUMMARY}]")).remove(0), telemetry: Some(telemetry(34.0, 1.0, 10, &[("/", 61.0)], "")) }];
        let t = texts(&build(&with_machines(&n, Some(&a), Some(&ms))));
        assert_eq!(
            &t[..10],
            ["Ahrena Console", "Núcleo de pé · 127.0.0.1:4720", "—", "Ninguém precisa de você", "4 ativas", "nenhuma com erro", "—", "Máquinas", "Este Mac · CPU 34% · disco 61%", "—"]
        );
    }

    #[test]
    fn criterion_7_no_block_without_telemetry() {
        let a = Attention::from_json(THREE).unwrap();
        let n = CoreState::Up { port: 4720 };
        let none = texts(&build(&with_machines(&n, Some(&a), None)));
        let empty = texts(&build(&with_machines(&n, Some(&a), Some(&[]))));
        let before = texts(&build(&input(&n, Some(&a))));
        assert_eq!(none, before, "/api/machines 404: the menu is the A2 of before");
        assert_eq!(empty, before, "/api/machines empty: same");
        assert!(!none.iter().any(|t| t == "Máquinas"));
    }

    #[test]
    fn older_core_with_portuguese_keys_and_values() {
        // The `/api/atencao` of a core from before #173 (phase 2b): the new app may adopt it.
        const OLD: &str = r##"{
          "geradoEm": "2026-10-18T23:10:00.000Z", "cursor": "c42", "total": 2, "precisam": 1, "suaVez": 1,
          "ativas": 4, "comErro": 1,
          "itens": [
            { "sessao": "s2", "titulo": "painel-de-metricas", "projeto": null, "conta": { "rotulo": "equipe", "cor": "#f47c20" },
              "nivel": "precisa", "motivo": "erro", "motivoCurto": "Com erro", "motivoLongo": "parou num erro",
              "desde": "2026-10-18T23:07:00.000Z", "minutos": 3, "local": null },
            { "sessao": "s3", "titulo": "fila-de-tarefas", "projeto": null, "conta": null,
              "nivel": "sua-vez", "motivo": "sua-vez", "motivoCurto": "Sua vez", "motivoLongo": "terminou o turno, sua vez",
              "desde": "2026-10-18T23:09:00.000Z", "minutos": 1 }
          ]
        }"##;
        let a = Attention::from_json(OLD).unwrap();
        assert_eq!((a.total, a.active, a.with_error, a.items.len()), (2, 4, 1, 2));
        assert_eq!((a.blocked_count(), a.idle_count()), (1, 1), "from `precisam` and `suaVez`");
        assert_eq!(a.items[0].attention, Some(ItemAttention { level: BLOCKED.into(), reason: "error".into() }));
        assert_eq!(a.items[1].attention, Some(ItemAttention { level: IDLE.into(), reason: "turn_ended".into() }));
        let e = &a.items[0];
        assert_eq!((e.session.as_str(), e.title.as_str(), e.level.as_str(), e.reason.as_str()), ("s2", "painel-de-metricas", "needs", "error"));
        assert_eq!((e.short_reason.as_str(), e.long_reason.as_str(), e.minutes), ("Com erro", "parou num erro", 3));
        assert_eq!(e.account, Some(Account { label: "equipe".into(), color: "#f47c20".into() }));
        assert_eq!(session_dot(e), Dot::Red);
        let v = &a.items[1];
        assert_eq!((v.level.as_str(), v.reason.as_str(), v.local.as_deref()), ("your-turn", "your-turn", None));
        for (old, new) in [
            ("permissao", "permission"),
            ("pergunta", "question"),
            ("plano", "plan"),
            ("decisao", "decision"),
            ("erro", "error"),
            ("sua-vez", "your-turn"),
            ("interrompida", "interrupted"),
        ] {
            assert_eq!(english_reason(old), Some(new));
            assert_eq!(english_reason(new), None);
        }
        assert_eq!(english_reason("no-prompt"), None);
        assert_eq!(english_level("precisa"), Some("needs"));
        assert_eq!(english_level("needs"), None);
    }

    #[test]
    fn older_core_before_245_falls_back_to_level() {
        let a = Attention::from_json(REMOTE_THREE).unwrap();
        assert_eq!((a.blocked_count(), a.idle_count()), (3, 2), "from `needs` and `yourTurn`");
        let levels: Vec<_> = a.items.iter().map(|i| (i.session.as_str(), i.is_blocked(), i.is_idle())).collect();
        assert_eq!(levels, [("s1", true, false), ("s2", true, false), ("s4", true, false), ("s3", false, true), ("s5", false, true)]);
        assert_eq!(a.items[4].attention.as_ref().map(|x| x.reason.as_str()), Some("interrupted"));
        assert_eq!(tray_title(&CoreState::Up { port: 4720 }, Some(&a)).as_deref(), Some("3"));
    }

    #[test]
    fn counts_from_the_items_without_any_count_key() {
        const BARE: &str = r#"{ "cursor": "c1", "total": 2, "active": 1, "withError": 0, "items": [
          { "session": "s1", "title": "a", "account": null, "level": "needs", "reason": "question", "shortReason": "Pergunta", "longReason": "pergunta", "minutes": 1, "local": null },
          { "session": "s2", "title": "b", "account": null, "level": "your-turn", "reason": "no-prompt", "shortReason": "No prompt", "longReason": "sessão nova", "minutes": 1, "local": null } ] }"#;
        let a = Attention::from_json(BARE).unwrap();
        assert_eq!((a.blocked_count(), a.idle_count()), (1, 1));
        assert_eq!(a.items[1].attention.as_ref().map(|x| x.reason.as_str()), Some("first_prompt"));
        let t = texts(&build(&input(&CoreState::Up { port: 4720 }, Some(&a))));
        assert!(t.contains(&"1 precisa de você · abrir na janela".to_string()));
        assert!(t.contains(&"1 ociosa".to_string()));
    }

    #[test]
    fn the_new_attention_wins_over_the_old_level() {
        // `attention` is the #245 source of truth; `level` only fills it when it is missing.
        const MIXED: &str = r#"{ "cursor": "c1", "total": 1, "blocked": 0, "idle": 1, "active": 1, "withError": 0, "items": [
          { "session": "s1", "title": "a", "account": null, "level": "needs", "reason": "interrupted", "attention": { "level": "idle", "reason": "interrupted" },
            "shortReason": "Interrompida", "longReason": "foi interrompida", "minutes": 1, "local": null } ] }"#;
        let a = Attention::from_json(MIXED).unwrap();
        assert!(a.blocked_items().is_empty());
        assert_eq!(tray_title(&CoreState::Up { port: 4720 }, Some(&a)), None);
    }

    #[test]
    fn no_waiting_you_text() {
        let a = Attention::from_json(THREE).unwrap();
        let t = texts(&build(&input(&CoreState::Up { port: 4720 }, Some(&a))));
        assert!(!t.iter().any(|x| x.contains("Esperando")), "{t:?}");
    }

    #[test]
    fn invalid_json_does_not_build() {
        assert!(Attention::from_json("{}").is_none());
        assert!(Attention::from_json("não é json").is_none());
    }
}
