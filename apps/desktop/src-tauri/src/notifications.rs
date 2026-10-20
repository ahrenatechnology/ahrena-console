// As notificações do sistema (wireframe A3, issue #88) como dados: quando avisar, o quê e quem cala.
//
// Fica separado do Tauri para ser testado sem abrir o app. A bandeja relê `/api/attention` a cada
// mudança e a cada 25 s; avisar a cada leitura seria barulho. O `Detector` guarda o motivo de cada
// sessão na leitura anterior e só avisa quem entrou na lista ou trocou de motivo. A primeira
// leitura (ao abrir, ou depois de perder o núcleo) só grava: quem já esperava não vira aviso.
//
// Machine alerts (#180, decision 0008 sections 3 and 5) follow the same rule with their own
// detector: a new alert, or a machine going down (its `machine-unreachable` alert), notifies once,
// on the transition, without sound; the first read and a rediscovery of the core only record.
//
// O silêncio é do app, não do núcleo: um JSON pequeno no diretório de dados do app, com a chave
// geral do menu ("Notificações") e as sessões caladas pela ação "Silenciar" da notificação.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::http;
use crate::machines;
use crate::menu::{Atencao, ItemDaAtencao};

/// O nome do arquivo do silêncio no diretório de dados do app.
pub const ARQUIVO: &str = "notificacoes.json";

/// Uma notificação a mostrar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aviso {
    pub titulo: String,
    pub corpo: String,
    /// Só nos urgentes: pede permissão, interrompida e com erro.
    pub som: bool,
    pub sessao: String,
    /// O `local_…` do Claude Desktop, para "Abrir no Claude Desktop".
    pub local: Option<String>,
    /// Where the click and "Abrir" take the app window: the session's or the machine's screen.
    pub path: String,
    pub origin: Origin,
}

/// What a notice is about: it decides the actions the notification offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// "Abrir", "Abrir no Claude Desktop" and "Silenciar" (A3).
    Session,
    /// A session on a remote machine (#180, decision 0008 section 5): "Abrir" and "Silenciar",
    /// no "Abrir no Claude Desktop", since this Mac's Claude Desktop does not know it.
    RemoteSession,
    /// A machine alert (#180): only "Abrir".
    Machine,
}

/// An action button of a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// "Abrir": the app window at the notice's `path`.
    Open,
    /// "Abrir no Claude Desktop": `POST /open/<local_…>`.
    OpenInDesktop,
    /// "Silenciar": silences the session.
    Silence,
}

impl Origin {
    /// The actions this kind of notice offers, in the order the notification shows them.
    pub fn actions(self) -> &'static [Action] {
        match self {
            Origin::Session => &[Action::Open, Action::OpenInDesktop, Action::Silence],
            Origin::RemoteSession => &[Action::Open, Action::Silence],
            Origin::Machine => &[Action::Open],
        }
    }
}

impl Aviso {
    pub fn do_item(i: &ItemDaAtencao) -> Aviso {
        Aviso {
            titulo: titulo(i),
            corpo: i.long_reason.clone(),
            som: com_som(&i.reason),
            sessao: i.session.clone(),
            local: i.local.clone(),
            path: caminho_da_sessao(&i.session),
            origin: if i.machine.is_some() { Origin::RemoteSession } else { Origin::Session },
        }
    }

    /// A machine alert as a notification, silent: "Workstation: CPU saturada", "Workstation sem
    /// conexão". `sessao` carries the alert key, the notification's identifier.
    pub fn from_machine_alert(m: &machines::MachineSummary, a: &machines::Alert) -> Aviso {
        let label = machines::display_label(m);
        let (titulo, corpo) = match a.kind.as_str() {
            machines::UNREACHABLE_KIND => (format!("{label} sem conexão"), a.detail.clone().unwrap_or_default()),
            "load-high" => (format!("{label}: CPU saturada"), a.message.clone()),
            "volume-full" => (format!("{label}: disco quase cheio"), a.message.clone()),
            _ => (format!("{label}: {}", a.message), a.detail.clone().unwrap_or_default()),
        };
        Aviso { titulo, corpo, som: false, sessao: alert_key(&m.id, &a.id), local: None, path: machines::machine_path(&m.id), origin: Origin::Machine }
    }
}

