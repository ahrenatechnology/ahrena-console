// The A3 notification with click and actions, straight on `UNUserNotificationCenter`.
//
// Tauri's notification plugin has `on_action` and `register_action_types` on desktop, but on macOS
// it only reports the click through `NSUserNotification` (deprecated), with the actions in an
// "Opções" menu. Here the app uses `UNUserNotificationCenter`: it registers the category with
// "Abrir", "Abrir no Claude Desktop" and "Silenciar" (and, for a machine that went down with a
// reconnect command, "Reconectar" and "Abrir", #244), puts the session, the `local_…` and the
// machine in `userInfo`, asks for the presentation also with the app in the foreground and answers through
// the delegate.
//
// `UNUserNotificationCenter` kills the process when the app does not run from a bundle (a plain
// `cargo run`: the `mainBundle` without `bundleIdentifier`). In that case this module does not turn
// on, and main.rs falls back to the plugin; the app registers no `on_action` there, so it has no
// click nor actions.
//
// The center only keeps a weak reference to the delegate: it lives in a `thread_local` of the main
// thread (the `MainThreadMarker` of `start` guarantees the thread). The callbacks may arrive off
// it; window work goes through `run_on_main_thread`.
//
// Notifications already delivered stay in the Notification Center across an app update. Those of a
// version from before #173 phase 4 (app 0.0.1) carry the Portuguese category, action ids
// and `userInfo` key, which are not read since phase 6: their buttons do nothing.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, MainThreadMarker};
use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction, UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

use crate::notifications::{self, Action, Notice, Origin};

const SESSION_CATEGORY: &str = "session";
/// A machine alert (#180): only "Abrir", the machine has no Claude Desktop conversation to open
/// nor a session to silence.
const MACHINE_CATEGORY: &str = "machine";
/// "<label> sem conexão" of a machine with a reconnect command (#244, A8): "Reconectar" and "Abrir".
const MACHINE_RECONNECT_CATEGORY: &str = "machine-reconnect";
/// A remote session (#180): "Abrir" and "Silenciar", no "Abrir no Claude Desktop".
const REMOTE_SESSION_CATEGORY: &str = "remote-session";
const OPEN_ACTION: &str = "open";
const OPEN_IN_DESKTOP_ACTION: &str = "open-in-desktop";
const SILENCE_ACTION: &str = "silence";
const RECONNECT_ACTION: &str = "reconnect";
const SESSION_KEY: &str = "session";
const LOCAL_KEY: &str = "local";
/// The `/ui` path "Abrir" leads to (#180); without it, the session's screen.
const PATH_KEY: &str = "path";
/// The machine id "Reconectar" sends (#244); the only thing it sends.
const MACHINE_KEY: &str = "machine";

/// What each answer does; it comes from main.rs, which has the state and the window.
pub struct Handlers {
    /// A click on the notification or "Abrir": the app window at the notice's path (the session or the machine).
    pub open: fn(&AppHandle, &str),
    /// "Abrir no Claude Desktop", with the notice's `local_…` (without it, the console).
    pub open_in_desktop: fn(&AppHandle, Option<String>),
    /// "Silenciar": silences the session and saves.
    pub silence: fn(&AppHandle, &str),
    /// "Reconectar" (#244): asks the core to run the machine's reconnect command.
    pub reconnect: fn(&AppHandle, &str),
}

static APP: OnceLock<(AppHandle, Handlers)> = OnceLock::new();
static ACTIVE: AtomicBool = AtomicBool::new(false);

thread_local! {
    static DELEGATE: RefCell<Option<Retained<Delegate>>> = const { RefCell::new(None) };
}

define_class!(
    // SAFETY: NSObject has no requirements for subclasses, and `Delegate` does not implement `Drop`.
    #[unsafe(super(NSObject))]
    #[name = "AhrenaConsoleNoticeDelegate"]
    struct Delegate;

    // SAFETY: `NSObjectProtocol` has no requirements.
    unsafe impl NSObjectProtocol for Delegate {}

    // SAFETY: the signatures are the protocol's (objc2-user-notifications 0.3), and each method
    // calls the completion handler exactly once. `Delegate` has no ivars nor main-thread state, so
    // it may be called from any queue.
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// With the app in the foreground (the console window open), macOS would show nothing.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &UNUserNotificationCenter, _n: &UNNotification, done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::Sound | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
            done.call(());
            respond(response);
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's `init` on a freshly allocated object.
        unsafe { msg_send![super(this), init] }
    }
}

