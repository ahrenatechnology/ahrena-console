// App desktop do Ahrena Console (decisão 0005, issue #87): uma bandeja na barra de menus.
//
// Ao abrir:
// 1. corrige o PATH com o do shell de login, para achar o `node`;
// 2. adota o núcleo de pé ou sobe um pelo dono único (nucleo.rs);
// 3. lê `GET /api/atencao` e espera mudanças em `GET /api/mudancas` (long polling), e monta o menu
//    dos wireframes A1, A2 e A4 (menu.rs), com o número ao lado do ícone;
// 4. o clique numa sessão a abre no Claude Desktop (`POST /abrir/<local_…>`); "Abrir o console"
//    abre a `/ui` do núcleo numa janela;
// 5. aberto à mão, abre também o console; aberto pelo login, fica só na bandeja (login.rs).
// O app não grava hooks nem configuração do Claude, não embute Node e não tem telas próprias.

mod http;
mod login;
mod menu;
#[cfg(target_os = "macos")]
mod nativo;
mod nucleo;
mod shell_path;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};

use login::Registro;
use menu::{Atencao, EstadoDoNucleo, Item, Ponto};

const BANDEJA: &str = "ahrena";
const ICONE: &[u8] = include_bytes!("../icons/bandeja.png");

/// O que a bandeja mostra; o menu é refeito quando muda.
struct Estado {
    nucleo: EstadoDoNucleo,
    atencao: Option<Atencao>,
    sem_atencao: bool,
    // Nesta etapa só marca: o efeito é da issue #88.
    notificacoes: bool,
    /// O status do `SMAppService` é `enabled` (login.rs), relido a cada menu.
    login: bool,
    /// `id da sessão` → `local_…` do Claude Desktop, do último menu.
    locais: HashMap<String, Option<String>>,
    ultimo: Option<(Vec<Item>, Option<String>)>,
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
        notificacoes: true,
        login: false,
        locais: HashMap::new(),
        ultimo: None,
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
            TrayIconBuilder::with_id(BANDEJA)
                .icon(Image::from_bytes(ICONE)?)
                .icon_as_template(true)
                .tooltip("Ahrena Console")
                .on_menu_event(|app, ev| clique(app, ev.id().as_ref()))
                .build(app)?;
            redesenhar(app.handle(), &estado);

