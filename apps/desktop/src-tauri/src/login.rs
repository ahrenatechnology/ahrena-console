// Open at login (issue #89): the registration through macOS 13+'s `SMAppService.mainApp`, without a
// LaunchAgent, and the launch at login with the tray only.
//
// The logic is pure and tested with a fake registration; the real one talks to ServiceManagement.
// The "Abrir no login" item is only checked with the `enabled` status, reread on every menu: the
// user may remove the item in Ajustes › Geral › Itens de Início.

/// The `SMAppService` status, with our own names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// `enabled`: registered and allowed.
    Enabled,
    /// `notRegistered`.
    Disabled,
    /// `requiresApproval`: registered, but the user turned it off (or has not allowed it yet) in Ajustes.
    RequiresApproval,
    /// `notFound`.
    NotFound,
}

/// What the app asks the system. The real one is `SMAppService`; in the tests, a fake.
pub trait Registration {
    fn status(&self) -> Status;
    fn register(&self) -> Result<(), String>;
    fn unregister(&self) -> Result<(), String>;
    /// Ajustes › Itens de Início, where the user approves.
    fn open_settings(&self);
}

/// The item is only checked with the registration enabled.
pub fn checked(s: Status) -> bool {
    s == Status::Enabled
}

/// The click on "Abrir no login": turns off the enabled, turns on the disabled and, if approval is
/// missing, opens Ajustes. Always returns the reread status, not the wanted one.
pub fn click(r: &dyn Registration) -> Status {
    let result = match r.status() {
        Status::Enabled => r.unregister().map_err(|e| format!("unregister: {e}")),
        Status::Disabled | Status::NotFound => r.register().map_err(|e| format!("register: {e}")),
        Status::RequiresApproval => {
            r.open_settings();
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("[ahrena-console] open at login: {e}");
    }
    r.status()
}

/// Where the app's launch came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchOrigin {
    /// Opened at login: only the tray.
    Login,
    /// Opened by hand (Finder, Dock, `open`): also opens the console.
    Manual,
}

impl LaunchOrigin {
    pub fn name(self) -> &'static str {
        match self {
            LaunchOrigin::Login => "login",
            LaunchOrigin::Manual => "manual",
        }
    }
}

pub fn opens_window_at_launch(o: LaunchOrigin) -> bool {
    o == LaunchOrigin::Manual
}

/// `AHRENA_CONSOLE_LAUNCH_ORIGIN=login|manual` (old name `AHRENA_ORIGEM`) fakes the origin, for
/// testing by hand.
pub fn origin_from_variable(v: Option<&str>) -> Option<LaunchOrigin> {
    match v?.trim() {
        "login" => Some(LaunchOrigin::Login),
        "manual" => Some(LaunchOrigin::Manual),
        _ => None,
    }
}

const fn four_cc(c: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*c)
}

/// `kCoreEventClass`, `kAEOpenApplication`, `keyAEPropData` and `keyAELaunchedAsLogInItem`.
pub const AEVT: u32 = four_cc(b"aevt");
pub const OAPP: u32 = four_cc(b"oapp");
pub const PRDT: u32 = four_cc(b"prdt");
pub const LGIT: u32 = four_cc(b"lgit");

/// The launch Apple Event (`aevt`/`oapp`) says whether it came from the login in its `prdt`
/// parameter == `lgit`, like Electron's `wasOpenedAtLogin`. Any other event says nothing.
pub fn origin_from_event(class: u32, id: u32, prdt: Option<u32>) -> Option<LaunchOrigin> {
    if class != AEVT || id != OAPP {
        return None;
    }
    Some(if prdt == Some(LGIT) { LaunchOrigin::Login } else { LaunchOrigin::Manual })
}

/// The origin and where it came from: the variable, the event or the default (manual).
pub fn detect(variable: Option<&str>, event: Option<(u32, u32, Option<u32>)>) -> (LaunchOrigin, &'static str) {
    if let Some(o) = origin_from_variable(variable) {
        return (o, "variable");
    }
    if let Some(o) = event.and_then(|(c, i, p)| origin_from_event(c, i, p)) {
        return (o, "event");
    }
    (LaunchOrigin::Manual, "default")
}

/// The Apple Event in progress, read in `setup` (which runs inside `applicationDidFinishLaunching`).
#[cfg(target_os = "macos")]
pub fn launch_event() -> Option<(u32, u32, Option<u32>)> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};

    let ev = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent()?;
    // SAFETY: `eventClass`, `eventID` and `paramDescriptorForKeyword:` are NSAppleEventDescriptor's,
    // with four-letter codes (u32); objc2-foundation only exposes them with objc2-core-services.
    let (class, id, prdt): (u32, u32, Option<Retained<NSAppleEventDescriptor>>) =
        unsafe { (msg_send![&*ev, eventClass], msg_send![&*ev, eventID], msg_send![&*ev, paramDescriptorForKeyword: PRDT]) };
    Some((class, id, prdt.map(|d| d.enumCodeValue())))
}

#[cfg(not(target_os = "macos"))]
pub fn launch_event() -> Option<(u32, u32, Option<u32>)> {
    None
}

/// The app's own registration (`SMAppService.mainApp`).
pub struct SystemRegistration;

#[cfg(target_os = "macos")]
impl Registration for SystemRegistration {
    fn status(&self) -> Status {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        // SAFETY: argument-less ServiceManagement calls, macOS 13+ (the app's minimum).
        match unsafe { SMAppService::mainAppService().status() } {
            SMAppServiceStatus::Enabled => Status::Enabled,
            SMAppServiceStatus::RequiresApproval => Status::RequiresApproval,
            SMAppServiceStatus::NotFound => Status::NotFound,
            _ => Status::Disabled,
        }
    }

