// A notificação do A3 com clique e ações, direto no `UNUserNotificationCenter`.
//
// O plugin de notificação do Tauri tem `on_action` e `register_action_types` no desktop, mas no
// macOS só reporta o clique pelo `NSUserNotification` (obsoleto), com as ações num menu "Opções".
// Aqui o app usa o `UNUserNotificationCenter`: registra a categoria com "Abrir", "Abrir no Claude
// Desktop" e "Silenciar", põe a sessão e o `local_…` no `userInfo`, pede a apresentação também com
// o app em primeiro plano e responde pelo delegate.
//
// O `UNUserNotificationCenter` derruba o processo quando o app não roda de um bundle (um
// `cargo run` puro: o `mainBundle` sem `bundleIdentifier`). Nesse caso este módulo não liga, e o
// main.rs cai no plugin; o app não registra `on_action` nele, por isso fica sem clique nem ações.
//
// O centro só guarda referência fraca ao delegate: ele fica vivo num `thread_local` da thread
// principal (o `MainThreadMarker` de `iniciar` garante a thread). Os callbacks podem chegar fora dela; o trabalho de janela vai por `run_on_main_thread`.

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

use crate::notificacoes::{self, Aviso, Origin};

const CATEGORIA: &str = "sessao";
/// A machine alert (#180): only "Abrir", the machine has no Claude Desktop conversation to open
/// nor a session to silence.
const MACHINE_CATEGORY: &str = "machine";
const ACAO_ABRIR: &str = "abrir";
const ACAO_NO_DESKTOP: &str = "abrir-no-desktop";
const ACAO_SILENCIAR: &str = "silenciar";
const CHAVE_SESSAO: &str = "sessao";
const CHAVE_LOCAL: &str = "local";
/// The `/ui` path "Abrir" leads to (#180); without it, the session's screen.
const PATH_KEY: &str = "path";

/// O que cada resposta faz; vem do main.rs, que tem o estado e a janela.
pub struct Acoes {
    /// Clique na notificação ou "Abrir": a janela do app no caminho do aviso (a sessão ou a máquina).
    pub abrir: fn(&AppHandle, &str),
    /// "Abrir no Claude Desktop", com o `local_…` do aviso (sem ele, o console).
    pub no_desktop: fn(&AppHandle, Option<String>),
    /// "Silenciar": cala a sessão e grava.
    pub silenciar: fn(&AppHandle, &str),
}

static APP: OnceLock<(AppHandle, Acoes)> = OnceLock::new();
static ATIVO: AtomicBool = AtomicBool::new(false);

thread_local! {
    static DELEGADO: RefCell<Option<Retained<Delegado>>> = const { RefCell::new(None) };
}

define_class!(
    // SAFETY: NSObject não tem exigências para subclasses, e `Delegado` não implementa `Drop`.
    #[unsafe(super(NSObject))]
    #[name = "AhrenaConsoleDelegadoDeAvisos"]
    struct Delegado;

    // SAFETY: `NSObjectProtocol` não tem exigências.
    unsafe impl NSObjectProtocol for Delegado {}

    // SAFETY: as assinaturas são as do protocolo (objc2-user-notifications 0.3), e cada método
    // chama o completion handler exatamente uma vez. O `Delegado` não tem ivars nem estado da
    // thread principal, então pode ser chamado de qualquer fila.
    unsafe impl UNUserNotificationCenterDelegate for Delegado {
        /// Com o app em primeiro plano (a janela do console aberta), o macOS não mostraria nada.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn ao_apresentar(&self, _centro: &UNUserNotificationCenter, _n: &UNNotification, pronto: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            pronto.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::Sound | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn ao_responder(&self, _centro: &UNUserNotificationCenter, resposta: &UNNotificationResponse, pronto: &DynBlock<dyn Fn()>) {
            pronto.call(());
            responder(resposta);
        }
    }
);

impl Delegado {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: `init` de NSObject sobre um objeto recém-alocado.
        unsafe { msg_send![super(this), init] }
    }
}

/// O app roda de um bundle com identificador: sem isso o `UNUserNotificationCenter` aborta.
fn tem_bundle() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Liga o centro: delegate, categoria com as ações do A3 e o pedido de autorização (alerta e som).
/// Na thread principal, no `setup` (o `MainThreadMarker` prova): o `thread_local` do delegate é o
/// dela. Devolve `false` sem bundle; aí o main.rs usa o plugin.
pub fn iniciar(app: &AppHandle, acoes: Acoes, _principal: MainThreadMarker) -> bool {
    if !tem_bundle() {
        eprintln!("[ahrena-console] sem bundle: notificações sem clique (plugin do Tauri)");
        return false;
    }
    if APP.set((app.clone(), acoes)).is_err() {
        return ATIVO.load(Ordering::Relaxed);
    }
    let centro = UNUserNotificationCenter::currentNotificationCenter();
    let delegado = Delegado::new();
    centro.setDelegate(Some(ProtocolObject::from_ref(&*delegado)));
    DELEGADO.with(|d| *d.borrow_mut() = Some(delegado));

    let acao = |id: &str, titulo: &str, opcoes| UNNotificationAction::actionWithIdentifier_title_options(&NSString::from_str(id), &NSString::from_str(titulo), opcoes);
    let acoes = NSArray::from_retained_slice(&[
        acao(ACAO_ABRIR, "Abrir", UNNotificationActionOptions::Foreground),
        acao(ACAO_NO_DESKTOP, "Abrir no Claude Desktop", UNNotificationActionOptions::empty()),
        acao(ACAO_SILENCIAR, "Silenciar", UNNotificationActionOptions::empty()),
    ]);
    let categoria = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(&NSString::from_str(CATEGORIA), &acoes, &NSArray::new(), UNNotificationCategoryOptions::empty());
    let so_abrir = NSArray::from_retained_slice(&[acao(ACAO_ABRIR, "Abrir", UNNotificationActionOptions::Foreground)]);
    let maquina = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(&NSString::from_str(MACHINE_CATEGORY), &so_abrir, &NSArray::new(), UNNotificationCategoryOptions::empty());
    centro.setNotificationCategories(&NSSet::from_retained_slice(&[categoria, maquina]));

    let ao_autorizar = RcBlock::new(|ok: Bool, erro: *mut NSError| {
        // Negadas (ou um bundle sem assinatura que o macOS recusa): cai no plugin, que ainda mostra o aviso.
        if !ok.as_bool() {
            eprintln!("[ahrena-console] notificações não autorizadas{}; usando o plugin do Tauri", descrever(erro));
            ATIVO.store(false, Ordering::Relaxed);
        }
    });
    ATIVO.store(true, Ordering::Relaxed);
    centro.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &ao_autorizar);
    true
}

