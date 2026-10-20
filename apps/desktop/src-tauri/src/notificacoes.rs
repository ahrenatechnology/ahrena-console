// As notificações do sistema (wireframe A3, issue #88) como dados: quando avisar, o quê e quem cala.
//
// Fica separado do Tauri para ser testado sem abrir o app. A bandeja relê `/api/atencao` a cada
// mudança e a cada 25 s; avisar a cada leitura seria barulho. O `Detector` guarda o motivo de cada
// sessão na leitura anterior e só avisa quem entrou na lista ou trocou de motivo. A primeira
// leitura (ao abrir, ou depois de perder o núcleo) só grava: quem já esperava não vira aviso.
//
// O silêncio é do app, não do núcleo: um JSON pequeno no diretório de dados do app, com a chave
// geral do menu ("Notificações") e as sessões caladas pela ação "Silenciar" da notificação.

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::http;
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
}

impl Aviso {
    pub fn do_item(i: &ItemDaAtencao) -> Aviso {
        Aviso { titulo: titulo(i), corpo: i.motivo_longo.clone(), som: com_som(&i.motivo), sessao: i.sessao.clone(), local: i.local.clone() }
    }
}

/// O título do A3: a sessão e o motivo ("motor-de-regras pede permissão").
pub fn titulo(i: &ItemDaAtencao) -> String {
    let t = &i.titulo;
    match i.motivo.as_str() {
        "permissao" => format!("{t} pede permissão"),
        "pergunta" => format!("{t} fez uma pergunta"),
        "plano" => format!("{t} tem um plano para aprovar"),
        "decisao" => format!("{t} pede uma decisão"),
        "erro" => format!("{t} parou com erro"),
        "sua-vez" => format!("{t}: sua vez"),
        "interrompida" => format!("{t} foi interrompida"),
        "no-prompt" => format!("{t}: sessão nova"),
        _ => format!("{t}: {}", i.motivo_curto),
    }
}

fn com_som(motivo: &str) -> bool {
    matches!(motivo, "permissao" | "interrompida" | "erro")
}

/// Quem entrou na lista ou trocou de motivo desde a leitura anterior.
#[derive(Debug, Default)]
pub struct Detector {
    /// `sessão` → `motivo` da leitura anterior; `None` antes da primeira (ou depois de `zerar`).
    anterior: Option<HashMap<String, String>>,
}

impl Detector {
    pub fn observar(&mut self, a: &Atencao) -> Vec<Aviso> {
        let agora: HashMap<String, String> = a.itens.iter().map(|i| (i.sessao.clone(), i.motivo.clone())).collect();
        let avisos = match &self.anterior {
            None => Vec::new(),
            Some(antes) => a.itens.iter().filter(|i| antes.get(&i.sessao) != Some(&i.motivo)).map(Aviso::do_item).collect(),
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
        std::fs::write(&tmp, texto)?;
        std::fs::rename(&tmp, caminho)
    }
}

/// O detector, o silêncio e onde ele é gravado: o que o app guarda das notificações.
#[derive(Debug, Default)]
pub struct Avisos {
    pub detector: Detector,
    pub silencio: Silencio,
    /// `None` quando o app não tem diretório de dados: o silêncio vale só até sair.
    pub arquivo: Option<PathBuf>,
}

impl Avisos {
    pub fn abrir(arquivo: Option<PathBuf>) -> Avisos {
        let silencio = arquivo.as_deref().map(Silencio::carregar).unwrap_or_default();
        Avisos { detector: Detector::default(), silencio, arquivo }
    }

    /// Os avisos desta leitura que passam pelo silêncio.
    pub fn ler(&mut self, a: &Atencao) -> Vec<Aviso> {
        let novos = self.detector.observar(a);
        self.silencio.filtrar(novos)
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

/// A tela de detalhe da sessão na `/ui` do núcleo, aonde "Abrir" leva.
pub fn caminho_da_sessao(sessao: &str) -> String {
    format!("/ui/sessoes/{}", http::codificar(sessao))
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
            sessao: sessao.into(),
            titulo: titulo.into(),
            conta: None,
            nivel: if motivo == "sua-vez" { "sua-vez" } else { "precisa" }.into(),
            motivo: motivo.into(),
            motivo_curto: format!("curto de {motivo}"),
            motivo_longo: format!("longo de {motivo}"),
            minutos: 1,
            local: None,
        }
    }

    fn atencao(itens: Vec<ItemDaAtencao>) -> Atencao {
        Atencao { cursor: None, total: itens.len() as u64, ativas: 0, com_erro: 0, itens }
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
        assert!(d.observar(&atencao(vec![item("s1", "a", "permissao"), item("s2", "b", "erro")])).is_empty());
    }

