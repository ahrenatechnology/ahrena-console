// The Ahrena Console desktop app (decision 0005, issue #87): a tray in the menu bar.
//
// On opening:
// 1. fixes the PATH with the login shell's, to find `node`;
// 2. starts its own core (or adopts it, within the app's installation), on a random port and in
//    the app's data folder (core.rs); it never uses another installation's core;
// 3. reads `GET /api/attention` and waits for changes on `GET /api/changes` (long polling), and
//    builds the menu of wireframes A1, A2 and A4 (menu.rs), with the number next to the icon;
// 4. a click on a session opens it in Claude Desktop (`POST /open/<local_…>`); "Abrir o console"
//    opens the core's `/ui` in a window;
// 5. notifies through a system notification whoever starts needing you (A3, notifications.rs);
// 5a. reads the machines and their telemetry (`/api/machines`, `/api/telemetry`) for the "Máquinas"
//     block (A6, A7, machines.rs) and notifies, silently, a new machine alert (#180);
// 6. with the updater key in tauri.conf.json, looks for a new version on opening and every 6 h
//    (updater.rs) and offers it in the menu;
// 7. opened by hand, also opens the console; opened at login, stays in the tray only (login.rs).
// The app writes no hooks nor Claude configuration, bundles no Node and has no screens of its own.

mod core;
mod http;
mod login;
mod machines;
mod menu;
#[cfg(target_os = "macos")]
mod native;
#[cfg(target_os = "macos")]
mod native_notice;
mod notifications;
mod shell_path;
mod updater;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};

use login::Registration;
use machines::Machine;
use menu::{Attention, CoreState, Dot, Item};
use notifications::{Notice, Notices};

const TRAY: &str = "ahrena";
const ICON: &[u8] = include_bytes!("../icons/tray.png");
const ICON_2X: &[u8] = include_bytes!("../icons/tray@2x.png");

/// What the tray shows; the menu is rebuilt when it changes.
struct State {
    core: CoreState,
    attention: Option<Attention>,
    no_attention: bool,
    /// The machines of `/api/machines` with their telemetry (#180); `None` without telemetry.
    machines: Option<Vec<Machine>>,
    /// Consecutive reads of `/api/machines` that did not answer; see `count_machine_misses`.
    machine_misses: u32,
    /// The notifications' detector and silence; the "Notificações" check is `notices.silence.enabled`.
    notices: Notices,
    /// The `SMAppService` status is `enabled` (login.rs), reread on every menu.
    login: bool,
    /// `session id` → Claude Desktop's `local_…`, from the last menu.
    locals: HashMap<String, Option<String>>,
    last: Option<(Vec<Item>, Option<String>)>,
    /// The new version the updater found.
    update: Option<String>,
    /// "Abrir o console" was clicked while the core was not up: open it once the core is.
    open_when_up: bool,
}

type Shared = Arc<Mutex<State>>;

/// Requests to the core loop: "Procurar o núcleo de novo".
struct CoreLoop(Mutex<Sender<()>>);