/// The identity of a machine alert across reads, as `/api/changes` names it (`<machine>:<alert>`),
/// with a prefix that never collides with a session id in the silence file or the notification center.
fn alert_key(machine: &str, alert: &str) -> String {
    format!("machine:{machine}:{alert}")
}

/// The machine alerts that opened since the previous read (#180).
#[derive(Debug, Default)]
pub struct MachineAlertDetector {
    /// The alert keys of the previous read; `None` before the first (or after `reset`).
    previous: Option<HashSet<String>>,
}

impl MachineAlertDetector {
    pub fn observe(&mut self, ms: &[machines::Machine]) -> Vec<Aviso> {
        let mut now: HashSet<String> = HashSet::new();
        let mut notices = Vec::new();
        for m in ms {
            let Some(t) = &m.telemetry else {
                // The telemetry read failed this time: keep what was open, so it does not notify again.
                let prefix = alert_key(&m.summary.id, "");
                now.extend(self.previous.iter().flatten().filter(|k| k.starts_with(&prefix)).cloned());
                continue;
            };
            for a in &t.alerts {
                let key = alert_key(&m.summary.id, &a.id);
                if self.previous.as_ref().is_some_and(|p| !p.contains(&key)) {
                    notices.push(Aviso::from_machine_alert(&m.summary, a));
                }
                now.insert(key);
            }
        }
        self.previous = Some(now);
        notices
    }

    /// Forgets the previous read: the next one only records. On losing the core or its telemetry.
    pub fn reset(&mut self) {
        self.previous = None;
    }
}

/// O título do A3: a sessão e o motivo ("motor-de-regras pede permissão").
pub fn titulo(i: &ItemDaAtencao) -> String {
    // A remote session carries its machine's label (#180): "motor-de-regras · Workstation pede permissão".
    let t = match &i.machine {
        Some(m) => format!("{} · {}", i.title, m.label),
        None => i.title.clone(),
    };
    match i.reason.as_str() {
        "permission" => format!("{t} pede permissão"),
        "question" => format!("{t} fez uma pergunta"),
        "plan" => format!("{t} tem um plano para aprovar"),
        "decision" => format!("{t} pede uma decisão"),
        "error" => format!("{t} parou com erro"),
        "your-turn" => format!("{t}: sua vez"),
        "interrupted" => format!("{t} foi interrompida"),
        "no-prompt" => format!("{t}: sessão nova"),
        _ => format!("{t}: {}", i.short_reason),
    }
}

fn com_som(motivo: &str) -> bool {
    matches!(motivo, "permission" | "interrupted" | "error")
}

/// Quem entrou na lista ou trocou de motivo desde a leitura anterior.
#[derive(Debug, Default)]
pub struct Detector {
    /// `sessão` → `motivo` da leitura anterior; `None` antes da primeira (ou depois de `zerar`).
    anterior: Option<HashMap<String, String>>,
}

impl Detector {
    pub fn observar(&mut self, a: &Atencao) -> Vec<Aviso> {
        let agora: HashMap<String, String> = a.items.iter().map(|i| (i.session.clone(), i.reason.clone())).collect();
        let avisos = match &self.anterior {
            None => Vec::new(),
            Some(antes) => a.items.iter().filter(|i| antes.get(&i.session) != Some(&i.reason)).map(Aviso::do_item).collect(),
        };
        self.anterior = Some(agora);
        avisos
    }

    /// Esquece a leitura anterior: a próxima só grava. Ao perder o núcleo ou a lista.
    pub fn zerar(&mut self) {
        self.anterior = None;
    }
}

