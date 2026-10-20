// The updater (issue #90): on opening and every 6 h, asks the `latest.json` of the `app-updates`
// release (the update channel, see .github/workflows/app-updates.yml) whether there is a new
// version. If there is, it keeps the `Update` and tells `main.rs`, which puts "Atualizar para a versão X" in the menu; the click downloads, checks the signature,
// installs and relaunches.
//
// It only turns on with the public key in `plugins.updater.pubkey` of tauri.conf.json. Empty (the
// default until the project has the key, and in every local build), the plugin is not even
// registered: the plugin would accept the empty key on opening, but every update would then fail
// the signature check after downloading. Errors (network, signature) only go to stderr: the menu
// stays as it was.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// The update found and not installed yet.
struct Pending(Mutex<Option<Update>>);

/// The updater's public key in tauri.conf.json, if it is not empty.
fn public_key(app: &AppHandle) -> Option<String> {
    let key = app.config().plugins.0.get("updater")?.get("pubkey")?.as_str()?.trim();
    (!key.is_empty()).then(|| key.to_string())
}

/// Registers the updater and checks on a thread; `found` receives the new version. Without a key,
/// it does nothing.
pub fn watch(app: &AppHandle, found: impl Fn(&AppHandle, String) + Send + 'static) -> tauri::Result<()> {
    if public_key(app).is_none() {
        return Ok(());
    }
    app.plugin(tauri_plugin_updater::Builder::new().build())?;
    app.manage(Pending(Mutex::new(None)));
    let app = app.clone();
    std::thread::spawn(move || loop {
        match app.updater().map(|u| tauri::async_runtime::block_on(u.check())) {
            Ok(Ok(Some(update))) => {
                let version = update.version.clone();
                *app.state::<Pending>().0.lock().unwrap() = Some(update);
                found(&app, version);
            }
            Ok(Ok(None)) => {}
            Ok(Err(e)) | Err(e) => eprintln!("[ahrena-console] update: {e}"),
        }
        std::thread::sleep(INTERVAL);
    });
    Ok(())
}

/// Downloads, installs and relaunches. If it fails, the update is pending in the menu again.
pub fn install(app: &AppHandle) {
    let Some(pending) = app.try_state::<Pending>() else { return };
    let Some(update) = pending.0.lock().unwrap().take() else { return };
    let app = app.clone();
    std::thread::spawn(move || match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
        Ok(()) => app.restart(),
        Err(e) => {
            eprintln!("[ahrena-console] install update {}: {e}", update.version);
            *app.state::<Pending>().0.lock().unwrap() = Some(update);
        }
    });
}