fn main() {
    shell_path::fix_path();

    let state: Shared = Arc::new(Mutex::new(State {
        core: CoreState::Searching,
        attention: None,
        no_attention: false,
        machines: None,
        machine_misses: 0,
        notices: Notices::default(),
        login: false,
        locals: HashMap::new(),
        last: None,
        update: None,
        open_when_up: false,
    }));
    let (wake, signals) = channel::<()>();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_console(app)))
        .plugin(tauri_plugin_notification::init())
        .manage(state.clone())
        .manage(CoreLoop(Mutex::new(wake)))
        .setup(move |app| {
            // The launch Apple Event is still in progress here, in `applicationDidFinishLaunching`.
            let variable = core::env_var("AHRENA_CONSOLE_LAUNCH_ORIGIN", "AHRENA_ORIGEM");
            let (origin, source) = login::detect(variable.as_deref(), login::launch_event());
            eprintln!("[ahrena-console] origin: {} ({source})", origin.name());
            let open_at_launch = login::opens_window_at_launch(origin);
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                native::listen();
            }
            state.lock().unwrap().notices = Notices::open(notifications::file_path(app.path().app_data_dir().ok()));
            #[cfg(target_os = "macos")]
            {
                let main_thread = objc2::MainThreadMarker::new().expect("Tauri's setup runs on the main thread");
                native_notice::start(app.handle(), native_notice::Handlers { open: open_window_at, open_in_desktop, silence }, main_thread);
            }
            TrayIconBuilder::with_id(TRAY)
                .icon(Image::from_bytes(ICON)?)
                .icon_as_template(true)
                .tooltip("Ahrena Console")
                .on_menu_event(|app, ev| click(app, ev.id().as_ref()))
                .build(app)?;
            #[cfg(target_os = "macos")]
            if let Some(t) = app.tray_by_id(TRAY) {
                let _ = t.with_inner_tray_icon(|t| {
                    if let Some(item) = t.ns_status_item() {
                        native::template_icon(&item, &[ICON, ICON_2X]);
                    }
                });
            }
            redraw(app.handle(), &state);
            let for_the_menu = state.clone();
            if let Err(e) = updater::watch(app.handle(), move |app, version| change(app, &for_the_menu, |s| s.update = Some(version))) {
                eprintln!("[ahrena-console] updater: {e}");
            }

            let resources = app.path().resource_dir().ok();
            let data_dir = app.path().app_data_dir().ok();
            let handle = app.handle().clone();
            std::thread::spawn(move || follow(handle, state, core::core_dir(resources), data_dir, signals, open_at_launch));
            open_menu_later(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the app");

    app.run(|app, ev| {
        // Opening again from the Finder, Dock or Spotlight with the app already up (e.g. opened at
        // login, tray only) arrives here, not in single-instance: it opens the console.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = ev {
            open_console(app);
        }
        // Closing the console window only hides it: the app lives in the tray, and the last window
        // never closes (closing would ask to quit). Quit, logout and shutdown proceed as usual.
        if let RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } = ev {
            if let Some(w) = app.get_webview_window(&label) {
                api.prevent_close();
                let _ = w.hide();
            }
        }
    });
}

/// The core loop: starts the app's own core, reads the attention and waits for changes. Runs on its
/// own thread. `data_dir`: the app's data folder, where its core keeps database, log and clients.
/// `open_at_launch`: opens the console if the core is up already on the first attempt (a launch by
/// hand); if it only comes up later (no Node, "Procurar de novo"), the console does not show up by
/// itself.
fn follow(app: AppHandle, state: Shared, dir: PathBuf, data_dir: Option<PathBuf>, signals: std::sync::mpsc::Receiver<()>, mut open_at_launch: bool) {
    loop {
        change(&app, &state, |s| {
            s.core = CoreState::Searching;
            s.attention = None;
            s.no_attention = false;
            s.machines = None;
            s.notices.detector.reset();
            s.notices.machines.reset();
        });
        let outcome = core::start_own_core(&dir, data_dir.as_deref());
        let open = std::mem::take(&mut open_at_launch);
        let core = match outcome.core {
            Some(core) => {
                eprintln!("[ahrena-console] core on port {} (pid {:?}, {})", core.port, core.pid, if outcome.started { "started" } else { "adopted" });
                core
            }
            None => {
                let stopped = outcome.state;
                // A click on "Abrir o console" waited for this start; it failed, so it is dropped
                // instead of opening the console by surprise when a core comes up much later.
                change(&app, &state, |s| {
                    s.core = stopped;
                    s.open_when_up = false;
                });
                // Tries again every 30 s, or right away, on "Procurar o núcleo de novo".
                if let Err(RecvTimeoutError::Disconnected) = signals.recv_timeout(Duration::from_secs(30)) {
                    return;
                }
                continue;
            }
        };
        let mut asked = false;
        change(&app, &state, |s| {
            s.core = CoreState::Up { port: core.port };
            asked = std::mem::take(&mut s.open_when_up);
        });
        // A new core has a new port: a console window left on the old one follows it.
        let port = core.port;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || follow_core_port(&handle, port));
        if open || asked {
            eprintln!("[ahrena-console] {}: opening the console", if asked { "asked from the menu" } else { "launched by hand" });
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || open_console(&handle));
        }
        watch_core(&app, &state, &core, &signals);
        // The core stopped answering: look for it (and start it) again.
        while signals.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// Reads `/api/attention` and waits on `/api/changes` until the core stops answering.