            let recursos = app.path().resource_dir().ok();
            let handle = app.handle().clone();
            std::thread::spawn(move || acompanhar(handle, estado, nucleo::pasta_do_nucleo(recursos), sinais, abrir_na_partida));
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

/// O laço do núcleo: adota ou sobe, lê a atenção e espera mudanças. Roda numa thread à parte.
/// `abrir_na_partida`: abre o console se o núcleo fica de pé já na primeira tentativa (partida à
/// mão); se ele só sobe depois (falta Node, "Procurar de novo"), o console não aparece sozinho.
fn acompanhar(app: AppHandle, estado: Compartilhado, pasta: PathBuf, sinais: std::sync::mpsc::Receiver<()>, mut abrir_na_partida: bool) {
    loop {
        mudar(&app, &estado, |e| {
            e.nucleo = EstadoDoNucleo::Procurando;
            e.atencao = None;
            e.sem_atencao = false;
        });
        let r = nucleo::adotar_ou_subir(&pasta);
        let abrir = std::mem::take(&mut abrir_na_partida);
        let porta = match r.estado {
            EstadoDoNucleo::DePe { porta } => porta,
            ref parado => {
                let parado = parado.clone();
                mudar(&app, &estado, |e| e.nucleo = parado);
                // Tenta de novo a cada 30 s, ou já, no "Procurar o núcleo de novo".
                if let Err(RecvTimeoutError::Disconnected) = sinais.recv_timeout(Duration::from_secs(30)) {
                    return;
                }
                continue;
            }
        };
        mudar(&app, &estado, |e| e.nucleo = EstadoDoNucleo::DePe { porta });
        if abrir {
            eprintln!("[ahrena-console] partida à mão: abre o console");
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || abrir_console(&handle));
        }
        seguir(&app, &estado, porta, &sinais);
        // O núcleo parou de responder: procura (e sobe) de novo.
        while sinais.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// Lê `/api/atencao` e espera em `/api/mudancas` até o núcleo parar de responder.
fn seguir(app: &AppHandle, estado: &Compartilhado, porta: u16, sinais: &std::sync::mpsc::Receiver<()>) {
    let mut cursor: Option<String> = None;
    loop {
        let resposta = http::get_com_status(porta, "/api/atencao", Duration::from_secs(15));
        match resposta {
            Some(r) if r.status == 200 => {
                let Some(atencao) = Atencao::do_json(&r.corpo) else { return };
                cursor = atencao.cursor.clone().or(cursor);
                mudar(app, estado, |e| {
                    e.atencao = Some(atencao);
                    e.sem_atencao = false;
                });
            }
            // Um núcleo de antes da #87: de pé, mas sem a lista. Relê a cada 30 s.
            Some(r) if r.status == 404 => {
                mudar(app, estado, |e| {
                    e.atencao = None;
                    e.sem_atencao = true;
                });
                let _ = sinais.recv_timeout(Duration::from_secs(30));
                if !nucleo::responde(porta) {
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
            Some(c) => format!("/api/mudancas?desde={}&espera=25", http::codificar(c)),
            None => "/api/mudancas?espera=25".into(),
        };
        // Volta com mudanças, com `reiniciar` ou depois de 25 s sem nada: em todos os casos relê,
        // o que também atualiza os minutos de espera. Sem `/api/mudancas` (núcleo antigo), relê a cada 25 s.
        if http::get(porta, &caminho, Duration::from_secs(40)).is_none() {
            let resto = Duration::from_secs(25).saturating_sub(inicio.elapsed());
            if !nucleo::responde(porta) {
                return;
            }
            let _ = sinais.recv_timeout(resto);
        }
    }
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
        let itens = menu::montar(&menu::Entrada { nucleo: &e.nucleo, atencao: e.atencao.as_ref(), sem_atencao: e.sem_atencao, notificacoes: e.notificacoes, login: e.login, versao: &versao });
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
                nativos.push(Box::new(IconMenuItem::with_id(app, format!("{}{sessao}", menu::SESSAO), texto, true, Some(bolinha(*ponto)), None::<&str>)?));
                Box::new(IconMenuItem::with_id(app, format!("{}{sessao}", menu::SESSAO_NO_DESKTOP), alternativo, local.is_some(), Some(bolinha(*ponto)), None::<&str>)?)
            }
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
                a.push(Ajuste::Alternativo(alternativo.clone()));
                a.push(Ajuste::Dica { titulo: texto.clone(), dica: dica.clone() });
                a.push(Ajuste::Dica { titulo: alternativo.clone(), dica: dica.clone() });
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
        menu::ID_NOTIFICACOES => mudar(app, &estado, |e| e.notificacoes = !e.notificacoes),
        menu::ID_LOGIN => {
            login::clicar(&login::DoSistema);
            // O clique já inverteu a marca nativa: refaz o menu mesmo sem mudança (erro, aprovação).
            mudar(app, &estado, |e| e.ultimo = None);
        }
        menu::ID_PROCURAR => {
            let _ = app.state::<Laco>().0.lock().unwrap().send(());
        }
        menu::ID_INSTALAR_NODE => {
            let _ = std::process::Command::new("open").arg("https://nodejs.org/en/download").spawn();
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
    let (local, porta) = {
        let e = estado.lock().unwrap();
        let porta = match e.nucleo {
            EstadoDoNucleo::DePe { porta } => porta,
            _ => return,
        };
        (e.locais.get(sessao).cloned().flatten(), porta)
    };
    let Some(local) = local else { return abrir_console(app) };
    std::thread::spawn(move || {
        let r = http::post_json(porta, &format!("/abrir/{local}"), "{}");
        if r.as_ref().map(|r| r.status) != Some(200) {
            eprintln!("[ahrena-console] abrir {local}: {}", r.map(|r| format!("{} {}", r.status, r.corpo)).unwrap_or_else(|| "sem resposta".into()));
        }
    });
}

fn abrir_console(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("console") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let porta = match app.state::<Compartilhado>().lock().unwrap().nucleo {
        EstadoDoNucleo::DePe { porta } => porta,
        _ => nucleo::PORTA_PADRAO,
    };
    let Ok(url) = format!("http://127.0.0.1:{porta}/ui").parse() else { return };
    let janela = WebviewWindowBuilder::new(app, "console", WebviewUrl::External(url)).title("Ahrena Console").inner_size(1100.0, 760.0).build();
    if let Ok(w) = janela {
        let _ = w.set_focus();
    }
}
