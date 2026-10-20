// O updater (issue #90): ao abrir e a cada 6 h, pergunta ao `latest.json` da última release do
// GitHub se há versão nova. Se há, guarda o `Update` e avisa `main.rs`, que põe no menu
// "Atualizar para a versão X"; o clique baixa, confere a assinatura, instala e relança.
//
// Só liga com a chave pública em `plugins.updater.pubkey` do tauri.conf.json. Vazia (o padrão até
// o projeto ter a chave, e em toda build local), o plugin nem é registrado: o plugin aceitaria a
// chave vazia ao abrir, mas cada atualização falharia na conferência da assinatura depois de baixar.
// Erros (rede, assinatura) só vão para o stderr: o menu fica como estava.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const INTERVALO: Duration = Duration::from_secs(6 * 60 * 60);

/// A atualização achada e ainda não instalada.
struct Pendente(Mutex<Option<Update>>);

/// A chave pública do updater no tauri.conf.json, se não estiver vazia.
fn chave_publica(app: &AppHandle) -> Option<String> {
    let chave = app.config().plugins.0.get("updater")?.get("pubkey")?.as_str()?.trim();
    (!chave.is_empty()).then(|| chave.to_string())
}

/// Registra o updater e checa numa thread; `achou` recebe a versão nova. Sem chave, não faz nada.
pub fn vigiar(app: &AppHandle, achou: impl Fn(&AppHandle, String) + Send + 'static) -> tauri::Result<()> {
    if chave_publica(app).is_none() {
        return Ok(());
    }
    app.plugin(tauri_plugin_updater::Builder::new().build())?;
    app.manage(Pendente(Mutex::new(None)));
    let app = app.clone();
    std::thread::spawn(move || loop {
        match app.updater().map(|u| tauri::async_runtime::block_on(u.check())) {
            Ok(Ok(Some(update))) => {
                let versao = update.version.clone();
                *app.state::<Pendente>().0.lock().unwrap() = Some(update);
                achou(&app, versao);
            }
            Ok(Ok(None)) => {}
            Ok(Err(e)) | Err(e) => eprintln!("[ahrena-console] atualização: {e}"),
        }
        std::thread::sleep(INTERVALO);
    });
    Ok(())
}

/// Baixa, instala e relança. Se falhar, a atualização volta a ficar pendente no menu.
pub fn instalar(app: &AppHandle) {
    let Some(pendente) = app.try_state::<Pendente>() else { return };
    let Some(update) = pendente.0.lock().unwrap().take() else { return };
    let app = app.clone();
    std::thread::spawn(move || match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
        Ok(()) => app.restart(),
        Err(e) => {
            eprintln!("[ahrena-console] instalar a atualização {}: {e}", update.version);
            *app.state::<Pendente>().0.lock().unwrap() = Some(update);
        }
    });
}
