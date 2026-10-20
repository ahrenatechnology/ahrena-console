// Abrir no login (issue #89): o registro pelo `SMAppService.mainApp` do macOS 13+, sem LaunchAgent,
// e a partida pelo login só na bandeja.
//
// A lógica é pura e testada com um registro falso; o real fala com o ServiceManagement. O item
// "Abrir no login" só fica marcado com o status `enabled`, relido a cada menu: o usuário pode tirar
// o item em Ajustes › Geral › Itens de Início.

/// O status do `SMAppService`, com nomes nossos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// `enabled`: registrado e liberado.
    Ligado,
    /// `notRegistered`.
    Desligado,
    /// `requiresApproval`: registrado, mas o usuário desligou (ou ainda não liberou) em Ajustes.
    PedeAprovacao,
    /// `notFound`.
    NaoEncontrado,
}

/// O que o app pede ao sistema. O real é o `SMAppService`; nos testes, um falso.
pub trait Registro {
    fn status(&self) -> Status;
    fn registrar(&self) -> Result<(), String>;
    fn remover(&self) -> Result<(), String>;
    /// Ajustes › Itens de Início, onde o usuário aprova.
    fn abrir_ajustes(&self);
}

/// O item fica marcado só com o registro ligado.
pub fn marcado(s: Status) -> bool {
    s == Status::Ligado
}

/// O clique em "Abrir no login": desliga o ligado, liga o desligado e, se falta aprovar, abre os
/// Ajustes. Devolve sempre o status relido, e não o desejado.
pub fn clicar(r: &dyn Registro) -> Status {
    let resultado = match r.status() {
        Status::Ligado => r.remover().map_err(|e| format!("remover: {e}")),
        Status::Desligado | Status::NaoEncontrado => r.registrar().map_err(|e| format!("registrar: {e}")),
        Status::PedeAprovacao => {
            r.abrir_ajustes();
            Ok(())
        }
    };
    if let Err(e) = resultado {
        eprintln!("[ahrena-console] abrir no login: {e}");
    }
    r.status()
}

/// De onde veio a partida do app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origem {
    /// Aberto pelo login: só a bandeja.
    Login,
    /// Aberto à mão (Finder, Dock, `open`): abre também o console.
    Manual,
}

impl Origem {
    pub fn nome(self) -> &'static str {
        match self {
            Origem::Login => "login",
            Origem::Manual => "manual",
        }
    }
}

pub fn abrir_janela_na_partida(o: Origem) -> bool {
    o == Origem::Manual
}

/// `AHRENA_ORIGEM=login|manual` finge a origem, para testar à mão.
pub fn origem_da_variavel(v: Option<&str>) -> Option<Origem> {
    match v?.trim() {
        "login" => Some(Origem::Login),
        "manual" => Some(Origem::Manual),
        _ => None,
    }
}

const fn codigo(c: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*c)
}

/// `kCoreEventClass`, `kAEOpenApplication`, `keyAEPropData` e `keyAELaunchedAsLogInItem`.
pub const AEVT: u32 = codigo(b"aevt");
pub const OAPP: u32 = codigo(b"oapp");
pub const PRDT: u32 = codigo(b"prdt");
pub const LGIT: u32 = codigo(b"lgit");

/// O Apple Event de abertura (`aevt`/`oapp`) diz se veio do login no parâmetro `prdt` == `lgit`,
/// como o `wasOpenedAtLogin` do Electron. Outro evento não diz nada.
pub fn origem_do_evento(classe: u32, id: u32, prdt: Option<u32>) -> Option<Origem> {
    if classe != AEVT || id != OAPP {
        return None;
    }
    Some(if prdt == Some(LGIT) { Origem::Login } else { Origem::Manual })
}

/// A origem e de onde ela saiu: a variável, o evento ou o padrão (manual).
pub fn descobrir(variavel: Option<&str>, evento: Option<(u32, u32, Option<u32>)>) -> (Origem, &'static str) {
    if let Some(o) = origem_da_variavel(variavel) {
        return (o, "variável");
    }
    if let Some(o) = evento.and_then(|(c, i, p)| origem_do_evento(c, i, p)) {
        return (o, "evento");
    }
    (Origem::Manual, "padrão")
}

