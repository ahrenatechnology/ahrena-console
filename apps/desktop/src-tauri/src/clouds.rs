// The cloud connectors the tray shows (#277, decision 0013 sections 2, 3 and 7): the AWS SSO sessions
// of this Mac, read from `GET /api/connectors` (packages/nucleo src/api/clouds.ts and
// src/clouds/aws-connector.ts), for the "Nuvens" block (wireframe A9) and the notices of A10.
//
// Kept apart from Tauri so it is tested without opening the app: this module only parses the core's
// JSON and derives the short texts the menu (menu.rs) and the notifications (notifications.rs) show.
// Only the fields the tray needs are read: the profiles, account numbers, start URL and region stay
// with the core and the `/ui`. The tunnel lines of A9 ("Entrar na AWS e subir o túnel") are #278.

use serde::Deserialize;

use crate::http;
use crate::machines;

/// The `/ui` screen "Abrir" and a click on a session line lead to: Conexões (C57 to C61).
pub const CONNECTIONS_PATH: &str = "/ui/connections";

/// The part of the AWS connector the tray reads.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Aws {
    /// `missing-cli`, `unsupported-cli`, `not-configured` or the worst session state.
    #[serde(default)]
    pub state: String,
    #[serde(default, deserialize_with = "lenient_sessions")]
    pub sessions: Vec<Session>,
}

/// One SSO session (or a legacy profile, which the core shows as a session of its own).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Session {
    pub name: String,
    /// The name can go on the `aws` command line (`^[A-Za-z0-9._-]{1,64}$`); without it, no Entrar.
    #[serde(rename = "loginSupported", default)]
    pub login_supported: bool,
    /// `valid`, `expiring`, `expired`, `never` or `unknown`.
    #[serde(default)]
    pub state: String,
    /// The token's end, from the CLI's cache (variant A of decision 0013); `None` without a cache.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<String>,
    #[serde(default, deserialize_with = "lenient_login")]
    pub login: Option<Login>,
}

/// The part of `login` the tray reads: whether one runs, and since when.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Login {
    /// `idle`, `running`, `succeeded`, `failed`, `timed-out` or `canceled`.
    #[serde(default)]
    pub state: Option<String>,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<String>,
}

/// `login` absent, `null` or of an unexpected shape is `None`, as `reconnect` in machines.rs.
fn lenient_login<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Login>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).ok())
}

/// A session that does not parse (no name, say) is left out instead of failing the whole read.
fn lenient_sessions<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Session>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    let serde_json::Value::Array(items) = value else { return Ok(Vec::new()) };
    Ok(items.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

#[derive(Deserialize)]
struct Connectors {
    connectors: Vec<serde_json::Value>,
}

/// The AWS connector of `GET /api/connectors`, when it has sessions to show; `Ok(None)` without one
/// (no AWS item, no session in ~/.aws/config). The serde error when the body does not parse.
pub fn aws_from_json(text: &str) -> Result<Option<Aws>, serde_json::Error> {
    let all: Connectors = serde_json::from_str(text)?;
    let aws = all
        .connectors
        .into_iter()
        .find(|c| c.get("kind").and_then(|k| k.as_str()) == Some("aws"))
        .and_then(|c| serde_json::from_value::<Aws>(c).ok())
        .filter(|a| !a.sessions.is_empty());
    Ok(aws)
}

#[derive(Deserialize)]
struct LoginResponse {
    #[serde(default, deserialize_with = "lenient_login")]
    login: Option<Login>,
}

/// The `login` of the 202 answer, to show "Aguardando o navegador" before the next read.
pub fn login_from_response(text: &str) -> Option<Login> {
    serde_json::from_str::<LoginResponse>(text).ok()?.login
}

/// The names the core accepts on the command line (`SAFE_CLI_NAME` in aws-config.ts).
pub fn safe_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) && !matches!(name, "." | "..")
}

/// `POST` here starts the login of the session, in the browser; `None` for a name the core would
/// refuse anyway. Only the name goes: the command is the core's fixed template.
pub fn login_path(name: &str) -> Option<String> {
    safe_name(name).then(|| format!("/api/connectors/aws/sessions/{}/login", http::encode(name)))
}