    fn register(&self) -> Result<(), String> {
        // SAFETY: as above.
        unsafe { objc2_service_management::SMAppService::mainAppService().registerAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
    }

    fn unregister(&self) -> Result<(), String> {
        // SAFETY: as above.
        unsafe { objc2_service_management::SMAppService::mainAppService().unregisterAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
    }

    fn open_settings(&self) {
        // SAFETY: as above.
        unsafe { objc2_service_management::SMAppService::openSystemSettingsLoginItems() }
    }
}

/// Outside macOS there is no registration yet: it stays disabled.
#[cfg(not(target_os = "macos"))]
impl Registration for SystemRegistration {
    fn status(&self) -> Status {
        Status::Disabled
    }
    fn register(&self) -> Result<(), String> {
        Err("macOS only".into())
    }
    fn unregister(&self) -> Result<(), String> {
        Ok(())
    }
    fn open_settings(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A fake registration that counts the calls and may fail.
    struct Fake {
        status: Cell<Status>,
        fail: bool,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Fake {
        fn with(s: Status) -> Self {
            Fake { status: Cell::new(s), fail: false, calls: RefCell::new(Vec::new()) }
        }
        fn failing(s: Status) -> Self {
            Fake { fail: true, ..Fake::with(s) }
        }
        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl Registration for Fake {
        fn status(&self) -> Status {
            self.status.get()
        }
        fn register(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("register");
            if self.fail {
                return Err("denied".into());
            }
            self.status.set(Status::Enabled);
            Ok(())
        }
        fn unregister(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("unregister");
            if self.fail {
                return Err("denied".into());
            }
            self.status.set(Status::Disabled);
            Ok(())
        }
        fn open_settings(&self) {
            self.calls.borrow_mut().push("open_settings");
        }
    }

    #[test]
    fn only_enabled_checks() {
        assert!(checked(Status::Enabled));
        assert!(!checked(Status::Disabled));
        assert!(!checked(Status::RequiresApproval));
        assert!(!checked(Status::NotFound));
    }

    #[test]
    fn clicking_disabled_registers_and_checks() {
        let r = Fake::with(Status::Disabled);
        assert_eq!(click(&r), Status::Enabled);
        assert!(checked(r.status()));
        assert_eq!(r.calls(), ["register"]);
    }

    #[test]
    fn clicking_not_found_registers() {
        let r = Fake::with(Status::NotFound);
        assert_eq!(click(&r), Status::Enabled);
        assert_eq!(r.calls(), ["register"]);
    }

    #[test]
    fn clicking_enabled_unregisters_and_unchecks() {
        let r = Fake::with(Status::Enabled);
        assert_eq!(click(&r), Status::Disabled);
        assert!(!checked(r.status()));
        assert_eq!(r.calls(), ["unregister"]);
    }

    #[test]
    fn requires_approval_stays_unchecked_and_opens_settings() {
        let r = Fake::with(Status::RequiresApproval);
        assert!(!checked(r.status()));
        assert_eq!(click(&r), Status::RequiresApproval);
        assert_eq!(r.calls(), ["open_settings"]);
    }

    #[test]
    fn register_error_shows_the_reread_status() {
        let r = Fake::failing(Status::Disabled);
        assert_eq!(click(&r), Status::Disabled);
        assert_eq!(r.calls(), ["register"]);
    }

    #[test]
    fn unregister_error_shows_the_reread_status() {
        let r = Fake::failing(Status::Enabled);
        assert_eq!(click(&r), Status::Enabled);
        assert_eq!(r.calls(), ["unregister"]);
    }

    #[test]
    fn at_login_only_the_tray_and_by_hand_opens_the_console() {
        assert!(!opens_window_at_launch(LaunchOrigin::Login));
        assert!(opens_window_at_launch(LaunchOrigin::Manual));
    }

    #[test]
    fn the_variable_fakes_the_origin() {
        assert_eq!(origin_from_variable(Some("login")), Some(LaunchOrigin::Login));
        assert_eq!(origin_from_variable(Some("manual")), Some(LaunchOrigin::Manual));
        assert_eq!(origin_from_variable(Some("other")), None);
        assert_eq!(origin_from_variable(Some("")), None);
        assert_eq!(origin_from_variable(None), None);
    }

    #[test]
    fn the_launch_event_at_login() {
        assert_eq!(origin_from_event(AEVT, OAPP, Some(LGIT)), Some(LaunchOrigin::Login));
        assert_eq!(origin_from_event(AEVT, OAPP, None), Some(LaunchOrigin::Manual));
        assert_eq!(origin_from_event(AEVT, OAPP, Some(four_cc(b"xxxx"))), Some(LaunchOrigin::Manual));
        // `odoc` (open a document) does not say where it came from.
        assert_eq!(origin_from_event(AEVT, four_cc(b"odoc"), Some(LGIT)), None);
    }

    #[test]
    fn the_variable_beats_the_event_and_the_default_is_manual() {
        assert_eq!(detect(Some("login"), Some((AEVT, OAPP, None))), (LaunchOrigin::Login, "variable"));
        assert_eq!(detect(None, Some((AEVT, OAPP, Some(LGIT)))), (LaunchOrigin::Login, "event"));
        assert_eq!(detect(Some("?"), Some((AEVT, OAPP, None))), (LaunchOrigin::Manual, "event"));
        assert_eq!(detect(None, None), (LaunchOrigin::Manual, "default"));
    }
}