    #[test]
    fn entrada_avisa_uma_vez() {
        let mut d = Detector::default();
        d.observar(&atencao(vec![]));
        let lista = atencao(vec![item("s1", "a", "permissao")]);
        assert_eq!(sessoes(&d.observar(&lista)), ["s1"]);
        assert!(d.observar(&lista).is_empty(), "a leitura repetida não avisa");
        assert!(d.observar(&lista).is_empty());
    }

    #[test]
    fn troca_de_motivo_avisa() {
        let mut d = Detector::default();
        d.observar(&atencao(vec![item("s1", "a", "sua-vez"), item("s2", "b", "pergunta")]));
        let avisos = d.observar(&atencao(vec![item("s1", "a", "permissao"), item("s2", "b", "pergunta")]));
        assert_eq!(sessoes(&avisos), ["s1"]);
        assert_eq!(avisos[0].titulo, "a pede permissão");
    }

    #[test]
    fn saiu_e_voltou_avisa() {
        let mut d = Detector::default();
        d.observar(&atencao(vec![item("s1", "a", "permissao")]));
        assert!(d.observar(&atencao(vec![])).is_empty());
        assert_eq!(sessoes(&d.observar(&atencao(vec![item("s1", "a", "permissao")]))), ["s1"]);
    }

    #[test]
    fn reconexao_nao_avisa() {
        let mut d = Detector::default();
        d.observar(&atencao(vec![]));
        d.zerar();
        assert!(d.observar(&atencao(vec![item("s1", "a", "erro")])).is_empty());
        assert_eq!(sessoes(&d.observar(&atencao(vec![item("s1", "a", "erro"), item("s2", "b", "erro")]))), ["s2"]);
    }

    #[test]
    fn som_so_nos_urgentes() {
        let com: Vec<_> = ["permissao", "pergunta", "plano", "decisao", "erro", "sua-vez", "interrompida", "no-prompt", "outro"]
            .into_iter()
            .filter(|m| Aviso::do_item(&item("s", "t", m)).som)
            .collect();
        assert_eq!(com, ["permissao", "erro", "interrompida"]);
    }

    #[test]
    fn titulos_do_a3() {
        let a = |t: &str, m: &str| titulo(&item("s", t, m));
        assert_eq!(a("motor-de-regras", "permissao"), "motor-de-regras pede permissão");
        assert_eq!(a("painel-de-metricas", "erro"), "painel-de-metricas parou com erro");
        assert_eq!(a("fila-de-tarefas", "sua-vez"), "fila-de-tarefas: sua vez");
        assert_eq!(a("x", "interrompida"), "x foi interrompida");
        assert_eq!(a("x", "motivo-novo"), "x: curto de motivo-novo");
    }

    #[test]
    fn corpo_e_local() {
        let mut i = item("s1", "a", "permissao");
        i.local = Some("local_1".into());
        let av = Aviso::do_item(&i);
        assert_eq!((av.corpo.as_str(), av.local.as_deref()), ("longo de permissao", Some("local_1")));
    }

    #[test]
    fn caminho_da_tela_da_sessao() {
        assert_eq!(caminho_da_sessao("c3f09b52"), "/ui/sessoes/c3f09b52");
        assert_eq!(caminho_da_sessao("a:b/c"), "/ui/sessoes/a%3Ab%2Fc");
    }

    #[test]
    fn silencio_global() {
        let avisos = vec![Aviso::do_item(&item("s1", "a", "erro"))];
        let s = Silencio { ligadas: false, ..Silencio::default() };
        assert!(s.filtrar(avisos.clone()).is_empty());
        assert_eq!(Silencio::default().filtrar(avisos.clone()), avisos);
    }

    #[test]
    fn silencio_por_sessao() {
        let avisos = vec![Aviso::do_item(&item("s1", "a", "erro")), Aviso::do_item(&item("s2", "b", "erro"))];
        let mut s = Silencio::default();
        s.sessoes.insert("s1".into());
        assert_eq!(sessoes(&s.filtrar(avisos)), ["s2"]);
    }

    #[test]
    fn avisos_le_e_filtra() {
        let mut a = Avisos::abrir(None);
        a.ler(&atencao(vec![]));
        a.silenciar("s1");
        assert_eq!(sessoes(&a.ler(&atencao(vec![item("s1", "a", "erro"), item("s2", "b", "erro")]))), ["s2"]);
        assert!(!a.alternar());
        assert!(a.ler(&atencao(vec![item("s3", "c", "erro")])).is_empty());
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
