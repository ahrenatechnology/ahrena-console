// The updater (issues #90 and #330): asks the `latest.json` of the `app-updates` release (the update
// channel, see .github/workflows/app-updates.yml) whether there is a new version, on opening and then
// on the cadence of the build's mode (wireframes C79, A11, A12):
//
// - a version below 1.0, or one marked `dev` (`0.0.10`, `1.2.0-dev.3`): every 10 min, the mode "dev";
// - any other: every 6 h, the mode "estável".
//
// "Buscar agora" (the tray, or the /ui through the núcleo) checks at once, in any mode. A found version
// is kept as an `Update`; the click on Atualizar (tray, notification or /ui card) downloads, checks
// the signature, installs and relaunches.
//
// The state is the núcleo's to publish (`PUT /api/app-update/state`), so the /ui shows the same card in
// a window and in a browser; the clicks come back as counters in `GET /api/app-update`, which the
// core loop reads whenever `/api/changes` wakes it (`sync`). A found version notifies once, silently,
// with Atualizar and Depois; it is remembered in the app's data folder so it does not come back after
// a restart. An automatic check that fails shows nothing (stderr only); a check the person asked for
// shows its error.
//
// It only turns on with the public key in `plugins.updater.pubkey` of tauri.conf.json. Empty (the
// default until the project has the key, and in every local build), the plugin is not even
// registered: the plugin would accept the empty key on opening, but every update would then fail
// the signature check after downloading.

use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::notifications::Notice;

pub const DEV_INTERVAL: Duration = Duration::from_secs(10 * 60);
pub const STABLE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const STATE_PATH: &str = "/api/app-update/state";
const VERSION_FILE: &str = "app-version.txt";
const NOTIFIED_FILE: &str = "update-notified.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Dev,
    Stable,
}

impl Mode {
    pub fn of(version: &str) -> Mode {
        let v = version.trim_start_matches('v');
        let major = v.split(['.', '-', '+']).next().and_then(|m| m.parse::<u64>().ok());
        let pre = v.split_once('-').map(|(_, p)| p).unwrap_or("");
        if major == Some(0) || pre.split(|c: char| !c.is_ascii_alphanumeric()).any(|p| p.eq_ignore_ascii_case("dev")) {
            Mode::Dev
        } else {
            Mode::Stable
        }
    }

    pub fn interval(self) -> Duration {
        match self {
            Mode::Dev => DEV_INTERVAL,
            Mode::Stable => STABLE_INTERVAL,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Mode::Dev => "dev",
            Mode::Stable => "stable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Checking,
    Downloading,
    Installing,
    Error,
}

impl Phase {
    /// A download or an install is going: nothing else may touch the update, its progress or its phase.
    pub fn is_busy(self) -> bool {
        matches!(self, Phase::Downloading | Phase::Installing)
    }

    fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Checking => "checking",
            Phase::Downloading => "downloading",
            Phase::Installing => "installing",
            Phase::Error => "error",
        }
    }
}

/// Why a check or a download failed; the names the núcleo accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Offline,
    ChannelDown,
    Signature,
    Download,
}

