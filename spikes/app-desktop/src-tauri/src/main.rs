// Spike #82: app desktop do Ahrena Console em Tauri.
//
// Só bandeja (sem ícone no Dock). Ao abrir:
// 1. corrige o PATH com o do shell de login, para achar `claude` e `node`;
// 2. adota o núcleo que já responde em 127.0.0.1:4720 ou, se não houver, sobe um
//    como processo filho (sidecar) com o `node` da máquina;
// 3. a cada 5 s lê /api/fleet e mostra na barra de menus quantas sessões estão ativas;
// 4. avisa por notificação do sistema quando uma sessão para.
// Nada é instalado nem alterado no Claude: o app só lê o que já existe.

mod integracao;
mod nucleo;
mod shell_path;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

const TRAY_ID: &str = "ahrena";

struct Estado {
    nucleo: Mutex<Option<nucleo::Nucleo>>,
}

fn main() {
    shell_path::corrigir_path();

    // Imprime o que o menu mostraria, sem abrir o app nem subir o núcleo.
    if std::env::args().any(|a| a == "--diagnostico") {
        let i = integracao::levantar();
        println!("PATH com ~/.local/bin: {}", std::env::var("PATH").unwrap_or_default().contains("/.local/bin"));
        println!("{}\n{}\n{}", i.cli, i.plugin, i.extensao);
        println!("Núcleo: {}", if nucleo::frota().is_some() { "respondendo" } else { "fora do ar" });
        if let Some((a, o)) = nucleo::frota() {
            println!("{a} ativas · {o} ociosas");
        }
        return;
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| abrir_console(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Estado { nucleo: Mutex::new(None) })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            let nucleo = nucleo::adotar_ou_subir();
            let origem = nucleo.origem();
            *app.state::<Estado>().nucleo.lock().unwrap() = Some(nucleo);

            let integ = integracao::levantar();
            let estado = MenuItem::with_id(app, "estado", "Lendo o núcleo…", false, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "titulo", "Ahrena Console", false, None::<&str>)?,
                    &estado,
                    &MenuItem::with_id(app, "origem", format!("Núcleo: {origem}"), false, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "cli", integ.cli, false, None::<&str>)?,
                    &MenuItem::with_id(app, "plugin", integ.plugin, false, None::<&str>)?,
                    &MenuItem::with_id(app, "extensao", integ.extensao, false, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "abrir", "Abrir o console", true, Some("CmdOrCtrl+O"))?,
                    &CheckMenuItem::with_id(
                        app,
                        "login",
                        "Abrir no login",
                        true,
                        app.autolaunch().is_enabled().unwrap_or(false),
                        None::<&str>,
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "sair", "Sair", true, Some("CmdOrCtrl+Q"))?,
                ],
            )?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(false)
                .title("…")
                .tooltip("Ahrena Console")
                .menu(&menu)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "abrir" => abrir_console(app),
                    "login" => {
                        let auto = app.autolaunch();
                        let _ = if auto.is_enabled().unwrap_or(false) { auto.disable() } else { auto.enable() };
                    }
                    "sair" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            acompanhar(handle, estado);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("falha ao montar o app");

    app.run(|app, ev| {
        if let RunEvent::Exit = ev {
            // O núcleo que este app subiu morre com ele; o adotado continua.
            if let Some(n) = app.state::<Estado>().nucleo.lock().unwrap().take() {
                n.encerrar();
            }
        }
    });
}

fn abrir_console(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("console") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url = format!("http://{}/ui", nucleo::ENDERECO).parse().unwrap();
    let _ = WebviewWindowBuilder::new(app, "console", WebviewUrl::External(url))
        .title("Ahrena Console")
        .inner_size(1100.0, 760.0)
        .build();
}

// Lê a frota a cada 5 s. No produto isto vira long polling (`wait_for_changes`, item 2.4)
// e "sessões que pararam" vira "precisam de você" (item 2.1).
fn acompanhar(app: AppHandle, estado: MenuItem<tauri::Wry>) {
    let ativas_antes = Arc::new(Mutex::new(None::<u64>));
    std::thread::spawn(move || loop {
        let leitura = nucleo::frota();
        let tray = app.tray_by_id(TRAY_ID);
        match leitura {
            Some((ativas, ociosas)) => {
                let _ = estado.set_text(format!("{ativas} ativas · {ociosas} ociosas"));
                if let Some(t) = &tray {
                    let _ = t.set_title(Some(format!("● {ativas}")));
                }
                let mut antes = ativas_antes.lock().unwrap();
                if let Some(a) = *antes {
                    if ativas < a {
                        let n = a - ativas;
                        let _ = app
                            .notification()
                            .builder()
                            .title("Ahrena Console")
                            .body(if n == 1 { "1 sessão parou".to_string() } else { format!("{n} sessões pararam") })
                            .show();
                    }
                }
                *antes = Some(ativas);
            }
            None => {
                let _ = estado.set_text("Núcleo fora do ar");
                if let Some(t) = &tray {
                    let _ = t.set_title(Some("○"));
                }
            }
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}