/// O Apple Event em curso, lido no `setup` (que roda dentro do `applicationDidFinishLaunching`).
#[cfg(target_os = "macos")]
pub fn evento_de_abertura() -> Option<(u32, u32, Option<u32>)> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};

    let ev = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent()?;
    // SAFETY: `eventClass`, `eventID` e `paramDescriptorForKeyword:` são do NSAppleEventDescriptor,
    // com códigos de quatro letras (u32); o objc2-foundation só os expõe com o objc2-core-services.
    let (classe, id, prdt): (u32, u32, Option<Retained<NSAppleEventDescriptor>>) =
        unsafe { (msg_send![&*ev, eventClass], msg_send![&*ev, eventID], msg_send![&*ev, paramDescriptorForKeyword: PRDT]) };
    Some((classe, id, prdt.map(|d| d.enumCodeValue())))
}

#[cfg(not(target_os = "macos"))]
pub fn evento_de_abertura() -> Option<(u32, u32, Option<u32>)> {
    None
}

/// O registro do próprio app (`SMAppService.mainApp`).
pub struct DoSistema;

#[cfg(target_os = "macos")]
impl Registro for DoSistema {
    fn status(&self) -> Status {
        use objc2_service_management::{SMAppService, SMAppServiceStatus};
        // SAFETY: chamadas sem argumentos do ServiceManagement, macOS 13+ (o mínimo do app).
        match unsafe { SMAppService::mainAppService().status() } {
            SMAppServiceStatus::Enabled => Status::Ligado,
            SMAppServiceStatus::RequiresApproval => Status::PedeAprovacao,
            SMAppServiceStatus::NotFound => Status::NaoEncontrado,
            _ => Status::Desligado,
        }
    }

