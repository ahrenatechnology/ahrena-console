// The machines the tray shows (#180, decision 0008 section 5): this one and the remote ones, read
// from `GET /api/machines` and, per machine, `GET /api/telemetry?machine=<id>` (packages/nucleo
// src/api/telemetry.ts and src/telemetry/model.ts).
//
// Kept apart from Tauri so it is tested without opening the app: this module only parses the core's
// JSON and derives the short texts the menu (menu.rs) and the notifications (notificacoes.rs) show.
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
    format!("/ui/machines/{}", http::codificar(id))
}

/// A number the pt-BR way, with one decimal: `24,6`.
pub fn decimal(x: f64) -> String {
    format!("{x:.1}").replace('.', ",")
}

/// "há 12 min", from `tempo` in menu.rs, with "menos de 1 min" for zero.
pub fn ago(minutes: u64) -> String {
    if minutes == 0 {
        "há menos de 1 min".into()
    } else {
        format!("há {}", crate::menu::tempo(minutes))
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
    fn decimal_uses_a_comma() {
        assert_eq!([decimal(24.6), decimal(16.0), decimal(2.04)], ["24,6", "16,0", "2,0"]);
    }
}
