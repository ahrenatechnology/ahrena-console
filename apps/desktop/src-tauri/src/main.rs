// App desktop do Ahrena Console (decisão 0005, issue #87): uma bandeja na barra de menus.
//
// Ao abrir:
// 1. corrige o PATH com o do shell de login, para achar o `node`;
// 2. starts its own core (or adopts it, within the app's installation), on a random port and in
//    the app's data folder (nucleo.rs); it never uses another installation's core;
// 3. lê `GET /api/attention` e espera mudanças em `GET /api/changes` (long polling), e monta o menu
//    dos wireframes A1, A2 e A4 (menu.rs), com o número ao lado do ícone;
// 4. o clique numa sessão a abre no Claude Desktop (`POST /open/<local_…>`); "Abrir o console"
//    abre a `/ui` do núcleo numa janela;
// 5. avisa por notificação do sistema quem passa a precisar de você (A3, notificacoes.rs);
// 5a. reads the machines and their telemetry (`/api/machines`, `/api/telemetry`) for the "Máquinas"
//     block (A6, A7, machines.rs) and notifies, silently, a new machine alert (#180);
// 6. com a chave do updater no tauri.conf.json, procura versão nova ao abrir e a cada 6 h
//    (atualizacao.rs) e a oferece no menu;
// 7. aberto à mão, abre também o console; aberto pelo login, fica só na bandeja (login.rs).
// O app não grava hooks nem configuração do Claude, não embute Node e não tem telas próprias.

mod atualizacao;
#[cfg(target_os = "macos")]
mod aviso_nativo;
mod http;
mod login;
mod machines;
mod menu;
#[cfg(target_os = "macos")]
mod nativo;
mod notificacoes;
mod nucleo;
mod shell_path;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};

use login::Registro;
use machines::Machine;
use menu::{Atencao, EstadoDoNucleo, Item, Ponto};
use notificacoes::{Aviso, Avisos};

const BANDEJA: &str = "ahrena";
const ICONE: &[u8] = include_bytes!("../icons/bandeja.png");
const ICONE_2X: &[u8] = include_bytes!("../icons/bandeja@2x.png");

/// O que a bandeja mostra; o menu é refeito quando muda.
struct Estado {
    nucleo: EstadoDoNucleo,
    atencao: Option<Atencao>,
    sem_atencao: bool,
    /// The machines of `/api/machines` with their telemetry (#180); `None` without telemetry.
    machines: Option<Vec<Machine>>,
    /// Consecutive reads of `/api/machines` that did not answer; see `count_machine_misses`.
    machine_misses: u32,
    /// O detector e o silêncio das notificações; a marca "Notificações" é `avisos.silencio.ligadas`.
    avisos: Avisos,
    /// O status do `SMAppService` é `enabled` (login.rs), relido a cada menu.
    login: bool,
    /// `id da sessão` → `local_…` do Claude Desktop, do último menu.
    locais: HashMap<String, Option<String>>,
    ultimo: Option<(Vec<Item>, Option<String>)>,
    /// A versão nova que o updater achou.
    atualizacao: Option<String>,
    /// "Abrir o console" was clicked while the core was not up: open it once the core is.
    open_when_up: bool,
}

type Compartilhado = Arc<Mutex<Estado>>;

/// Pedidos ao laço do núcleo: "Procurar o núcleo de novo".
struct Laco(Mutex<Sender<()>>);