    fn registrar(&self) -> Result<(), String> {
        // SAFETY: idem.
        unsafe { objc2_service_management::SMAppService::mainAppService().registerAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
    }

    fn remover(&self) -> Result<(), String> {
        // SAFETY: idem.
        unsafe { objc2_service_management::SMAppService::mainAppService().unregisterAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
    }

    fn abrir_ajustes(&self) {
        // SAFETY: idem.
        unsafe { objc2_service_management::SMAppService::openSystemSettingsLoginItems() }
    }
}

/// Fora do macOS ainda não há registro: fica desligado.
#[cfg(not(target_os = "macos"))]
impl Registro for DoSistema {
    fn status(&self) -> Status {
        Status::Desligado
    }
    fn registrar(&self) -> Result<(), String> {
        Err("só no macOS".into())
    }
    fn remover(&self) -> Result<(), String> {
        Ok(())
    }
    fn abrir_ajustes(&self) {}
}

#[cfg(test)]
mod testes {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// Um registro falso que conta as chamadas e pode falhar.
    struct Falso {
        status: Cell<Status>,
        falhar: bool,
        chamadas: RefCell<Vec<&'static str>>,
    }

    impl Falso {
        fn com(s: Status) -> Self {
            Falso { status: Cell::new(s), falhar: false, chamadas: RefCell::new(Vec::new()) }
        }
        fn falhando(s: Status) -> Self {
            Falso { falhar: true, ..Falso::com(s) }
        }
        fn chamadas(&self) -> Vec<&'static str> {
            self.chamadas.borrow().clone()
        }
    }

    impl Registro for Falso {
        fn status(&self) -> Status {
            self.status.get()
        }
        fn registrar(&self) -> Result<(), String> {
            self.chamadas.borrow_mut().push("registrar");
            if self.falhar {
                return Err("negado".into());
            }
            self.status.set(Status::Ligado);
            Ok(())
        }
        fn remover(&self) -> Result<(), String> {
            self.chamadas.borrow_mut().push("remover");
            if self.falhar {
                return Err("negado".into());
            }
            self.status.set(Status::Desligado);
            Ok(())
        }
        fn abrir_ajustes(&self) {
            self.chamadas.borrow_mut().push("abrir_ajustes");
        }
    }

    #[test]
    fn so_o_ligado_marca() {
        assert!(marcado(Status::Ligado));
        assert!(!marcado(Status::Desligado));
        assert!(!marcado(Status::PedeAprovacao));
        assert!(!marcado(Status::NaoEncontrado));
    }

    #[test]
    fn clicar_desligado_registra_e_marca() {
        let r = Falso::com(Status::Desligado);
        assert_eq!(clicar(&r), Status::Ligado);
        assert!(marcado(r.status()));
        assert_eq!(r.chamadas(), ["registrar"]);
    }

    #[test]
    fn clicar_nao_encontrado_registra() {
        let r = Falso::com(Status::NaoEncontrado);
        assert_eq!(clicar(&r), Status::Ligado);
        assert_eq!(r.chamadas(), ["registrar"]);
    }

    #[test]
    fn clicar_ligado_remove_e_desmarca() {
        let r = Falso::com(Status::Ligado);
        assert_eq!(clicar(&r), Status::Desligado);
        assert!(!marcado(r.status()));
        assert_eq!(r.chamadas(), ["remover"]);
    }

    #[test]
    fn pede_aprovacao_fica_desmarcado_e_abre_os_ajustes() {
        let r = Falso::com(Status::PedeAprovacao);
        assert!(!marcado(r.status()));
        assert_eq!(clicar(&r), Status::PedeAprovacao);
        assert_eq!(r.chamadas(), ["abrir_ajustes"]);
    }

    #[test]
    fn erro_ao_registrar_mostra_o_status_relido() {
        let r = Falso::falhando(Status::Desligado);
        assert_eq!(clicar(&r), Status::Desligado);
        assert_eq!(r.chamadas(), ["registrar"]);
    }

    #[test]
    fn erro_ao_remover_mostra_o_status_relido() {
        let r = Falso::falhando(Status::Ligado);
        assert_eq!(clicar(&r), Status::Ligado);
        assert_eq!(r.chamadas(), ["remover"]);
    }

    #[test]
    fn pelo_login_so_a_bandeja_e_a_mao_abre_o_console() {
        assert!(!abrir_janela_na_partida(Origem::Login));
        assert!(abrir_janela_na_partida(Origem::Manual));
    }

    #[test]
    fn a_variavel_finge_a_origem() {
        assert_eq!(origem_da_variavel(Some("login")), Some(Origem::Login));
        assert_eq!(origem_da_variavel(Some("manual")), Some(Origem::Manual));
        assert_eq!(origem_da_variavel(Some("outra")), None);
        assert_eq!(origem_da_variavel(Some("")), None);
        assert_eq!(origem_da_variavel(None), None);
    }

    #[test]
    fn o_evento_de_abertura_pelo_login() {
        assert_eq!(origem_do_evento(AEVT, OAPP, Some(LGIT)), Some(Origem::Login));
        assert_eq!(origem_do_evento(AEVT, OAPP, None), Some(Origem::Manual));
        assert_eq!(origem_do_evento(AEVT, OAPP, Some(codigo(b"xxxx"))), Some(Origem::Manual));
        // `odoc` (abrir um arquivo) não diz de onde veio.
        assert_eq!(origem_do_evento(AEVT, codigo(b"odoc"), Some(LGIT)), None);
    }

    #[test]
    fn a_variavel_vence_o_evento_e_o_padrao_e_manual() {
        assert_eq!(descobrir(Some("login"), Some((AEVT, OAPP, None))), (Origem::Login, "variável"));
        assert_eq!(descobrir(None, Some((AEVT, OAPP, Some(LGIT)))), (Origem::Login, "evento"));
        assert_eq!(descobrir(Some("?"), Some((AEVT, OAPP, None))), (Origem::Manual, "evento"));
        assert_eq!(descobrir(None, None), (Origem::Manual, "padrão"));
    }
}