/// The app runs from a bundle with an identifier: without it `UNUserNotificationCenter` aborts.
fn has_bundle() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Turns the center on: delegate, categories with the A3 actions and the authorization request
/// (alert and sound). On the main thread, in `setup` (the `MainThreadMarker` proves it): the
/// delegate's `thread_local` is that thread's. Returns `false` without a bundle; then main.rs uses
/// the plugin.
pub fn start(app: &AppHandle, handlers: Handlers, _main: MainThreadMarker) -> bool {
    if !has_bundle() {
        eprintln!("[ahrena-console] no bundle: notifications without click (Tauri plugin)");
        return false;
    }
    if APP.set((app.clone(), handlers)).is_err() {
        return ACTIVE.load(Ordering::Relaxed);
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate = Delegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    DELEGATE.with(|d| *d.borrow_mut() = Some(delegate));

    let action = |id: &str, title: &str, options| UNNotificationAction::actionWithIdentifier_title_options(&NSString::from_str(id), &NSString::from_str(title), options);
    let button = |a: Action| match a {
        Action::Open => action(OPEN_ACTION, "Abrir", UNNotificationActionOptions::Foreground),
        Action::OpenInDesktop => action(OPEN_IN_DESKTOP_ACTION, "Abrir no Claude Desktop", UNNotificationActionOptions::empty()),
        Action::Silence => action(SILENCE_ACTION, "Silenciar", UNNotificationActionOptions::empty()),
        // In the background: the command may open a login in the browser; the window stays as is.
        Action::Reconnect => action(RECONNECT_ACTION, "Reconectar", UNNotificationActionOptions::empty()),
    };
    // One category per kind of notice, with the actions `Origin::actions` gives it.
    let categories: Vec<_> = [(Origin::Session, category(Origin::Session)), (Origin::RemoteSession, category(Origin::RemoteSession)), (Origin::Machine, category(Origin::Machine)), (Origin::MachineReconnect, category(Origin::MachineReconnect))]
        .into_iter()
        .map(|(o, id)| {
            let actions = NSArray::from_retained_slice(&o.actions().iter().map(|a| button(*a)).collect::<Vec<_>>());
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(&NSString::from_str(id), &actions, &NSArray::new(), UNNotificationCategoryOptions::empty())
        })
        .collect();
    center.setNotificationCategories(&NSSet::from_retained_slice(&categories));

    let on_authorization = RcBlock::new(|ok: Bool, error: *mut NSError| {
        // Denied (or an unsigned bundle macOS refuses): fall back to the plugin, which still shows the notice.
        if !ok.as_bool() {
            eprintln!("[ahrena-console] notifications not authorized{}; using the Tauri plugin", describe(error));
            ACTIVE.store(false, Ordering::Relaxed);
        }
    });
    ACTIVE.store(true, Ordering::Relaxed);
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &on_authorization);
    true
}

/// The center is on (and `send` here applies).
pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// Shows the notice. The identifier is the session: a new notice of it replaces the previous one.
pub fn send(n: &Notice) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&n.title));
    content.setBody(&NSString::from_str(&n.body));
    content.setCategoryIdentifier(&NSString::from_str(category(n.origin)));
    content.setThreadIdentifier(&NSString::from_str(&n.session));
    if n.sound {
        content.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    let mut keys = vec![NSString::from_str(SESSION_KEY), NSString::from_str(PATH_KEY)];
    let mut values = vec![NSString::from_str(&n.session), NSString::from_str(&n.path)];
    if let Some(local) = &n.local {
        keys.push(NSString::from_str(LOCAL_KEY));
        values.push(NSString::from_str(local));
    }
    if let Some(machine) = &n.machine {
        keys.push(NSString::from_str(MACHINE_KEY));
        values.push(NSString::from_str(machine));
    }
    let keys: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let values: Vec<&NSString> = values.iter().map(|v| &**v).collect();
    let info = NSDictionary::<NSString, NSString>::from_slices(&keys, &values);
    // SAFETY: keys and values are NSString, property-list types, as `userInfo` requires; the cast
    // only widens the generics to `AnyObject`.
    unsafe { content.setUserInfo(info.cast_unchecked::<AnyObject, AnyObject>()) };

    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&n.session), &content, None);
    let on_send = RcBlock::new(|error: *mut NSError| {
        if !error.is_null() {
            eprintln!("[ahrena-console] notification{}", describe(error));
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&on_send));
}

/// The notification category of each kind of notice.
fn category(o: Origin) -> &'static str {
    match o {
        Origin::Session => SESSION_CATEGORY,
        Origin::RemoteSession => REMOTE_SESSION_CATEGORY,
        Origin::Machine => MACHINE_CATEGORY,
        Origin::MachineReconnect => MACHINE_RECONNECT_CATEGORY,
    }
}

fn describe(error: *mut NSError) -> String {
    // SAFETY: UserNotifications passes null or a valid NSError during the call.
    match unsafe { error.as_ref() } {
        Some(e) => format!(": {}", e.localizedDescription()),
        None => String::new(),
    }
}

fn read(info: &NSDictionary, key: &str) -> Option<String> {
    let key = NSString::from_str(key);
    let value = info.objectForKey(&key)?.downcast::<NSString>().ok()?;
    Some(value.to_string())
}

/// The click on the notification or on one of its actions.
fn respond(response: &UNNotificationResponse) {
    let Some((app, handlers)) = APP.get() else { return };
    let info = response.notification().request().content().userInfo();
    let Some(session) = read(&info, SESSION_KEY) else { return };
    let local = read(&info, LOCAL_KEY);
    // A notice from before #180 has no path: the session's screen, as then.
    let path = read(&info, PATH_KEY).unwrap_or_else(|| notifications::session_path(&session));
    let action = response.actionIdentifier();
    let is = |id: &str| action.isEqualToString(&NSString::from_str(id));
    // SAFETY: a UserNotifications constant, read after the framework has loaded.
    let default = unsafe { UNNotificationDefaultActionIdentifier };
    let (open, open_in_desktop, silence, reconnect) = (handlers.open, handlers.open_in_desktop, handlers.silence, handlers.reconnect);
    let handle = app.clone();
    let work: Box<dyn FnOnce() + Send> = if action.isEqualToString(default) || is(OPEN_ACTION) {
        Box::new(move || open(&handle, &path))
    } else if is(OPEN_IN_DESKTOP_ACTION) {
        Box::new(move || open_in_desktop(&handle, local))
    } else if is(SILENCE_ACTION) {
        Box::new(move || silence(&handle, &session))
    } else if is(RECONNECT_ACTION) {
        let Some(machine) = read(&info, MACHINE_KEY) else { return };
        Box::new(move || reconnect(&handle, &machine))
    } else {
        return;
    };
    let _ = app.run_on_main_thread(work);
}