/// A chave geral e as sessões caladas, como vão no JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Silencio {
    /// A marca de "Notificações" no menu; desligada, nada avisa.
    #[serde(default = "ligadas")]
    pub ligadas: bool,
    #[serde(default)]
    pub sessoes: BTreeSet<String>,
}

fn ligadas() -> bool {
    true
}

impl Default for Silencio {
    fn default() -> Self {
        Silencio { ligadas: true, sessoes: BTreeSet::new() }
    }
}

impl Silencio {
    pub fn filtrar(&self, avisos: Vec<Aviso>) -> Vec<Aviso> {
        if !self.ligadas {
            return Vec::new();
        }
        avisos.into_iter().filter(|a| !self.sessoes.contains(&a.sessao)).collect()
    }

    /// Ausente ou ilegível: o padrão (ligadas, ninguém calado).
    pub fn carregar(caminho: &Path) -> Silencio {
        std::fs::read_to_string(caminho).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Grava num temporário ao lado e renomeia, para não deixar meio arquivo.
    pub fn gravar(&self, caminho: &Path) -> io::Result<()> {
        if let Some(pasta) = caminho.parent() {
            std::fs::create_dir_all(pasta)?;
        }
        let texto = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        let tmp = caminho.with_extension("json.tmp");
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(texto.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, caminho)
    }
}

/// O detector, o silêncio e onde ele é gravado: o que o app guarda das notificações.
#[derive(Debug, Default)]
pub struct Avisos {
    pub detector: Detector,
    /// The machine alerts' detector (#180), behind the same switch.
    pub machines: MachineAlertDetector,
    pub silencio: Silencio,
    /// `None` quando o app não tem diretório de dados: o silêncio vale só até sair.
    pub arquivo: Option<PathBuf>,
}

impl Avisos {
    pub fn abrir(arquivo: Option<PathBuf>) -> Avisos {
        let silencio = arquivo.as_deref().map(Silencio::carregar).unwrap_or_default();
        Avisos { detector: Detector::default(), machines: MachineAlertDetector::default(), silencio, arquivo }
    }

    /// Os avisos desta leitura que passam pelo silêncio.
    pub fn ler(&mut self, a: &Atencao) -> Vec<Aviso> {
        let novos = self.detector.observar(a);
        self.silencio.filtrar(novos)
    }

    /// The machine notices of this read that pass the silence (#180).
    pub fn read_machines(&mut self, ms: &[machines::Machine]) -> Vec<Aviso> {
        let new = self.machines.observe(ms);
        self.silencio.filtrar(new)
    }

    /// O clique em "Notificações". Devolve o novo estado da chave.
    pub fn alternar(&mut self) -> bool {
        self.silencio.ligadas = !self.silencio.ligadas;
        self.gravar();
        self.silencio.ligadas
    }

    /// A ação "Silenciar" da notificação.
    pub fn silenciar(&mut self, sessao: &str) {
        if self.silencio.sessoes.insert(sessao.to_string()) {
            self.gravar();
        }
    }