/// The body of that `POST`: the browser mode, the one that fits this Mac.
pub const LOGIN_BODY: &str = r#"{"mode":"browser"}"#;

impl Session {
    pub fn login_running(&self) -> bool {
        self.login.as_ref().is_some_and(|l| l.state.as_deref() == Some("running"))
    }

    pub fn expires_ms(&self) -> Option<u64> {
        self.expires_at.as_deref().and_then(machines::parse_iso_ms)
    }

    /// "Entrar na AWS (<session>)" in the menu and "Entrar" in the notice: only for a session that
    /// asks for it (expiring or expired) and whose name can go on the command line.
    pub fn offers_login(&self, aws: &Aws) -> bool {
        self.login_supported && matches!(self.state.as_str(), "expiring" | "expired") && !matches!(aws.state.as_str(), "missing-cli" | "unsupported-cli")
    }
}

/// The sessions in the menu's order: the one closest to expiring first (the expired ones, then the
/// expiring, then the valid by their end), and those without an end (unknown, never) last.
pub fn ordered(aws: &Aws) -> Vec<&Session> {
    let bucket = |s: &Session| match s.state.as_str() {
        "expired" => 0,
        "expiring" => 1,
        "valid" => 2,
        "unknown" => 3,
        _ => 4,
    };
    let mut sessions: Vec<&Session> = aws.sessions.iter().collect();
    sessions.sort_by(|a, b| (bucket(a), a.expires_ms().unwrap_or(u64::MAX), &a.name).cmp(&(bucket(b), b.expires_ms().unwrap_or(u64::MAX), &b.name)));
    sessions
}

/// Whole minutes left until `at`, rounded up: "expira em 14 min" from 13 min 20 s.
fn minutes_left(at: u64, now_ms: u64) -> u64 {
    at.saturating_sub(now_ms).div_ceil(60_000)
}

/// "18:40" on the same local day as `now_ms`, "23/10 09:00" on another. `offset_s`: the local zone's
/// offset from UTC, in seconds (main.rs reads it from the system).
pub fn clock(at_ms: u64, now_ms: u64, offset_s: i64) -> String {
    let local = |ms: u64| (ms / 1_000) as i64 + offset_s;
    let (at, now) = (local(at_ms), local(now_ms));
    let (hour, minute) = (at.rem_euclid(86_400) / 3_600, at.rem_euclid(3_600) / 60);
    if at.div_euclid(86_400) == now.div_euclid(86_400) {
        return format!("{hour:02}:{minute:02}");
    }
    let (_, month, day) = civil_from_days(at.div_euclid(86_400));
    format!("{day:02}/{month:02} {hour:02}:{minute:02}")
}

/// The date of a count of days since 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// The state part of a session line: "expira em 14 min", "válida até 18:40", "expirada há 5 h",
/// "nunca entrou", "estado desconhecido".
pub fn status_text(s: &Session, now_ms: u64, offset_s: i64) -> String {
    let at = s.expires_ms();
    match s.state.as_str() {
        "expiring" => match at.map(|a| minutes_left(a, now_ms)) {
            Some(m) if m > 0 => format!("expira em {m} min"),
            _ => "expira em menos de 1 min".into(),
        },
        "valid" => match at {
            Some(a) => format!("válida até {}", clock(a, now_ms, offset_s)),
            None => "válida".into(),
        },
        "expired" => match at.filter(|a| *a <= now_ms) {
            Some(a) => format!("expirada {}", machines::ago(now_ms.saturating_sub(a) / 60_000)),
            None => "expirada".into(),
        },
        "never" => "nunca entrou".into(),
        _ => "estado desconhecido".into(),
    }
}

/// The session's line in the "Nuvens" block: "AWS · sessao-exemplo · expira em 14 min".
pub fn line(s: &Session, now_ms: u64, offset_s: i64) -> String {
    format!("AWS · {} · {}", s.name, status_text(s, now_ms, offset_s))
}