impl Failure {
    fn name(self) -> &'static str {
        match self {
            Failure::Offline => "offline",
            Failure::ChannelDown => "channel-down",
            Failure::Signature => "signature",
            Failure::Download => "download",
        }
    }

    fn of_check(e: &tauri_plugin_updater::Error) -> Failure {
        use tauri_plugin_updater::Error::*;
        match e {
            Reqwest(r) if r.status().is_none() => Failure::Offline,
            _ => Failure::ChannelDown,
        }
    }

    fn of_download(e: &tauri_plugin_updater::Error) -> Failure {
        use tauri_plugin_updater::Error::*;
        match e {
            Minisign(_) | Base64(_) | SignatureUtf8(_) => Failure::Signature,
            _ => Failure::Download,
        }
    }

    /// The body of the "Não deu para atualizar" notification.
    pub fn explain(self, current: &str) -> String {
        match self {
            Failure::Signature => format!("A assinatura não confere. Você continua na {current}."),
            Failure::Offline | Failure::ChannelDown | Failure::Download => format!("A conexão caiu no download. Você continua na {current}."),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Found {
    version: String,
    notes: Option<String>,
    published_at: Option<String>,
}

/// What the tray draws of the updater (A11).
#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub phase: Phase,
    /// The version on offer (also while downloading and installing it).
    pub version: Option<String>,
    pub bytes: Option<(u64, Option<u64>)>,
    pub failed_at_ms: Option<u64>,
    pub last_check_ms: Option<u64>,
    pub next_check_ms: Option<u64>,
}

impl View {
    pub fn percent(&self) -> Option<u8> {
        let (done, total) = self.bytes?;
        let total = total.filter(|t| *t > 0)?;
        Some((done.min(total) * 100 / total) as u8)
    }
}

struct Inner {
    update: Option<Update>,
    found: Option<Found>,
    phase: Phase,
    bytes: Option<(u64, Option<u64>)>,
    error: Option<Failure>,
    failed_at_ms: Option<u64>,
    last_check_ms: Option<u64>,
    next_check_ms: Option<u64>,
    /// The counters of the núcleo already carried out: `(check, install)`.
    seen: (u64, u64),
    updated_from: Option<String>,
    updated_notes: Option<String>,
    notified: Option<String>,
    dir: Option<PathBuf>,
    mode: Mode,
    app_version: String,
}

/// The updater's state and the wake-up of its thread.
struct Tracker {
    inner: Mutex<Inner>,
    wake: Mutex<Sender<bool>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The first non-empty line of the release notes, cut to one line of the card.
pub fn first_line(notes: &str) -> Option<String> {
    let line = notes.lines().map(|l| l.trim().trim_start_matches(['#', '-', '*']).trim()).find(|l| !l.is_empty())?;
    Some(line.chars().take(200).collect())
}

/// What the núcleo asks for that the app has not done yet: `(check, install)`. `seen` follows the
/// núcleo down when it restarted (its counters began again at zero).
pub fn pending_requests(seen: &mut (u64, u64), asked: (u64, u64)) -> (bool, bool) {
    let check = asked.0 > seen.0;
    let install = asked.1 > seen.1;
    *seen = asked;
    (check, install)
}

/// The updater's public key in tauri.conf.json, if it is not empty.
fn public_key(app: &AppHandle) -> Option<String> {
    let key = app.config().plugins.0.get("updater")?.get("pubkey")?.as_str()?.trim();
    (!key.is_empty()).then(|| key.to_string())
}

fn read_file(dir: &Option<PathBuf>, name: &str) -> Option<String> {
    std::fs::read_to_string(dir.as_ref()?.join(name)).ok()
}

fn write_file(dir: &Option<PathBuf>, name: &str, text: &str) {
    let Some(dir) = dir else { return };
    let _ = std::fs::create_dir_all(dir);
    if let Err(e) = std::fs::write(dir.join(name), text) {
        eprintln!("[ahrena-console] update: could not write {name}: {e}");
    }
}

/// Registers the updater and starts its thread. Without a key, it does nothing.
pub fn watch(app: &AppHandle) -> tauri::Result<()> {
    if public_key(app).is_none() {
        return Ok(());
    }
    app.plugin(tauri_plugin_updater::Builder::new().build())?;
    let current = app.package_info().version.to_string();
    let dir = app.path().app_data_dir().ok();
    // Restarted into a new version: the "Atualizado" card says what changed, once.
    let previous = read_file(&dir, VERSION_FILE).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    write_file(&dir, VERSION_FILE, &current);
    let updated_from = previous.filter(|p| *p != current);
    let notified: Option<Value> = read_file(&dir, NOTIFIED_FILE).and_then(|s| serde_json::from_str(&s).ok());
    let notified_version = notified.as_ref().and_then(|v| v["version"].as_str()).map(str::to_string);
    let updated_notes = notified.as_ref().filter(|_| notified_version.as_deref() == Some(current.as_str())).and_then(|v| v["notes"].as_str()).map(str::to_string);
    let mode = Mode::of(&current);
    let (wake, woken) = channel::<bool>();
    app.manage(Tracker {
        inner: Mutex::new(Inner {
            update: None,
            found: None,
            phase: Phase::Idle,
            bytes: None,
            error: None,
            failed_at_ms: None,
            last_check_ms: None,
            next_check_ms: None,
            seen: (0, 0),
            updated_notes: updated_from.as_ref().and(updated_notes),
            updated_from,
            notified: notified_version,
            dir,
            mode,
            app_version: current,
        }),
        wake: Mutex::new(wake),
    });
    let app = app.clone();
    std::thread::spawn(move || {
        let mut announce = false;
        let mut manual = false;
        loop {
            check(&app, manual, announce);
            let wait = mode.interval();
            with(&app, |t| t.next_check_ms = Some(now_ms() + wait.as_millis() as u64));
            publish(&app);
            crate::redraw_now(&app);
            match woken.recv_timeout(wait) {
                Ok(from_tray) => {
                    manual = true;
                    announce = from_tray;
                }
                Err(RecvTimeoutError::Timeout) => {
                    manual = false;
                    announce = false;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Ok(())
}

fn with<R>(app: &AppHandle, f: impl FnOnce(&mut Inner) -> R) -> Option<R> {
    let tracker = app.try_state::<Tracker>()?;
    let mut inner = tracker.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Some(f(&mut inner))
}

/// One check. `manual`: the person asked, so it shows "procurando" and its error. `announce`: it came
/// from the tray, whose menu closed, so the result goes out as a notification.
fn check(app: &AppHandle, manual: bool, announce: bool) {
    // A download in progress owns the state: a check now would reset its phase and its update.
    if with(app, |t| t.phase.is_busy()).unwrap_or(true) {
        return;
    }
    if manual {
        with(app, |t| {
            t.phase = Phase::Checking;
            t.error = None;
        });
        publish(app);
        crate::redraw_now(app);
    }
    let outcome = app.updater().and_then(|u| tauri::async_runtime::block_on(u.check()));
    let now = now_ms();
    let mut notice = None;
    // Asked before the tracker's lock: the tray holds the shared state while it reads the tracker.
    let notices_on = crate::notices_on(app);
    match outcome {
        Ok(Some(update)) => {
            let found = Found { version: update.version.clone(), notes: update.body.as_deref().and_then(first_line), published_at: update.date.map(|d| d.to_string()) };
            with(app, |t| {
                // An install started while the check ran: it took the update, leave the state to it.
                if t.phase.is_busy() {
                    return;
                }
                t.update = Some(update);
                t.found = Some(found.clone());
                t.phase = Phase::Idle;
                t.error = None;
                t.last_check_ms = Some(now);
                // With the notifications off the version stays unnotified, so turning them on tells it.
                if notices_on && t.notified.as_deref() != Some(found.version.as_str()) {
                    t.notified = Some(found.version.clone());
                    write_file(&t.dir, NOTIFIED_FILE, &json!({ "version": found.version, "notes": found.notes }).to_string());
                    notice = Some(Notice::update_available(&found.version, found.notes.as_deref(), &t.app_version));
                }
            });
        }
        Ok(None) => {
            with(app, |t| {
                if t.phase.is_busy() {
                    return;
                }
                t.update = None;
                t.found = None;
                t.phase = Phase::Idle;
                t.error = None;
                t.last_check_ms = Some(now);
                if announce {
                    notice = Some(Notice::up_to_date(&t.app_version));
                }
            });
        }
        Err(e) => {
            eprintln!("[ahrena-console] update: {e}");
            with(app, |t| {
                if t.phase.is_busy() {
                    return;
                }
                t.last_check_ms = Some(now);
                if manual {
                    t.phase = Phase::Error;
                    t.error = Some(Failure::of_check(&e));
                    t.failed_at_ms = Some(now);
                } else if t.phase == Phase::Checking {
                    t.phase = Phase::Idle;
                }
            });
        }
    }
    if let Some(n) = notice {
        if notices_on {
            crate::notify(app, &[n]);
        }
    }
}

/// "Buscar agora": wakes the thread. `from_tray`: the result also goes out as a notification.
pub fn check_now(app: &AppHandle, from_tray: bool) {
    let Some(tracker) = app.try_state::<Tracker>() else { return };
    let busy = tracker.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner).phase;
    if matches!(busy, Phase::Checking | Phase::Downloading | Phase::Installing) {
        return;
    }
    let _ = tracker.wake.lock().unwrap_or_else(std::sync::PoisonError::into_inner).send(from_tray);
}

/// Downloads, installs and relaunches. If it fails, the update is pending again (the card offers
/// "Tentar de novo"). `from_window`: the /ui card asked, so the card already says the failure;
/// from the tray or the notification, with the window possibly closed, it also notifies.
pub fn install(app: &AppHandle, from_window: bool) {
    let Some(update) = with(app, |t| {
        if matches!(t.phase, Phase::Downloading | Phase::Installing) {
            return None;
        }
        let update = t.update.take()?;
        t.phase = Phase::Downloading;
        t.bytes = Some((0, None));
        t.error = None;
        Some(update)
    })
    .flatten() else {
        return;
    };
    publish(app);
    crate::redraw_now(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let (progress_app, finish_app) = (app.clone(), app.clone());
        let mut done = 0u64;
        let mut last = Instant::now() - Duration::from_secs(1);
        let on_chunk = move |chunk: usize, total: Option<u64>| {
            done += chunk as u64;
            with(&progress_app, |t| t.bytes = Some((done, total)));
            if last.elapsed() >= Duration::from_millis(300) {
                last = Instant::now();
                publish(&progress_app);
                crate::redraw_now(&progress_app);
            }
        };
        let on_finish = move || {
            with(&finish_app, |t| t.phase = Phase::Installing);
            publish(&finish_app);
            crate::redraw_now(&finish_app);
        };
        match tauri::async_runtime::block_on(update.download_and_install(on_chunk, on_finish)) {
            Ok(()) => app.restart(),
            Err(e) => {
                eprintln!("[ahrena-console] install update {}: {e}", update.version);
                let failure = Failure::of_download(&e);
                let notice = with(&app, |t| {
                    let version = update.version.clone();
                    t.update = Some(update);
                    t.phase = Phase::Error;
                    t.bytes = None;
                    t.error = Some(failure);
                    t.failed_at_ms = Some(now_ms());
                    (!from_window).then(|| Notice::update_failed(&version, &failure.explain(&t.app_version)))
                })
                .flatten();
                publish(&app);
                crate::redraw_now(&app);
                if let Some(n) = notice {
                    if crate::notices_on(&app) {
                        crate::notify(&app, &[n]);
                    }
                }
            }
        }
    });
}

/// "Depois" in the notification: the same as the card's, kept by the núcleo.
pub fn later(app: &AppHandle) {
    let (Some(port), Some(version)) = (crate::core_port_of(app), with(app, |t| t.found.as_ref().map(|f| f.version.clone())).flatten()) else { return };
    std::thread::spawn(move || {
        let body = json!({ "version": version }).to_string();
        let r = crate::http::post_json(port, "/api/app-update/actions/dismiss", &body);
        if r.as_ref().map(|r| r.status) != Some(200) {
            eprintln!("[ahrena-console] update: Depois did not reach the core");
        }
    });
}

/// What the tray draws; `None` when the updater is off (no key).
pub fn view(app: &AppHandle) -> Option<View> {
    with(app, |t| View { phase: t.phase, version: t.found.as_ref().map(|f| f.version.clone()), bytes: t.bytes, failed_at_ms: t.failed_at_ms, last_check_ms: t.last_check_ms, next_check_ms: t.next_check_ms })
}

fn report(inner: &Inner) -> String {
    json!({
        "appVersion": inner.app_version,
        "mode": inner.mode.name(),
        "available": inner.found.as_ref().map(|f| json!({ "version": f.version, "notes": f.notes, "publishedAt": f.published_at })),
        "phase": inner.phase.name(),
        "progress": inner.bytes.map(|(done, total)| json!({ "done": done, "total": total })),
        "error": inner.error.map(Failure::name),
        "lastCheckAt": inner.last_check_ms,
        "nextCheckAt": inner.next_check_ms,
        "updatedFrom": inner.updated_from,
        "updatedNotes": inner.updated_notes,
    })
    .to_string()
}

/// Reports the state to the núcleo, if it is up.
pub fn publish(app: &AppHandle) {
    let Some(port) = crate::core_port_of(app) else { return };
    let Some(body) = with(app, |t| report(t)) else { return };
    if crate::http::put_json(port, STATE_PATH, &body).map(|r| r.status) != Some(200) {
        eprintln!("[ahrena-console] update: the core did not take the state");
    } else {
        // The "Atualizado" card is said once: a núcleo that restarts alone must not bring it back.
        with(app, |t| {
            t.updated_from = None;
            t.updated_notes = None;
        });
    }
}

/// Called by the core loop each time `/api/changes` wakes it: tells the núcleo the state when it does
/// not have it yet (it just started), and carries out the clicks of the /ui.
pub fn sync(app: &AppHandle, port: u16) {
    if app.try_state::<Tracker>().is_none() {
        return;
    }
    let Some(body) = crate::http::get(port, "/api/app-update", Duration::from_secs(5)) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&body) else { return };
    if v["app"].as_bool() != Some(true) {
        // A core that restarted: its counters began again, so ours must too.
        with(app, |t| t.seen = (0, 0));
        publish(app);
        return;
    }
    let asked = (v["requests"]["check"].as_u64().unwrap_or(0), v["requests"]["install"].as_u64().unwrap_or(0));
    let (check, install) = with(app, |t| pending_requests(&mut t.seen, asked)).unwrap_or((false, false));
    if install {
        install_from(app);
    } else if check {
        check_now(app, false);
    }
}

fn install_from(app: &AppHandle) {
    install(app, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_follows_the_version() {
        assert_eq!(Mode::of("0.0.10"), Mode::Dev);
        assert_eq!(Mode::of("0.9.0"), Mode::Dev);
        assert_eq!(Mode::of("1.0.0"), Mode::Stable);
        assert_eq!(Mode::of("2.3.1"), Mode::Stable);
        assert_eq!(Mode::of("1.2.0-dev.3"), Mode::Dev);
        assert_eq!(Mode::of("1.2.0-rc.1"), Mode::Stable);
        assert_eq!(Mode::of("v1.2.0"), Mode::Stable);
    }

    #[test]
    fn the_interval_is_ten_minutes_in_dev_and_six_hours_in_stable() {
        assert_eq!(Mode::Dev.interval(), Duration::from_secs(600));
        assert_eq!(Mode::Stable.interval(), Duration::from_secs(21_600));
    }

    #[test]
    fn the_notes_become_one_line() {
        assert_eq!(first_line("\n## Aviso de versão nova\n- outra coisa").as_deref(), Some("Aviso de versão nova"));
        assert_eq!(first_line("  \n  ").as_deref(), None);
        assert_eq!(first_line(&"a".repeat(500)).map(|l| l.chars().count()), Some(200));
    }

    #[test]
    fn a_click_is_carried_out_once_and_a_restarted_core_starts_over() {
        let mut seen = (0, 0);
        assert_eq!(pending_requests(&mut seen, (0, 0)), (false, false));
        assert_eq!(pending_requests(&mut seen, (1, 0)), (true, false));
        assert_eq!(pending_requests(&mut seen, (1, 0)), (false, false));
        assert_eq!(pending_requests(&mut seen, (1, 1)), (false, true));
        // The core restarted: counters back to zero, then a new click.
        assert_eq!(pending_requests(&mut seen, (0, 0)), (false, false));
        assert_eq!(pending_requests(&mut seen, (1, 0)), (true, false));
    }

    #[test]
    fn only_a_download_or_an_install_is_busy() {
        assert!(Phase::Downloading.is_busy() && Phase::Installing.is_busy());
        assert!(!Phase::Idle.is_busy() && !Phase::Checking.is_busy() && !Phase::Error.is_busy());
    }

    #[test]
    fn the_percent_of_a_download() {
        let v = |bytes| View { phase: Phase::Downloading, version: None, bytes, failed_at_ms: None, last_check_ms: None, next_check_ms: None };
        assert_eq!(v(Some((5_200_000, Some(12_400_000)))).percent(), Some(41));
        assert_eq!(v(Some((1, None))).percent(), None);
        assert_eq!(v(Some((9, Some(0)))).percent(), None);
        assert_eq!(v(Some((20, Some(10)))).percent(), Some(100));
        assert_eq!(v(None).percent(), None);
    }

    #[test]
    fn the_report_is_what_the_core_takes() {
        let inner = Inner {
            update: None,
            found: Some(Found { version: "0.0.10".into(), notes: Some("Aviso".into()), published_at: None }),
            phase: Phase::Downloading,
            bytes: Some((10, Some(100))),
            error: None,
            failed_at_ms: None,
            last_check_ms: Some(1),
            next_check_ms: Some(2),
            seen: (0, 0),
            updated_from: None,
            updated_notes: None,
            notified: None,
            dir: None,
            mode: Mode::Dev,
            app_version: "0.0.9".into(),
        };
        let v: Value = serde_json::from_str(&report(&inner)).unwrap();
        assert_eq!(v["appVersion"], "0.0.9");
        assert_eq!(v["mode"], "dev");
        assert_eq!(v["available"]["version"], "0.0.10");
        assert_eq!(v["phase"], "downloading");
        assert_eq!(v["progress"]["done"], 10);
        assert_eq!(v["error"], Value::Null);
    }
}