/// O centro está ligado (e o `enviar` daqui vale).
pub fn ativo() -> bool {
    ATIVO.load(Ordering::Relaxed)
}

/// Mostra o aviso. O identificador é a sessão: um aviso novo dela substitui o anterior.
pub fn enviar(a: &Aviso) {
    let conteudo = UNMutableNotificationContent::new();
    conteudo.setTitle(&NSString::from_str(&a.titulo));
    conteudo.setBody(&NSString::from_str(&a.corpo));
    let categoria = match a.origin {
        Origin::Session => CATEGORIA,
        Origin::Machine => MACHINE_CATEGORY,
    };
    conteudo.setCategoryIdentifier(&NSString::from_str(categoria));
    conteudo.setThreadIdentifier(&NSString::from_str(&a.sessao));
    if a.som {
        conteudo.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    let mut chaves = vec![NSString::from_str(CHAVE_SESSAO), NSString::from_str(PATH_KEY)];
    let mut valores = vec![NSString::from_str(&a.sessao), NSString::from_str(&a.path)];
    if let Some(local) = &a.local {
        chaves.push(NSString::from_str(CHAVE_LOCAL));
        valores.push(NSString::from_str(local));
    }
    let chaves: Vec<&NSString> = chaves.iter().map(|c| &**c).collect();
    let valores: Vec<&NSString> = valores.iter().map(|v| &**v).collect();
    let info = NSDictionary::<NSString, NSString>::from_slices(&chaves, &valores);
    // SAFETY: chaves e valores são NSString, tipos de property list, como o `userInfo` exige; o
    // cast só alarga os genéricos para `AnyObject`.
    unsafe { conteudo.setUserInfo(info.cast_unchecked::<AnyObject, AnyObject>()) };

    let pedido = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&a.sessao), &conteudo, None);
    let ao_enviar = RcBlock::new(|erro: *mut NSError| {
        if !erro.is_null() {
            eprintln!("[ahrena-console] notificação{}", descrever(erro));
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&pedido, Some(&ao_enviar));
}

fn descrever(erro: *mut NSError) -> String {
    // SAFETY: o UserNotifications passa nulo ou um NSError válido durante a chamada.
    match unsafe { erro.as_ref() } {
        Some(e) => format!(": {}", e.localizedDescription()),
        None => String::new(),
    }
}

fn ler(info: &NSDictionary, chave: &str) -> Option<String> {
    let chave = NSString::from_str(chave);
    let valor = info.objectForKey(&chave)?.downcast::<NSString>().ok()?;
    Some(valor.to_string())
}

/// O clique na notificação ou numa das ações.
fn responder(resposta: &UNNotificationResponse) {
    let Some((app, acoes)) = APP.get() else { return };
    let info = resposta.notification().request().content().userInfo();
    let Some(sessao) = ler(&info, CHAVE_SESSAO) else { return };
    let local = ler(&info, CHAVE_LOCAL);
    // A notice from before #180 has no path: the session's screen, as then.
    let path = ler(&info, PATH_KEY).unwrap_or_else(|| notificacoes::caminho_da_sessao(&sessao));
    let acao = resposta.actionIdentifier();
    // SAFETY: constante do UserNotifications, lida depois de o framework carregar.
    let padrao = unsafe { UNNotificationDefaultActionIdentifier };
    let (abrir, no_desktop, silenciar) = (acoes.abrir, acoes.no_desktop, acoes.silenciar);
    let handle = app.clone();
    let trabalho: Box<dyn FnOnce() + Send> = if acao.isEqualToString(padrao) || acao.isEqualToString(&NSString::from_str(ACAO_ABRIR)) {
        Box::new(move || abrir(&handle, &path))
    } else if acao.isEqualToString(&NSString::from_str(ACAO_NO_DESKTOP)) {
        Box::new(move || no_desktop(&handle, local))
    } else if acao.isEqualToString(&NSString::from_str(ACAO_SILENCIAR)) {
        Box::new(move || silenciar(&handle, &sessao))
    } else {
        return;
    };
    let _ = app.run_on_main_thread(trabalho);
}