fn main() {
    shell_path::corrigir_path();

    let estado: Compartilhado = Arc::new(Mutex::new(Estado {
        nucleo: EstadoDoNucleo::Procurando,
        atencao: None,
        sem_atencao: false,
        machines: None,
        machine_misses: 0,
        avisos: Avisos::default(),
        login: false,
        locais: HashMap::new(),
        ultimo: None,
        atualizacao: None,
        open_when_up: false,
    }));
    let (acordar, sinais) = channel::<()>();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| abrir_console(app)))
        .plugin(tauri_plugin_notification::init())
        .manage(estado.clone())
        .manage(Laco(Mutex::new(acordar)))
        .setup(move |app| {
            // O Apple Event de abertura ainda está em curso aqui, no `applicationDidFinishLaunching`.
            let variavel = std::env::var("AHRENA_ORIGEM").ok();
            let (origem, fonte) = login::descobrir(variavel.as_deref(), login::evento_de_abertura());
            eprintln!("[ahrena-console] origem: {} ({fonte})", origem.nome());
            let abrir_na_partida = login::abrir_janela_na_partida(origem);
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                nativo::ouvir();
            }
            estado.lock().unwrap().avisos = Avisos::abrir(notificacoes::caminho(app.path().app_data_dir().ok()));
            #[cfg(target_os = "macos")]
            {
                let principal = objc2::MainThreadMarker::new().expect("o setup do Tauri roda na thread principal");
                aviso_nativo::iniciar(app.handle(), aviso_nativo::Acoes { abrir: open_window_at, no_desktop: abrir_no_desktop, silenciar }, principal);
            }
            TrayIconBuilder::with_id(BANDEJA)
                .icon(Image::from_bytes(ICONE)?)
                .icon_as_template(true)
                .tooltip("Ahrena Console")
                .on_menu_event(|app, ev| clique(app, ev.id().as_ref()))
                .build(app)?;
            #[cfg(target_os = "macos")]
            if let Some(b) = app.tray_by_id(BANDEJA) {
                let _ = b.with_inner_tray_icon(|t| {
                    if let Some(item) = t.ns_status_item() {
                        nativo::icone_template(&item, &[ICONE, ICONE_2X]);
                    }
                });
            }
            redesenhar(app.handle(), &estado);
            let para_o_menu = estado.clone();
            if let Err(e) = atualizacao::vigiar(app.handle(), move |app, versao| mudar(app, &para_o_menu, |e| e.atualizacao = Some(versao))) {
                eprintln!("[ahrena-console] updater: {e}");
            }

            let recursos = app.path().resource_dir().ok();
            let data_dir = app.path().app_data_dir().ok();
            let handle = app.handle().clone();
            std::thread::spawn(move || acompanhar(handle, estado, nucleo::core_dir(recursos), data_dir, sinais, abrir_na_partida));
            abrir_o_menu_depois(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("falha ao montar o app");

    app.run(|app, ev| {
        // Abrir de novo pelo Finder, Dock ou Spotlight com o app já de pé (ex.: aberto no login, só
        // na bandeja) chega aqui, e não no single-instance: abre o console.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = ev {
            abrir_console(app);
        }
        // Fechar a janela do console só a esconde: o app vive na bandeja, e a última janela nunca
        // fecha (fechar pediria para sair). Sair, logout e desligar seguem normais.
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
/// `abrir_na_partida`: abre o console se o núcleo fica de pé já na primeira tentativa (partida à
/// mão); se ele só sobe depois (falta Node, "Procurar de novo"), o console não aparece sozinho.
fn acompanhar(app: AppHandle, estado: Compartilhado, pasta: PathBuf, data_dir: Option<PathBuf>, sinais: std::sync::mpsc::Receiver<()>, mut abrir_na_partida: bool) {
    loop {
        mudar(&app, &estado, |e| {
            e.nucleo = EstadoDoNucleo::Procurando;
            e.atencao = None;
            e.sem_atencao = false;
            e.machines = None;
            e.avisos.detector.zerar();
            e.avisos.machines.reset();
        });
        let outcome = nucleo::start_own_core(&pasta, data_dir.as_deref());
        let abrir = std::mem::take(&mut abrir_na_partida);
        let core = match outcome.core {
            Some(core) => {
                eprintln!("[ahrena-console] core on port {} (pid {:?}, {})", core.port, core.pid, if outcome.started { "started" } else { "adopted" });
                core
            }
            None => {
                let parado = outcome.state;
                mudar(&app, &estado, |e| e.nucleo = parado);
                // Tenta de novo a cada 30 s, ou já, no "Procurar o núcleo de novo".
                if let Err(RecvTimeoutError::Disconnected) = sinais.recv_timeout(Duration::from_secs(30)) {
                    return;
                }
                continue;
            }
        };
        let mut asked = false;
        mudar(&app, &estado, |e| {
            e.nucleo = EstadoDoNucleo::DePe { porta: core.port };
            asked = std::mem::take(&mut e.open_when_up);
        });
        // A new core has a new port: a console window left on the old one follows it.
        let port = core.port;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || follow_core_port(&handle, port));
        if abrir || asked {
            eprintln!("[ahrena-console] partida à mão: abre o console");
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || abrir_console(&handle));
        }
        seguir(&app, &estado, &core, &sinais);
        // O núcleo parou de responder: procura (e sobe) de novo.
        while sinais.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// Lê `/api/attention` e espera em `/api/changes` até o núcleo parar de responder.
fn seguir(app: &AppHandle, estado: &Compartilhado, core: &nucleo::Core, sinais: &std::sync::mpsc::Receiver<()>) {
    let porta = core.port;
    let mut cursor: Option<String> = None;
    loop {
        let resposta = http::get_com_status(porta, "/api/attention", Duration::from_secs(15));
        match resposta {
            Some(r) if r.status == 200 => {
                let Some(atencao) = Atencao::do_json(&r.corpo) else { return };
                cursor = atencao.cursor.clone().or(cursor);
                // Sessions first: a slow `/api/machines` must not hold back their notices.
                let mut novos = Vec::new();
                mudar(app, estado, |e| {
                    novos = e.avisos.ler(&atencao);
                    e.atencao = Some(atencao);
                    e.sem_atencao = false;
                });
                avisar(app, &novos);
                let read = read_machines(porta);
                let mut novos = Vec::new();
                mudar(app, estado, |e| {
                    let (misses, drop) = count_machine_misses(e.machine_misses, matches!(read, MachinesRead::NoAnswer));
                    e.machine_misses = misses;
                    match read {
                        MachinesRead::Read(ms) => {
                            novos = e.avisos.read_machines(&ms);
                            e.machines = Some(ms);
                        }
                        MachinesRead::NoTelemetry => {
                            e.machines = None;
                            e.avisos.machines.reset();
                        }
                        // A hiccup keeps the last block and its detector, so it neither hides nor
                        // re-notifies; a run of them drops the block instead of showing it stale.
                        MachinesRead::NoAnswer => {
                            if drop {
                                e.machines = None;
                                e.avisos.machines.reset();
                            }
                        }
                    }
                });
                avisar(app, &novos);
            }
            // Um núcleo de antes da #87: de pé, mas sem a lista. Relê a cada 30 s.
            Some(r) if r.status == 404 => {
                mudar(app, estado, |e| {
                    e.atencao = None;
                    e.sem_atencao = true;
                    e.machines = None;
                    e.avisos.detector.zerar();
                    e.avisos.machines.reset();
                });
                let _ = sinais.recv_timeout(Duration::from_secs(30));
                if !core.answers() {
                    return;
                }
                continue;
            }
            _ => return,
        }
        // "Procurar o núcleo de novo" com o núcleo de pé: só relê.
        while sinais.try_recv().is_ok() {}
        let inicio = Instant::now();
        let caminho = match &cursor {
            Some(c) => format!("/api/changes?since={}&wait=25", http::codificar(c)),
            None => "/api/changes?wait=25".into(),
        };
        // Volta com mudanças, com `reset` ou depois de 25 s sem nada: em todos os casos relê,
        // o que também atualiza os minutos de espera. Sem `/api/changes` (núcleo antigo), relê a cada 25 s.
        if http::get(porta, &caminho, Duration::from_secs(40)).is_none() {
            let resto = Duration::from_secs(25).saturating_sub(inicio.elapsed());
            if !core.answers() {
                return;
            }
            let _ = sinais.recv_timeout(resto);
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
fn read_machines(porta: u16) -> MachinesRead {
    let wait = Duration::from_secs(5);
    let r = match http::get_com_status(porta, "/api/machines", wait) {
        Some(r) if r.status == 404 => return MachinesRead::NoTelemetry,
        Some(r) if r.status == 200 => r,
        Some(r) => {
            eprintln!("[ahrena-console] máquinas: /api/machines respondeu {}", r.status);
            return MachinesRead::NoAnswer;
        }
        None => {
            eprintln!("[ahrena-console] máquinas: /api/machines sem resposta");
            return MachinesRead::NoAnswer;
        }
    };
    let summaries = match machines::summaries_from_json(&r.corpo) {
        Ok(summaries) => summaries,
        Err(err) => {
            eprintln!("[ahrena-console] máquinas: /api/machines não leu: {err}");
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
                let path = format!("/api/telemetry?machine={}", http::codificar(&summary.id));
                let telemetry = http::get(porta, &path, wait).and_then(|t| {
                    machines::telemetry_from_json(&t)
                        .map_err(|err| eprintln!("[ahrena-console] máquinas: telemetria de {}: {err}", summary.id))
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

fn mudar(app: &AppHandle, estado: &Compartilhado, f: impl FnOnce(&mut Estado)) {
    f(&mut estado.lock().unwrap());
    redesenhar(app, estado);
}

/// Refaz o menu e o número, se mudaram, na thread principal.
fn redesenhar(app: &AppHandle, estado: &Compartilhado) {
    let estado = estado.clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut e = estado.lock().unwrap();
        // Relido sempre: o usuário pode tirar o item em Ajustes.
        e.login = login::marcado(login::DoSistema.status());
        let versao = handle.package_info().version.to_string();
        let itens = menu::montar(&menu::Entrada { nucleo: &e.nucleo, atencao: e.atencao.as_ref(), sem_atencao: e.sem_atencao, notificacoes: e.avisos.silencio.ligadas, login: e.login, versao: &versao, atualizacao: e.atualizacao.as_deref(), machines: e.machines.as_deref(), now_ms: now_ms() });
        let titulo = menu::titulo_da_bandeja(&e.nucleo, e.atencao.as_ref());
        if e.ultimo.as_ref() == Some(&(itens.clone(), titulo.clone())) {
            return;
        }
        let Some(bandeja) = handle.tray_by_id(BANDEJA) else { return };
        match nativo_do_menu(&handle, &itens) {
            Ok(m) => {
                let _ = bandeja.set_menu(Some(m));
                #[cfg(target_os = "macos")]
                nativo::ajustar("Ahrena Console", &ajustes(&itens));
            }
            Err(err) => eprintln!("[ahrena-console] menu: {err}"),
        }
        let _ = bandeja.set_title(titulo.as_deref());
        e.locais = itens
            .iter()
            .filter_map(|i| match i {
                Item::Sessao { id, local, .. } => Some((id.clone(), local.clone())),
                _ => None,
            })
            .collect();
        e.ultimo = Some((itens, titulo));
    });
}

fn nativo_do_menu(app: &AppHandle, itens: &[Item]) -> tauri::Result<Menu<Wry>> {
    let mut nativos: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for (n, i) in itens.iter().enumerate() {
        let id = |s: &str| format!("{s}#{n}");
        let proximo: Box<dyn IsMenuItem<Wry>> = match i {
            Item::Texto { texto, ponto: Some(p) } => Box::new(IconMenuItem::with_id(app, id("texto"), texto, false, Some(bolinha(*p)), None::<&str>)?),
            Item::Texto { texto, ponto: None } | Item::Detalhe(texto) => Box::new(MenuItem::with_id(app, id("texto"), texto, false, None::<&str>)?),
            Item::Cabecalho { texto, alternativo } => {
                nativos.push(Box::new(MenuItem::with_id(app, id("cabecalho"), texto, false, None::<&str>)?));
                Box::new(MenuItem::with_id(app, id("cabecalho-alt"), alternativo, false, None::<&str>)?)
            }
            Item::Sessao { id: sessao, texto, alternativo, ponto, local, .. } => {
                let principal = Box::new(IconMenuItem::with_id(app, format!("{}{sessao}", menu::SESSAO), texto, true, Some(bolinha(*ponto)), None::<&str>)?);
                // A remote session has no ⌥ item: this Mac's Claude Desktop does not know it.
                let Some(alternativo) = alternativo else {
                    nativos.push(principal);
                    continue;
                };
                nativos.push(principal);
                Box::new(IconMenuItem::with_id(app, format!("{}{sessao}", menu::SESSAO_NO_DESKTOP), alternativo, local.is_some(), Some(bolinha(*ponto)), None::<&str>)?)
            }
            // The row and the alerts of one machine share its id; `#n` keeps each menu id unique.
            Item::Machine { id: machine, text, dot } => Box::new(IconMenuItem::with_id(app, format!("{}{machine}#{n}", menu::MACHINE), text, true, Some(bolinha(*dot)), None::<&str>)?),
            Item::Acao { id, texto, atalho } => Box::new(MenuItem::with_id(app, *id, texto, true, *atalho)?),
            Item::Marcavel { id, texto, marcado } => Box::new(CheckMenuItem::with_id(app, *id, *texto, true, *marcado, None::<&str>)?),
            Item::Separador => Box::new(PredefinedMenuItem::separator(app)?),
        };
        nativos.push(proximo);
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = nativos.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

#[cfg(target_os = "macos")]
fn ajustes(itens: &[Item]) -> Vec<nativo::Ajuste> {
    use nativo::Ajuste;
    let mut a = Vec::new();
    for i in itens {
        match i {
            Item::Cabecalho { alternativo, .. } => a.push(Ajuste::Alternativo(alternativo.clone())),
            Item::Sessao { texto, alternativo, dica, .. } => {
                a.push(Ajuste::Dica { titulo: texto.clone(), dica: dica.clone() });
                if let Some(alternativo) = alternativo {
                    a.push(Ajuste::Alternativo(alternativo.clone()));
                    a.push(Ajuste::Dica { titulo: alternativo.clone(), dica: dica.clone() });
                }
            }
            Item::Detalhe(t) => a.push(Ajuste::Recuo(t.clone())),
            _ => {}
        }
    }
    a
}

/// O ponto colorido dos wireframes, desenhado em 36 px (18 pt no menu, nítido na tela Retina).
fn bolinha(p: Ponto) -> Image<'static> {
    const LADO: u32 = 36;
    let (cor, vazio) = match p {
        Ponto::Verde => ([0x1b, 0xaf, 0x7a], false),
        Ponto::Vermelho => ([0xe3, 0x49, 0x48], false),
        Ponto::Amarelo => ([0xff, 0xc3, 0x0a], false),
        Ponto::Laranja => ([0xf4, 0x77, 0x20], false),
        Ponto::Vazio => ([0xa6, 0xa6, 0xaa], true),
    };
    let (centro, raio) = (LADO as f32 / 2.0, 7.0_f32);
    let mut rgba = Vec::with_capacity((LADO * LADO * 4) as usize);
    for y in 0..LADO {
        for x in 0..LADO {
            let d = ((x as f32 + 0.5 - centro).powi(2) + (y as f32 + 0.5 - centro).powi(2)).sqrt();
            // Borda suavizada; o vazio é um anel de 2 px.
            let fora = (d - raio + 0.5).clamp(0.0, 1.0);
            let dentro = if vazio { (raio - 2.0 - d + 0.5).clamp(0.0, 1.0) } else { 0.0 };
            let alfa = ((1.0 - fora) * (1.0 - dentro) * 255.0) as u8;
            rgba.extend_from_slice(&[cor[0], cor[1], cor[2], alfa]);
        }
    }
    Image::new_owned(rgba, LADO, LADO)
}

/// `AHRENA_ABRIR_MENU=<s>` abre o menu sozinho depois de tantos segundos, para os prints da
/// bandeja e os testes à mão sem clicar.
fn abrir_o_menu_depois(app: &AppHandle) {
    let Some(segundos) = std::env::var("AHRENA_ABRIR_MENU").ok().and_then(|s| s.parse::<u64>().ok()) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(segundos));
        if let Some(b) = app.tray_by_id(BANDEJA) {
            if let Ok(Some(r)) = b.rect() {
                eprintln!("[ahrena-console] bandeja em {:?} {:?}", r.position, r.size);
            }
            let _ = b.with_inner_tray_icon(|t| t.show_menu());
        }
    });
}

fn clique(app: &AppHandle, id: &str) {
    let estado = app.state::<Compartilhado>().inner().clone();
    match id {
        menu::ID_ABRIR => abrir_console(app),
        menu::ID_SAIR => app.exit(0),
        menu::ID_NOTIFICACOES => mudar(app, &estado, |e| {
            e.avisos.alternar();
        }),
        menu::ID_LOGIN => {
            login::clicar(&login::DoSistema);
            // O clique já inverteu a marca nativa: refaz o menu mesmo sem mudança (erro, aprovação).
            mudar(app, &estado, |e| e.ultimo = None);
        }
        menu::ID_ATUALIZAR => atualizacao::instalar(app),
        menu::ID_PROCURAR => {
            let _ = app.state::<Laco>().0.lock().unwrap().send(());
        }
        menu::ID_INSTALAR_NODE => {
            let _ = std::process::Command::new("open").arg("https://nodejs.org/en/download").spawn();
        }
        _ if id.starts_with(menu::MACHINE) => {
            let machine = id[menu::MACHINE.len()..].split('#').next().unwrap_or("");
            open_window_at(app, &machines::machine_path(machine));
        }
        _ => {
            let sessao = id.strip_prefix(menu::SESSAO).or_else(|| id.strip_prefix(menu::SESSAO_NO_DESKTOP));
            if let Some(sessao) = sessao {
                abrir_sessao(app, &estado, sessao);
            }
        }
    }
}

/// Por enquanto, as duas formas abrem no Claude Desktop; a janela do app (A5) vem com a #26.
fn abrir_sessao(app: &AppHandle, estado: &Compartilhado, sessao: &str) {
    let local = estado.lock().unwrap().locais.get(sessao).cloned().flatten();
    abrir_no_desktop(app, local);
}

/// `POST /open/<local_…>` no núcleo; sem `local`, ou com um que o núcleo recusaria, o console.
fn abrir_no_desktop(app: &AppHandle, local: Option<String>) {
    let porta = match app.state::<Compartilhado>().lock().unwrap_or_else(std::sync::PoisonError::into_inner).nucleo {
        EstadoDoNucleo::DePe { porta } => porta,
        _ => return,
    };
    let Some(local) = local else { return abrir_console(app) };
    if !notificacoes::local_valido(&local) {
        eprintln!("[ahrena-console] abrir: local inválido {local:?}, abrindo o console");
        return abrir_console(app);
    }
    std::thread::spawn(move || {
        let r = http::post_json(porta, &format!("/open/{local}"), "{}");
        if r.as_ref().map(|r| r.status) != Some(200) {
            eprintln!("[ahrena-console] abrir {local}: {}", r.map(|r| format!("{} {}", r.status, r.corpo)).unwrap_or_else(|| "sem resposta".into()));
        }
    });
}

fn abrir_console(app: &AppHandle) {
    abrir_janela(app, None);
}

/// The window at a `/ui` path (a session's or a machine's screen), navigating the one already
/// open: the click on a notification and on a machine row.
fn open_window_at(app: &AppHandle, path: &str) {
    abrir_janela(app, Some(path));
}

fn abrir_janela(app: &AppHandle, caminho: Option<&str>) {
    // Only the app's own core: with it not up, look for it again (and open once it is) instead of
    // opening another one.
    let shared = app.state::<Compartilhado>().inner().clone();
    let porta = {
        let mut e = shared.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match e.nucleo {
            EstadoDoNucleo::DePe { porta } => porta,
            _ => {
                e.open_when_up = true;
                drop(e);
                let _ = app.state::<Laco>().0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).send(());
                return;
            }
        }
    };
    let Ok(url) = format!("http://127.0.0.1:{porta}{}", caminho.unwrap_or("/ui")).parse::<tauri::Url>() else { return };
    if let Some(w) = app.get_webview_window("console") {
        // The port is random: a window still on another port (an old core) is moved to this one.
        if caminho.is_some() || w.url().ok().and_then(|u| u.port()) != Some(porta) {
            let _ = w.navigate(url);
        }
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let janela = WebviewWindowBuilder::new(app, "console", WebviewUrl::External(url)).title("Ahrena Console").inner_size(1100.0, 760.0).build();
    if let Ok(w) = janela {
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

/// A ação "Silenciar" da notificação: cala a sessão e grava.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn silenciar(app: &AppHandle, sessao: &str) {
    app.state::<Compartilhado>().lock().unwrap_or_else(std::sync::PoisonError::into_inner).avisos.silenciar(sessao);
}

/// Mostra os avisos: pelo `UNUserNotificationCenter` (com clique e ações) quando ele liga; senão
/// pelo plugin do Tauri, sem clique.
fn avisar(app: &AppHandle, avisos: &[Aviso]) {
    use tauri_plugin_notification::NotificationExt;
    for a in avisos {
        #[cfg(target_os = "macos")]
        if aviso_nativo::ativo() {
            aviso_nativo::enviar(a);
            continue;
        }
        let mut n = app.notification().builder().title(&a.titulo).body(&a.corpo);
        if a.som {
            // No macOS o plugin passa o nome ao `NSUserNotification`, que só reconhece este.
            n = n.sound(if cfg!(target_os = "macos") { "NSUserNotificationDefaultSoundName" } else { "default" });
        }
        if let Err(err) = n.show() {
            eprintln!("[ahrena-console] notificação: {err}");
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