fn watch_core(app: &AppHandle, state: &Shared, core: &core::Core, signals: &std::sync::mpsc::Receiver<()>) {
    let port = core.port;
    let mut cursor: Option<String> = None;
    loop {
        let response = http::get_with_status(port, "/api/attention", Duration::from_secs(15));
        match response {
            Some(r) if r.status == 200 => {
                let Some(attention) = Attention::from_json(&r.body) else { return };
                cursor = attention.cursor.clone().or(cursor);
                // Sessions first: a slow `/api/machines` must not hold back their notices.
                let mut new = Vec::new();
                change(app, state, |s| {
                    new = s.notices.read(&attention);
                    s.attention = Some(attention);
                    s.no_attention = false;
                });
                notify(app, &new);
                let read = read_machines(port);
                let mut new = Vec::new();
                change(app, state, |s| {
                    let (misses, drop) = count_machine_misses(s.machine_misses, matches!(read, MachinesRead::NoAnswer));
                    s.machine_misses = misses;
                    match read {
                        MachinesRead::Read(ms) => {
                            new = s.notices.read_machines(&ms);
                            s.machines = Some(ms);
                        }
                        MachinesRead::NoTelemetry => {
                            s.machines = None;
                            s.notices.machines.reset();
                        }
                        // A hiccup keeps the last block and its detector, so it neither hides nor
                        // re-notifies; a run of them drops the block instead of showing it stale.
                        MachinesRead::NoAnswer => {
                            if drop {
                                s.machines = None;
                                s.notices.machines.reset();
                            }
                        }
                    }
                });
                notify(app, &new);
            }
            // A core from before #87: up, but without the list. Rereads every 30 s.
            Some(r) if r.status == 404 => {
                change(app, state, |s| {
                    s.attention = None;
                    s.no_attention = true;
                    s.machines = None;
                    s.notices.detector.reset();
                    s.notices.machines.reset();
                });
                let _ = signals.recv_timeout(Duration::from_secs(30));
                if !core.answers() {
                    return;
                }
                continue;
            }
            _ => return,
        }
        // "Procurar o núcleo de novo" with the core up: only rereads.
        while signals.try_recv().is_ok() {}
        let start = Instant::now();
        let path = match &cursor {
            Some(c) => format!("/api/changes?since={}&wait=25", http::encode(c)),
            None => "/api/changes?wait=25".into(),
        };
        // Returns with changes, with `reset` or after 25 s with nothing: in every case it rereads,
        // which also updates the waiting minutes. Without `/api/changes` (an old core), it rereads
        // every 25 s.
        if http::get(port, &path, Duration::from_secs(40)).is_none() {
            let rest = Duration::from_secs(25).saturating_sub(start.elapsed());
            if !core.answers() {
                return;
            }
            let _ = signals.recv_timeout(rest);
        }
    }
}

/// What one read of the machines gave (#180).
enum MachinesRead {
    Read(Vec<Machine>),
    /// `/api/machines` is 404 (a core without telemetry) or lists no machine: no "Máquinas" block.
    NoTelemetry,
    /// The route did not answer or did not parse.
    NoAnswer,
}

/// `GET /api/machines`, then `GET /api/telemetry?machine=<id>` for each one. A telemetry that does
/// not come leaves that machine with its summary only.
fn read_machines(port: u16) -> MachinesRead {
    let wait = Duration::from_secs(5);
    let r = match http::get_with_status(port, "/api/machines", wait) {
        Some(r) if r.status == 404 => return MachinesRead::NoTelemetry,
        Some(r) if r.status == 200 => r,
        Some(r) => {
            eprintln!("[ahrena-console] machines: /api/machines answered {}", r.status);
            return MachinesRead::NoAnswer;
        }
        None => {
            eprintln!("[ahrena-console] machines: /api/machines did not answer");
            return MachinesRead::NoAnswer;
        }
    };
    let summaries = match machines::summaries_from_json(&r.body) {
        Ok(summaries) => summaries,
        Err(err) => {
            eprintln!("[ahrena-console] machines: /api/machines did not parse: {err}");
            return MachinesRead::NoAnswer;
        }
    };
    if summaries.is_empty() {
        return MachinesRead::NoTelemetry;
    }
    MachinesRead::Read(
        summaries
            .into_iter()
            .map(|summary| {
                let path = format!("/api/telemetry?machine={}", http::encode(&summary.id));
                let telemetry = http::get(port, &path, wait).and_then(|t| {
                    machines::telemetry_from_json(&t)
                        .map_err(|err| eprintln!("[ahrena-console] machines: telemetry of {}: {err}", summary.id))
                        .ok()
                });
                Machine { summary, telemetry }
            })
            .collect(),
    )
}

/// Consecutive `NoAnswer` reads after which the "Máquinas" block is dropped rather than kept stale.
const MACHINE_MISSES_TO_DROP: u32 = 3;