    fn gravar(&self) {
        let Some(arquivo) = &self.arquivo else { return };
        if let Err(err) = self.silencio.gravar(arquivo) {
            eprintln!("[ahrena-console] gravar {}: {err}", arquivo.display());
        }
    }
}

/// A tela de detalhe da sessão na `/ui` do núcleo, aonde "Abrir" leva. Vazia, "." ou ".." não
/// formam um segmento de caminho: aí, a `/ui`.
pub fn caminho_da_sessao(sessao: &str) -> String {
    if matches!(sessao, "" | "." | "..") {
        return "/ui".into();
    }
    format!("/ui/sessions/{}", http::codificar(sessao))
}

/// O `local_…` que o `POST /open/` do núcleo aceita: `local_` e de 8 a 64 de `[0-9a-fA-F-]`.
pub fn local_valido(local: &str) -> bool {
    let Some(resto) = local.strip_prefix("local_") else { return false };
    (8..=64).contains(&resto.len()) && resto.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Onde fica o JSON: em `AHRENA_DADOS_DIR`, se houver, ou no diretório de dados do app.
pub fn caminho(dados_do_app: Option<PathBuf>) -> Option<PathBuf> {
    let pasta = std::env::var_os("AHRENA_DADOS_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).or(dados_do_app)?;
    Some(pasta.join(ARQUIVO))
}

#[cfg(test)]
mod testes {
    use super::*;

    fn item(sessao: &str, titulo: &str, motivo: &str) -> ItemDaAtencao {
        ItemDaAtencao {
            session: sessao.into(),
            title: titulo.into(),
            account: None,
            level: if motivo == "your-turn" { "your-turn" } else { "needs" }.into(),
            reason: motivo.into(),
            short_reason: format!("curto de {motivo}"),
            long_reason: format!("longo de {motivo}"),
            minutes: 1,
            local: None,
            machine: None,
        }
    }

    fn atencao(itens: Vec<ItemDaAtencao>) -> Atencao {
        Atencao { cursor: None, total: itens.len() as u64, active: 0, with_error: 0, items: itens }
    }

    fn sessoes(avisos: &[Aviso]) -> Vec<&str> {
        avisos.iter().map(|a| a.sessao.as_str()).collect()
    }

    /// Uma pasta só deste teste em `temp_dir`, apagada ao fim.
    struct Pasta(PathBuf);

    impl Pasta {
        fn nova(nome: &str) -> Pasta {
            let p = std::env::temp_dir().join(format!("ahrena-console-teste-{nome}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            Pasta(p)
        }
    }

    impl Drop for Pasta {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn primeira_leitura_nao_avisa() {
        let mut d = Detector::default();
        assert!(d.observar(&atencao(vec![item("s1", "a", "permission"), item("s2", "b", "error")])).is_empty());
    }

    #[test]
    fn entrada_avisa_uma_vez() {
        let mut d = Detector::default();
        d.observar(&atencao(vec![]));
        let lista = atencao(vec![item("s1", "a", "permission")]);
        assert_eq!(sessoes(&d.observar(&lista)), ["s1"]);
        assert!(d.observar(&lista).is_empty(), "a leitura repetida não avisa");
        assert!(d.observar(&lista).is_empty());
    }

    #[test]
    fn troca_de_motivo_avisa() {
        let mut d = Detector::default();
        d.observar(&atencao(vec![item("s1", "a", "your-turn"), item("s2", "b", "question")]));
        let avisos = d.observar(&atencao(vec![item("s1", "a", "permission"), item("s2", "b", "question")]));
        assert_eq!(sessoes(&avisos), ["s1"]);
        assert_eq!(avisos[0].titulo, "a pede permissão");
    }

    #[test]
    fn saiu_e_voltou_avisa() {
        let mut d = Detector::default();
        d.observar(&atencao(vec![item("s1", "a", "permission")]));
        assert!(d.observar(&atencao(vec![])).is_empty());
        assert_eq!(sessoes(&d.observar(&atencao(vec![item("s1", "a", "permission")]))), ["s1"]);
    }

    #[test]
    fn reconexao_nao_avisa() {
        let mut d = Detector::default();
        d.observar(&atencao(vec![]));
        d.zerar();
        assert!(d.observar(&atencao(vec![item("s1", "a", "error")])).is_empty());
        assert_eq!(sessoes(&d.observar(&atencao(vec![item("s1", "a", "error"), item("s2", "b", "error")]))), ["s2"]);
    }

    #[test]
    fn som_so_nos_urgentes() {
        let com: Vec<_> = ["permission", "question", "plan", "decision", "error", "your-turn", "interrupted", "no-prompt", "outro"]
            .into_iter()
            .filter(|m| Aviso::do_item(&item("s", "t", m)).som)
            .collect();
        assert_eq!(com, ["permission", "error", "interrupted"]);
    }

    #[test]
    fn titulos_do_a3() {
        let a = |t: &str, m: &str| titulo(&item("s", t, m));
        assert_eq!(a("motor-de-regras", "permission"), "motor-de-regras pede permissão");
        assert_eq!(a("painel-de-metricas", "error"), "painel-de-metricas parou com erro");
        assert_eq!(a("fila-de-tarefas", "your-turn"), "fila-de-tarefas: sua vez");
        assert_eq!(a("x", "interrupted"), "x foi interrompida");
        assert_eq!(a("x", "motivo-novo"), "x: curto de motivo-novo");
    }

    #[test]
    fn corpo_e_local() {
        let mut i = item("s1", "a", "permission");
        i.local = Some("local_1".into());
        let av = Aviso::do_item(&i);
        assert_eq!((av.corpo.as_str(), av.local.as_deref()), ("longo de permission", Some("local_1")));
    }

    #[test]
    fn caminho_da_tela_da_sessao() {
        assert_eq!(caminho_da_sessao("c3f09b52"), "/ui/sessions/c3f09b52");
        assert_eq!(caminho_da_sessao("a:b/c"), "/ui/sessions/a%3Ab%2Fc");
        for vazia in ["", ".", ".."] {
            assert_eq!(caminho_da_sessao(vazia), "/ui", "{vazia:?}");
        }
    }

    #[test]
    fn local_como_o_nucleo() {
        assert!(local_valido("local_716ecd97-6a9b-4452-9770-e2c155279784"));
        assert!(local_valido("local_ABCDEF01"));
        assert!(local_valido(&format!("local_{}", "a".repeat(64))));
        assert!(!local_valido("local_1234567"), "menos de 8");
        assert!(!local_valido(&format!("local_{}", "a".repeat(65))), "mais de 64");
        assert!(!local_valido("local_1234567g"));
        assert!(!local_valido("local_12345678/../x"));
        assert!(!local_valido("remoto_12345678"));
        assert!(!local_valido(""));
    }

    #[test]
    fn silencio_global() {
        let avisos = vec![Aviso::do_item(&item("s1", "a", "error"))];
        let s = Silencio { ligadas: false, ..Silencio::default() };
        assert!(s.filtrar(avisos.clone()).is_empty());
        assert_eq!(Silencio::default().filtrar(avisos.clone()), avisos);
    }

    #[test]
    fn silencio_por_sessao() {
        let avisos = vec![Aviso::do_item(&item("s1", "a", "error")), Aviso::do_item(&item("s2", "b", "error"))];
        let mut s = Silencio::default();
        s.sessoes.insert("s1".into());
        assert_eq!(sessoes(&s.filtrar(avisos)), ["s2"]);
    }

    #[test]
    fn avisos_le_e_filtra() {
        let mut a = Avisos::abrir(None);
        a.ler(&atencao(vec![]));
        a.silenciar("s1");
        assert_eq!(sessoes(&a.ler(&atencao(vec![item("s1", "a", "error"), item("s2", "b", "error")]))), ["s2"]);
        assert!(!a.alternar());
        assert!(a.ler(&atencao(vec![item("s3", "c", "error")])).is_empty());
    }

    #[test]
    fn silencio_global_nao_para_o_detector() {
        let p = Pasta::nova("global-desligado");
        let mut a = Avisos::abrir(Some(p.0.join(ARQUIVO)));
        a.ler(&atencao(vec![]));
        assert!(!a.alternar());
        assert!(a.ler(&atencao(vec![item("s1", "a", "error")])).is_empty(), "desligado não avisa");
        assert!(a.alternar());
        assert!(a.ler(&atencao(vec![item("s1", "a", "error")])).is_empty(), "religar não avisa quem já estava");
    }

    #[test]
    fn persistencia_ida_e_volta() {
        let p = Pasta::nova("ida-e-volta");
        let arquivo = p.0.join("sub").join(ARQUIVO);
        let mut a = Avisos::abrir(Some(arquivo.clone()));
        assert_eq!(a.silencio, Silencio::default());
        a.silenciar("s1");
        a.alternar();
        let lido = Silencio::carregar(&arquivo);
        assert_eq!(lido, Silencio { ligadas: false, sessoes: ["s1".to_string()].into() });
        assert_eq!(Avisos::abrir(Some(arquivo.clone())).silencio, lido);
        assert!(!arquivo.with_extension("json.tmp").exists());
    }

    // ---- #180: machine alerts ----

    fn alert(id: &str, kind: &str, message: &str, detail: Option<&str>) -> machines::Alert {
        machines::Alert { id: id.into(), kind: kind.into(), level: "error".into(), message: message.into(), detail: detail.map(Into::into), since: "2026-10-18T22:58:00.000Z".into() }
    }

    fn machine(id: &str, label: &str, state: &str, alerts: Option<Vec<machines::Alert>>) -> machines::Machine {
        machines::Machine {
            summary: machines::MachineSummary { id: id.into(), label: label.into(), state: state.into(), reason: None, port: Some(14720), last_read_at: None },
            telemetry: alerts.map(|alerts| machines::Telemetry { current: None, alerts }),
        }
    }

    fn load() -> machines::Alert {
        alert("load-high", "load-high", "CPU saturada: carga de 24,6 em 16 núcleos", None)
    }

    fn down() -> machines::Alert {
        alert("machine-unreachable", "machine-unreachable", "Workstation sem conexão", Some("A porta 14720 deste Mac não aceita conexão: o túnel está caído"))
    }

    fn ids(avisos: &[Aviso]) -> Vec<&str> {
        avisos.iter().map(|a| a.sessao.as_str()).collect()
    }

    #[test]
    fn criterion_5_first_read_of_machines_does_not_notify() {
        let mut d = MachineAlertDetector::default();
        assert!(d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]).is_empty());
    }

    #[test]
    fn criterion_5_new_alert_notifies_once_silently() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![]))]);
        let with = [machine("workstation", "Workstation", "connected", Some(vec![load()]))];
        let avisos = d.observe(&with);
        assert_eq!(ids(&avisos), ["machine:workstation:load-high"]);
        let a = &avisos[0];
        assert_eq!((a.titulo.as_str(), a.corpo.as_str()), ("Workstation: CPU saturada", "CPU saturada: carga de 24,6 em 16 núcleos"));
        assert!(!a.som, "machine notifications are silent");
        assert_eq!((a.path.as_str(), a.origin, a.local.as_deref()), ("/ui/machines/workstation", Origin::Machine, None));
        assert!(d.observe(&with).is_empty(), "the repeated read does not notify");
    }

    #[test]
    fn criterion_5_machine_going_down_notifies_once() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("local", "Esta máquina", "connected", Some(vec![])), machine("workstation", "Workstation", "connected", Some(vec![]))]);
        let gone = [machine("local", "Esta máquina", "connected", Some(vec![])), machine("workstation", "Workstation", "unreachable", Some(vec![down()]))];
        let avisos = d.observe(&gone);
        assert_eq!(ids(&avisos), ["machine:workstation:machine-unreachable"]);
        assert_eq!(avisos[0].titulo, "Workstation sem conexão");
        assert_eq!(avisos[0].corpo, "A porta 14720 deste Mac não aceita conexão: o túnel está caído");
        assert!(!avisos[0].som);
        assert!(d.observe(&gone).is_empty());
    }

    #[test]
    fn criterion_5_this_mac_is_named_este_mac() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("local", "Esta máquina", "connected", Some(vec![]))]);
        let avisos = d.observe(&[machine("local", "Esta máquina", "connected", Some(vec![load()]))]);
        assert_eq!(avisos[0].titulo, "Este Mac: CPU saturada");
        assert_eq!(avisos[0].path, "/ui/machines/local");
    }

    #[test]
    fn criterion_5_a_telemetry_read_that_failed_does_not_renotify() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]);
        assert!(d.observe(&[machine("workstation", "Workstation", "connected", None)]).is_empty());
        assert!(d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]).is_empty(), "the alert never left");
    }

    #[test]
    fn criterion_5_rediscovery_does_not_notify() {
        let mut d = MachineAlertDetector::default();
        d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![]))]);
        d.reset();
        assert!(d.observe(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]).is_empty());
    }

    #[test]
    fn criterion_5_respects_the_notificacoes_switch() {
        let mut a = Avisos::abrir(None);
        a.read_machines(&[machine("workstation", "Workstation", "connected", Some(vec![]))]);
        assert!(!a.alternar());
        assert!(a.read_machines(&[machine("workstation", "Workstation", "connected", Some(vec![load()]))]).is_empty(), "off: nothing");
        assert!(a.alternar());
        let avisos = a.read_machines(&[machine("workstation", "Workstation", "connected", Some(vec![load(), down()]))]);
        assert_eq!(ids(&avisos), ["machine:workstation:machine-unreachable"], "turning back on does not notify what was already open");
    }

    fn remote(sessao: &str, titulo: &str, motivo: &str) -> ItemDaAtencao {
        ItemDaAtencao { machine: Some(crate::menu::SessionMachine { id: "workstation".into(), label: "Workstation".into() }), ..item(sessao, titulo, motivo) }
    }

    #[test]
    fn remote_session_title_carries_the_machine_label() {
        let av = Aviso::do_item(&remote("s1", "motor-de-regras", "permission"));
        assert_eq!(av.titulo, "motor-de-regras · Workstation pede permissão");
        assert_eq!(titulo(&remote("s3", "fila-de-tarefas", "your-turn")), "fila-de-tarefas · Workstation: sua vez");
    }

    #[test]
    fn remote_session_has_no_desktop_action() {
        let av = Aviso::do_item(&remote("s1", "motor-de-regras", "permission"));
        assert_eq!(av.origin, Origin::RemoteSession);
        assert_eq!(av.origin.actions(), [Action::Open, Action::Silence], "Silenciar stays, Abrir no Claude Desktop goes");
        assert_eq!((av.path.as_str(), av.sessao.as_str(), av.local.as_deref()), ("/ui/sessions/s1", "s1", None), "the click opens the session screen");
        let mut a = Avisos::abrir(None);
        a.ler(&atencao(vec![]));
        a.silenciar("s1");
        assert!(a.ler(&atencao(vec![remote("s1", "motor-de-regras", "permission")])).is_empty(), "Silenciar works as for a local session");
    }

    #[test]
    fn local_session_notice_is_unchanged() {
        let mut i = item("s1", "motor-de-regras", "permission");
        i.local = Some("local_00000000-0000-4000-8000-000000000001".into());
        let av = Aviso::do_item(&i);
        assert_eq!(av.titulo, "motor-de-regras pede permissão");
        assert_eq!(av.origin, Origin::Session);
        assert_eq!(av.origin.actions(), [Action::Open, Action::OpenInDesktop, Action::Silence]);
        assert_eq!(Origin::Machine.actions(), [Action::Open]);
    }

    #[test]
    fn session_notices_open_the_session_screen() {
        let av = Aviso::do_item(&item("c3f09b52", "a", "permission"));
        assert_eq!((av.path.as_str(), av.origin), ("/ui/sessions/c3f09b52", Origin::Session));
    }

    #[test]
    fn arquivo_ruim_ou_ausente_e_padrao() {
        let p = Pasta::nova("ruim");
        assert_eq!(Silencio::carregar(&p.0.join(ARQUIVO)), Silencio::default());
        std::fs::create_dir_all(&p.0).unwrap();
        let ruim = p.0.join(ARQUIVO);
        std::fs::write(&ruim, "não é json").unwrap();
        assert_eq!(Silencio::carregar(&ruim), Silencio::default());
        std::fs::write(&ruim, r#"{ "sessoes": ["s9"] }"#).unwrap();
        assert_eq!(Silencio::carregar(&ruim), Silencio { ligadas: true, sessoes: ["s9".to_string()].into() });
    }
}