/// The grey line that replaces Entrar while the login runs: "Aguardando o navegador · 0:48".
pub fn waiting_line(s: &Session, now_ms: u64) -> String {
    match s.login.as_ref().and_then(|l| l.started_at.as_deref()).and_then(|t| machines::running_for(t, now_ms)) {
        Some(t) => format!("Aguardando o navegador · {t}"),
        None => "Aguardando o navegador".into(),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub const NOW: &str = "2026-10-18T18:00:00.000Z";

    /// `GET /api/connectors` as the core answers it, with synthetic sessions (A9): one expiring in
    /// 14 min, one valid until 18:40 (UTC in the tests), one expired 5 h ago, one never logged in, one
    /// whose name does not go on the command line, and GCP and Azure still "soon".
    pub const A9: &str = r#"{ "connectors": [
      { "kind": "aws", "state": "expired",
        "cli": { "found": true, "version": 2, "deviceCodeSupported": true },
        "configFile": { "status": "ok" },
        "sessions": [
          { "name": "sessao-lab", "kind": "sso-session", "startUrlHost": "exemplo.awsapps.com", "region": "regiao-exemplo-1", "loginSupported": true,
            "state": "valid", "expiresAt": "2026-10-18T18:40:00.000Z", "checkedAt": "2026-10-18T17:58:00.000Z",
            "profiles": [{ "name": "perfil-lab", "accountId": "000000000000", "roleName": "papel-exemplo", "region": "regiao-exemplo-1" }],
            "login": { "state": "idle", "mode": null, "startedAt": null, "endedAt": null, "timeoutSeconds": 300, "exitCode": null, "startedBy": null, "logFile": "/d/reconnect.log", "deviceCode": null } },
          { "name": "sessao-velha", "kind": "legacy", "loginSupported": true, "state": "expired", "expiresAt": "2026-10-18T13:00:00.000Z", "profiles": [], "login": null },
          { "name": "sessao-exemplo", "kind": "sso-session", "loginSupported": true, "state": "expiring", "expiresAt": "2026-10-18T18:13:20.000Z", "profiles": [],
            "login": { "state": "idle" } },
          { "name": "sessao-nova", "kind": "sso-session", "loginSupported": true, "state": "never", "expiresAt": null, "profiles": [] },
          { "name": "sessao com espaco", "kind": "sso-session", "loginSupported": false, "state": "expired", "expiresAt": null, "profiles": [] }
        ],
        "outOfScope": [{ "name": "perfil-chave", "reason": "no-sso" }] },
      { "kind": "gcp", "state": "soon" }, { "kind": "azure", "state": "soon" } ] }"#;

    pub fn now() -> u64 {
        machines::parse_iso_ms(NOW).unwrap()
    }

    pub fn a9() -> Aws {
        aws_from_json(A9).unwrap().expect("an AWS connector with sessions")
    }

    #[test]
    fn reads_only_the_aws_connector_with_sessions() {
        let aws = a9();
        assert_eq!(aws.state, "expired");
        assert_eq!(aws.sessions.len(), 5);
        let none = r#"{ "connectors": [{ "kind": "aws", "state": "not-configured", "sessions": [], "outOfScope": [] }, { "kind": "gcp", "state": "soon" }] }"#;
        assert_eq!(aws_from_json(none).unwrap(), None, "no session, no block");
        assert_eq!(aws_from_json(r#"{ "connectors": [{ "kind": "gcp", "state": "soon" }] }"#).unwrap(), None);
        let missing_cli = r#"{ "connectors": [{ "kind": "aws", "state": "missing-cli", "cli": { "found": false } }] }"#;
        assert_eq!(aws_from_json(missing_cli).unwrap(), None, "no sessions key");
        assert!(aws_from_json("<html>").is_err());
        assert!(aws_from_json(r#"{ "error": "x" }"#).is_err());
    }

    #[test]
    fn a_session_that_does_not_parse_is_left_out() {
        let json = r#"{ "connectors": [{ "kind": "aws", "state": "valid", "sessions": [{ "state": "valid" }, { "name": "sessao-ok", "state": "valid", "login": "x" }] }] }"#;
        let aws = aws_from_json(json).unwrap().unwrap();
        assert_eq!(aws.sessions.len(), 1);
        assert_eq!((aws.sessions[0].name.as_str(), aws.sessions[0].login.is_none()), ("sessao-ok", true));
    }

    #[test]
    fn a9_lines_closest_to_expiring_first() {
        let aws = a9();
        let lines: Vec<String> = ordered(&aws).iter().map(|s| line(s, now(), 0)).collect();
        assert_eq!(
            lines,
            [
                "AWS · sessao-velha · expirada há 5 h",
                "AWS · sessao com espaco · expirada",
                "AWS · sessao-exemplo · expira em 14 min",
                "AWS · sessao-lab · válida até 18:40",
                "AWS · sessao-nova · nunca entrou",
            ]
        );
    }

    #[test]
    fn entrar_only_for_expiring_or_expired_with_a_supported_name() {
        let aws = a9();
        let offered: Vec<&str> = ordered(&aws).into_iter().filter(|s| s.offers_login(&aws)).map(|s| s.name.as_str()).collect();
        assert_eq!(offered, ["sessao-velha", "sessao-exemplo"]);
        let mut no_cli = aws.clone();
        no_cli.state = "missing-cli".into();
        assert!(!no_cli.sessions.iter().any(|s| s.offers_login(&no_cli)), "without the CLI the core would refuse");
    }

    #[test]
    fn status_texts() {
        let n = now();
        let s = |state: &str, at: Option<&str>| Session { name: "s".into(), login_supported: true, state: state.into(), expires_at: at.map(String::from), login: None };
        assert_eq!(status_text(&s("expiring", Some("2026-10-18T18:00:30.000Z")), n, 0), "expira em 1 min");
        assert_eq!(status_text(&s("expiring", Some("2026-10-18T17:59:00.000Z")), n, 0), "expira em menos de 1 min", "past the end while the CLI still answers");
        assert_eq!(status_text(&s("expiring", None), n, 0), "expira em menos de 1 min");
        assert_eq!(status_text(&s("valid", Some("2026-10-18T21:40:00.000Z")), n, -3 * 3_600), "válida até 18:40", "in the local zone");
        assert_eq!(status_text(&s("valid", Some("2026-10-19T09:00:00.000Z")), n, 0), "válida até 19/10 09:00", "another day carries the date");
        assert_eq!(status_text(&s("valid", None), n, 0), "válida");
        assert_eq!(status_text(&s("expired", Some("2026-10-18T17:59:40.000Z")), n, 0), "expirada há menos de 1 min");
        assert_eq!(status_text(&s("expired", Some("2026-10-18T19:00:00.000Z")), n, 0), "expirada", "the probe says expired before the cache's end");
        assert_eq!(status_text(&s("never", None), n, 0), "nunca entrou");
        assert_eq!(status_text(&s("unknown", None), n, 0), "estado desconhecido");
    }

    #[test]
    fn clock_in_the_local_day() {
        let at = machines::parse_iso_ms("2026-10-18T02:30:00.000Z").unwrap();
        assert_eq!(clock(at, at, 0), "02:30");
        assert_eq!(clock(at, at, -3 * 3_600), "23:30", "the previous local day, same as now");
        assert_eq!(clock(at, now(), -3 * 3_600), "17/10 23:30");
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn login_path_and_response() {
        assert_eq!(login_path("sessao-exemplo").as_deref(), Some("/api/connectors/aws/sessions/sessao-exemplo/login"));
        for bad in ["", ".", "..", "a/b", "sessao com espaco", "a%2Fb", &"x".repeat(65)] {
            assert_eq!(login_path(bad), None, "{bad:?}");
        }
        let l = login_from_response(r#"{ "login": { "state": "running", "mode": "browser", "startedAt": "2026-10-18T17:59:12.000Z" } }"#).unwrap();
        assert_eq!(l.state.as_deref(), Some("running"));
        assert_eq!(login_from_response(r#"{ "error": "x", "reason": "cli-missing" }"#), None);
    }

    #[test]
    fn waiting_line_counts_the_login() {
        let mut s = a9().sessions.remove(2);
        s.login = Some(Login { state: Some("running".into()), started_at: Some("2026-10-18T17:59:12.000Z".into()) });
        assert!(s.login_running());
        assert_eq!(waiting_line(&s, now()), "Aguardando o navegador · 0:48");
        s.login = Some(Login { state: Some("running".into()), started_at: None });
        assert_eq!(waiting_line(&s, now()), "Aguardando o navegador");
    }
}