/// The miss count after one read of `/api/machines`, and whether the kept block must now be dropped.
/// Any read that answered resets the count.
fn count_machine_misses(misses: u32, no_answer: bool) -> (u32, bool) {
    if !no_answer {
        return (0, false);
    }
    let misses = misses.saturating_add(1);
    (misses, misses >= MACHINE_MISSES_TO_DROP)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn change(app: &AppHandle, state: &Shared, f: impl FnOnce(&mut State)) {
    f(&mut state.lock().unwrap());
    redraw(app, state);
}

/// Rebuilds the menu and the number, if they changed, on the main thread.
fn redraw(app: &AppHandle, state: &Shared) {
    let state = state.clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut s = state.lock().unwrap();
        // Always reread: the user may remove the item in Ajustes.
        s.login = login::checked(login::SystemRegistration.status());
        let version = handle.package_info().version.to_string();
        let items = menu::build(&menu::Input { core: &s.core, attention: s.attention.as_ref(), no_attention: s.no_attention, notifications: s.notices.silence.enabled, login: s.login, version: &version, update: s.update.as_deref(), machines: s.machines.as_deref(), now_ms: now_ms() });
        let title = menu::tray_title(&s.core, s.attention.as_ref());
        if s.last.as_ref() == Some(&(items.clone(), title.clone())) {
            return;
        }
        let Some(tray) = handle.tray_by_id(TRAY) else { return };
        match native_menu(&handle, &items) {
            Ok(m) => {
                let _ = tray.set_menu(Some(m));
                #[cfg(target_os = "macos")]
                native::apply("Ahrena Console", &tweaks(&items));
            }
            Err(err) => eprintln!("[ahrena-console] menu: {err}"),
        }
        let _ = tray.set_title(title.as_deref());
        s.locals = items
            .iter()
            .filter_map(|i| match i {
                Item::Session { id, local, .. } => Some((id.clone(), local.clone())),
                _ => None,
            })
            .collect();
        s.last = Some((items, title));
    });
}

fn native_menu(app: &AppHandle, items: &[Item]) -> tauri::Result<Menu<Wry>> {
    let mut natives: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for (n, i) in items.iter().enumerate() {
        let id = |s: &str| format!("{s}#{n}");
        let next: Box<dyn IsMenuItem<Wry>> = match i {
            Item::Text { text, dot: Some(d) } => Box::new(IconMenuItem::with_id(app, id("text"), text, false, Some(dot_image(*d)), None::<&str>)?),
            Item::Text { text, dot: None } | Item::Detail(text) => Box::new(MenuItem::with_id(app, id("text"), text, false, None::<&str>)?),
            Item::Header { text, alternate } => {
                natives.push(Box::new(MenuItem::with_id(app, id("header"), text, false, None::<&str>)?));
                Box::new(MenuItem::with_id(app, id("header-alt"), alternate, false, None::<&str>)?)
            }
            Item::Session { id: session, text, alternate, dot, local, .. } => {
                let main = Box::new(IconMenuItem::with_id(app, format!("{}{session}", menu::SESSION), text, true, Some(dot_image(*dot)), None::<&str>)?);
                // A remote session has no ⌥ item: this Mac's Claude Desktop does not know it.
                let Some(alternate) = alternate else {
                    natives.push(main);
                    continue;
                };
                natives.push(main);
                Box::new(IconMenuItem::with_id(app, format!("{}{session}", menu::SESSION_IN_DESKTOP), alternate, local.is_some(), Some(dot_image(*dot)), None::<&str>)?)
            }
            // The row and the alerts of one machine share its id; `#n` keeps each menu id unique.
            Item::Machine { id: machine, text, dot } => Box::new(IconMenuItem::with_id(app, format!("{}{machine}#{n}", menu::MACHINE), text, true, Some(dot_image(*dot)), None::<&str>)?),
            Item::Action { id, text, shortcut } => Box::new(MenuItem::with_id(app, *id, text, true, *shortcut)?),
            Item::Check { id, text, checked } => Box::new(CheckMenuItem::with_id(app, *id, *text, true, *checked, None::<&str>)?),
            Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        };
        natives.push(next);
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = natives.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

#[cfg(target_os = "macos")]
fn tweaks(items: &[Item]) -> Vec<native::Tweak> {
    use native::Tweak;
    let mut t = Vec::new();
    for i in items {
        match i {
            Item::Header { alternate, .. } => t.push(Tweak::Alternate(alternate.clone())),
            Item::Session { text, alternate, tooltip, .. } => {
                t.push(Tweak::Tooltip { title: text.clone(), tooltip: tooltip.clone() });
                if let Some(alternate) = alternate {
                    t.push(Tweak::Alternate(alternate.clone()));
                    t.push(Tweak::Tooltip { title: alternate.clone(), tooltip: tooltip.clone() });
                }
            }
            Item::Detail(d) => t.push(Tweak::Indent(d.clone())),
            _ => {}
        }
    }
    t
}

/// The wireframes' coloured dot, drawn at 36 px (18 pt in the menu, sharp on a Retina screen).
fn dot_image(d: Dot) -> Image<'static> {
    const SIDE: u32 = 36;
    let (color, hollow) = match d {
        Dot::Green => ([0x1b, 0xaf, 0x7a], false),
        Dot::Red => ([0xe3, 0x49, 0x48], false),
        Dot::Yellow => ([0xff, 0xc3, 0x0a], false),
        Dot::Orange => ([0xf4, 0x77, 0x20], false),
        Dot::Empty => ([0xa6, 0xa6, 0xaa], true),
    };
    let (center, radius) = (SIDE as f32 / 2.0, 7.0_f32);
    let mut rgba = Vec::with_capacity((SIDE * SIDE * 4) as usize);
    for y in 0..SIDE {
        for x in 0..SIDE {
            let d = ((x as f32 + 0.5 - center).powi(2) + (y as f32 + 0.5 - center).powi(2)).sqrt();
            // Smoothed edge; the hollow one is a 2 px ring.
            let outside = (d - radius + 0.5).clamp(0.0, 1.0);
            let inside = if hollow { (radius - 2.0 - d + 0.5).clamp(0.0, 1.0) } else { 0.0 };
            let alpha = ((1.0 - outside) * (1.0 - inside) * 255.0) as u8;
            rgba.extend_from_slice(&[color[0], color[1], color[2], alpha]);
        }
    }
    Image::new_owned(rgba, SIDE, SIDE)
}

/// `AHRENA_CONSOLE_OPEN_MENU_AFTER=<s>` (old name `AHRENA_ABRIR_MENU`) opens the menu by itself
/// after that many seconds, for the tray screenshots and hand tests without clicking.
fn open_menu_later(app: &AppHandle) {
    let Some(seconds) = core::env_var("AHRENA_CONSOLE_OPEN_MENU_AFTER", "AHRENA_ABRIR_MENU").and_then(|s| s.parse::<u64>().ok()) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        if let Some(t) = app.tray_by_id(TRAY) {
            if let Ok(Some(r)) = t.rect() {
                eprintln!("[ahrena-console] tray at {:?} {:?}", r.position, r.size);
            }
            let _ = t.with_inner_tray_icon(|t| t.show_menu());
        }
    });
}

fn click(app: &AppHandle, id: &str) {
    let state = app.state::<Shared>().inner().clone();
    match id {
        menu::ID_OPEN => open_console(app),
        menu::ID_QUIT => app.exit(0),
        menu::ID_NOTIFICATIONS => change(app, &state, |s| {
            s.notices.toggle();
        }),
        menu::ID_LOGIN => {
            login::click(&login::SystemRegistration);
            // The click already flipped the native check: rebuild the menu even without a change (error, approval).
            change(app, &state, |s| s.last = None);
        }
        menu::ID_UPDATE => updater::install(app),
        menu::ID_SEARCH_AGAIN => {
            let _ = app.state::<CoreLoop>().0.lock().unwrap().send(());
        }
        menu::ID_INSTALL_NODE => {
            let _ = std::process::Command::new("open").arg("https://nodejs.org/en/download").spawn();
        }
        _ if id.starts_with(menu::MACHINE) => {
            let machine = id[menu::MACHINE.len()..].split('#').next().unwrap_or("");
            open_window_at(app, &machines::machine_path(machine));
        }
        _ => {
            let session = id.strip_prefix(menu::SESSION).or_else(|| id.strip_prefix(menu::SESSION_IN_DESKTOP));
            if let Some(session) = session {
                open_session(app, &state, session);
            }
        }
    }
}

/// For now, both ways open in Claude Desktop; the app window (A5) comes with #26.
fn open_session(app: &AppHandle, state: &Shared, session: &str) {
    let local = state.lock().unwrap().locals.get(session).cloned().flatten();
    open_in_desktop(app, local);
}

/// `POST /open/<local_…>` on the core; without `local`, or with one the core would refuse, the console.
fn open_in_desktop(app: &AppHandle, local: Option<String>) {
    let port = match app.state::<Shared>().lock().unwrap_or_else(std::sync::PoisonError::into_inner).core {
        CoreState::Up { port } => port,
        _ => return,
    };
    let Some(local) = local else { return open_console(app) };
    if !notifications::valid_local(&local) {
        eprintln!("[ahrena-console] open: invalid local {local:?}, opening the console");
        return open_console(app);
    }
    std::thread::spawn(move || {
        let r = http::post_json(port, &format!("/open/{local}"), "{}");
        if r.as_ref().map(|r| r.status) != Some(200) {
            eprintln!("[ahrena-console] open {local}: {}", r.map(|r| format!("{} {}", r.status, r.body)).unwrap_or_else(|| "no answer".into()));
        }
    });
}

fn open_console(app: &AppHandle) {
    open_window(app, None);
}

/// The window at a `/ui` path (a session's or a machine's screen), navigating the one already
/// open: the click on a notification and on a machine row.
fn open_window_at(app: &AppHandle, path: &str) {
    open_window(app, Some(path));
}

fn open_window(app: &AppHandle, path: Option<&str>) {
    // Only the app's own core: with it not up, look for it again (and open once it is) instead of
    // opening another one.
    let shared = app.state::<Shared>().inner().clone();
    let port = {
        let mut s = shared.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match s.core {
            CoreState::Up { port } => port,
            _ => {
                s.open_when_up = true;
                drop(s);
                let _ = app.state::<CoreLoop>().0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).send(());
                return;
            }
        }
    };
    let Ok(url) = format!("http://127.0.0.1:{port}{}", path.unwrap_or("/ui")).parse::<tauri::Url>() else { return };
    if let Some(w) = app.get_webview_window("console") {
        // The port is random: a window still on another port (an old core) is moved to this one.
        if path.is_some() || w.url().ok().and_then(|u| u.port()) != Some(port) {
            let _ = w.navigate(url);
        }
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let window = WebviewWindowBuilder::new(app, "console", WebviewUrl::External(url)).title("Ahrena Console").inner_size(1100.0, 760.0).build();
    if let Ok(w) = window {
        let _ = w.set_focus();
    }
}

/// Moves an existing console window to the `/ui` of the core on `port`, if it shows another port.
fn follow_core_port(app: &AppHandle, port: u16) {
    let Some(w) = app.get_webview_window("console") else { return };
    if w.url().ok().and_then(|u| u.port()) == Some(port) {
        return;
    }
    if let Ok(url) = format!("http://127.0.0.1:{port}/ui").parse::<tauri::Url>() {
        let _ = w.navigate(url);
    }
}

/// The notification's "Silenciar" action: silences the session and saves.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn silence(app: &AppHandle, session: &str) {
    app.state::<Shared>().lock().unwrap_or_else(std::sync::PoisonError::into_inner).notices.silence_session(session);
}

/// Shows the notices: through `UNUserNotificationCenter` (with click and actions) when it is on;
/// otherwise through the Tauri plugin, without click.
fn notify(app: &AppHandle, notices: &[Notice]) {
    use tauri_plugin_notification::NotificationExt;
    for n in notices {
        #[cfg(target_os = "macos")]
        if native_notice::active() {
            native_notice::send(n);
            continue;
        }
        let mut builder = app.notification().builder().title(&n.title).body(&n.body);
        if n.sound {
            // On macOS the plugin passes the name to `NSUserNotification`, which only knows this one.
            builder = builder.sound(if cfg!(target_os = "macos") { "NSUserNotificationDefaultSoundName" } else { "default" });
        }
        if let Err(err) = builder.show() {
            eprintln!("[ahrena-console] notification: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::count_machine_misses;

    #[test]
    fn machine_block_drops_after_three_consecutive_misses() {
        assert_eq!(count_machine_misses(0, true), (1, false));
        assert_eq!(count_machine_misses(1, true), (2, false));
        assert_eq!(count_machine_misses(2, true), (3, true));
        assert_eq!(count_machine_misses(3, true), (4, true), "stays dropped while it keeps missing");
    }

    #[test]
    fn any_answer_resets_the_miss_count() {
        assert_eq!(count_machine_misses(2, false), (0, false));
        assert_eq!(count_machine_misses(0, false), (0, false));
    }
}
