// O menu da bandeja como dados, montado do JSON de `GET /api/atencao` e do estado do núcleo.
//
// Fica separado do Tauri para ser testado sem abrir o app: `montar` devolve a lista de itens na
// ordem dos wireframes A1 (0 esperando), A2 (3 esperando) e A4 (núcleo parado), e `main.rs` só a
// traduz para o menu nativo.

use serde::Deserialize;

/// Um item de `GET /api/atencao` (packages/nucleo/src/api/rota-atencao.ts).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ItemDaAtencao {
    pub sessao: String,
    pub titulo: String,
    pub conta: Option<Conta>,
    /// `precisa` (trava a sessão) ou `sua-vez`.
    pub nivel: String,
    pub motivo: String,
    #[serde(rename = "motivoCurto")]
    pub motivo_curto: String,
    #[serde(rename = "motivoLongo")]
    pub motivo_longo: String,
    pub minutos: u64,
    pub local: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Conta {
    pub rotulo: String,
    pub cor: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Atencao {
    pub cursor: Option<String>,
    pub total: u64,
    pub ativas: u64,
    #[serde(rename = "comErro")]
    pub com_erro: u64,
    pub itens: Vec<ItemDaAtencao>,
}

impl Atencao {
    pub fn do_json(texto: &str) -> Option<Atencao> {
        serde_json::from_str(texto).ok()
    }
}

/// O núcleo como a bandeja o vê.
#[derive(Debug, Clone, PartialEq)]
pub enum EstadoDoNucleo {
    /// Ao abrir e no "Procurar o núcleo de novo", até adotar ou subir.
    Procurando,
    DePe { porta: u16 },
    /// `sem_node`: ninguém subiu o núcleo e não há Node no PATH do login (A4).
    Parado { motivo: String, sem_node: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ponto {
    Verde,
    Vermelho,
    Amarelo,
    Laranja,
    Vazio,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    /// Linha cinza, sem ação.
    Texto { texto: String, ponto: Option<Ponto> },
    /// Texto cinza recuado, embaixo de um item com ponto.
    Detalhe(String),
    /// Cabeçalho de seção; com ⌥, vira `alternativo`.
    Cabecalho { texto: String, alternativo: String },
    /// Uma sessão. O clique abre no Claude Desktop pelo `local`; com ⌥, o item `alternativo`.
    Sessao { id: String, texto: String, alternativo: String, ponto: Ponto, dica: String, local: Option<String> },
    Acao { id: &'static str, texto: String, atalho: Option<&'static str> },
    Marcavel { id: &'static str, texto: &'static str, marcado: bool },
    Separador,
}

pub struct Entrada<'a> {
    pub nucleo: &'a EstadoDoNucleo,
    pub atencao: Option<&'a Atencao>,
    /// O núcleo de pé não tem `/api/atencao` (um de antes da #87).
    pub sem_atencao: bool,
    pub notificacoes: bool,
    pub login: bool,
    pub versao: &'a str,
    /// A versão nova que o updater achou e ainda não foi instalada.
    pub atualizacao: Option<&'a str>,
}

pub const ID_ABRIR: &str = "abrir";
pub const ID_NOTIFICACOES: &str = "notificacoes";
pub const ID_LOGIN: &str = "login";
pub const ID_SAIR: &str = "sair";
pub const ID_INSTALAR_NODE: &str = "instalar-node";
pub const ID_PROCURAR: &str = "procurar";
pub const ID_ATUALIZAR: &str = "atualizar";
/// Prefixos dos ids das sessões: o principal e o alternativo (⌥).
pub const SESSAO: &str = "sessao:";
pub const SESSAO_NO_DESKTOP: &str = "desktop:";

/// O número ao lado do ícone: esperando e com erro. Zero ou núcleo parado: só o ícone.
pub fn titulo_da_bandeja(nucleo: &EstadoDoNucleo, atencao: Option<&Atencao>) -> Option<String> {
    match (nucleo, atencao) {
        (EstadoDoNucleo::DePe { .. }, Some(a)) if a.total > 0 => Some(a.total.to_string()),
        _ => None,
    }
}

pub fn tempo(minutos: u64) -> String {
    match minutos {
        0 => "agora".into(),
        m if m < 60 => format!("{m} min"),
        m if m < 60 * 24 => format!("{} h", m / 60),
        m => format!("{} d", m / (60 * 24)),
    }
}

fn ponto_da_sessao(i: &ItemDaAtencao) -> Ponto {
    if i.motivo == "erro" {
        Ponto::Vermelho
    } else {
        Ponto::Amarelo
    }
}

pub fn montar(e: &Entrada) -> Vec<Item> {
    let mut m = vec![Item::Texto { texto: "Ahrena Console".into(), ponto: None }];
    match e.nucleo {
        EstadoDoNucleo::DePe { porta } => {
            m.push(Item::Texto { texto: format!("Núcleo de pé · 127.0.0.1:{porta}"), ponto: Some(Ponto::Verde) });
            m.push(Item::Separador);
            if e.sem_atencao && e.atencao.is_none() {
                m.push(Item::Detalhe("Este núcleo não lista quem precisa de você: atualize-o".into()));
            } else {
                sessoes(&mut m, e.atencao);
            }
        }
        EstadoDoNucleo::Procurando => {
            m.push(Item::Texto { texto: "Procurando o núcleo…".into(), ponto: None });
        }
        EstadoDoNucleo::Parado { motivo, sem_node } => {
            m.push(Item::Texto { texto: "Núcleo parado".into(), ponto: Some(Ponto::Vermelho) });
            m.push(Item::Detalhe(motivo.clone()));
            m.push(Item::Separador);
            if *sem_node {
                m.push(Item::Acao { id: ID_INSTALAR_NODE, texto: "Como instalar o Node 24".into(), atalho: None });
            }
            m.push(Item::Acao { id: ID_PROCURAR, texto: "Procurar o núcleo de novo".into(), atalho: None });
        }
    }
    m.push(Item::Separador);
    m.push(Item::Acao { id: ID_ABRIR, texto: "Abrir o console".into(), atalho: Some("CmdOrCtrl+O") });
    m.push(Item::Marcavel { id: ID_NOTIFICACOES, texto: "Notificações", marcado: e.notificacoes });
    m.push(Item::Marcavel { id: ID_LOGIN, texto: "Abrir no login", marcado: e.login });
    m.push(Item::Separador);
    m.push(Item::Texto { texto: format!("Ahrena Console {}", e.versao), ponto: None });
    if let Some(nova) = e.atualizacao {
        m.push(Item::Acao { id: ID_ATUALIZAR, texto: format!("Atualizar para a versão {nova}"), atalho: None });
    }
    m.push(Item::Acao { id: ID_SAIR, texto: "Sair do Ahrena Console".into(), atalho: Some("CmdOrCtrl+Q") });
    m
}

fn sessoes(m: &mut Vec<Item>, atencao: Option<&Atencao>) {
    let Some(a) = atencao else {
        m.push(Item::Texto { texto: "Lendo as sessões…".into(), ponto: None });
        return;
    };
    if a.itens.is_empty() {
        m.push(Item::Texto { texto: "Ninguém precisa de você".into(), ponto: Some(Ponto::Vazio) });
        let erro = if a.com_erro == 0 { " · nenhuma com erro".to_string() } else { String::new() };
        m.push(Item::Texto { texto: format!("{}{erro}", ativas(a.ativas)), ponto: Some(Ponto::Laranja) });
        return;
    }
    let n = a.itens.len();
    let quem = if n == 1 { "1 precisa de você".to_string() } else { format!("{n} precisam de você") };
    m.push(Item::Cabecalho { texto: format!("{quem} · abrir na janela"), alternativo: format!("{quem} · abrir no Claude Desktop") });
    for i in &a.itens {
        let conta = i.conta.as_ref().map(|c| c.rotulo.as_str()).unwrap_or("Sem conta");
        m.push(Item::Sessao {
            id: i.sessao.clone(),
            texto: format!("{} · {} · {}", i.titulo, i.motivo_curto, tempo(i.minutos)),
            alternativo: format!("{} · Abrir no Claude Desktop", i.titulo),
            ponto: ponto_da_sessao(i),
            dica: format!("{conta} · {}", i.motivo_longo),
            local: i.local.clone(),
        });
    }
    m.push(Item::Separador);
    m.push(Item::Texto { texto: ativas(a.ativas), ponto: Some(Ponto::Laranja) });
}

fn ativas(n: u64) -> String {
    if n == 1 {
        "1 ativa".into()
    } else {
        format!("{n} ativas")
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    // O JSON de `/api/atencao`, no formato da rota (campos a mais são ignorados).
    const TRES: &str = r##"{
      "geradoEm": "2026-10-18T23:10:00.000Z", "cursor": "c42", "total": 3, "precisam": 2, "suaVez": 1,
      "ativas": 4, "comErro": 1,
      "itens": [
        { "sessao": "s1", "titulo": "motor-de-regras", "projeto": null, "conta": { "rotulo": "equipe", "cor": "#f47c20" },
          "nivel": "precisa", "motivo": "permissao", "motivoCurto": "Pede permissão", "motivoLongo": "pede permissão para usar Bash",
          "desde": "2026-10-18T23:08:00.000Z", "minutos": 2, "local": "local_00000000-0000-4000-8000-000000000001" },
        { "sessao": "s2", "titulo": "painel-de-metricas", "projeto": null, "conta": null,
          "nivel": "precisa", "motivo": "erro", "motivoCurto": "Com erro", "motivoLongo": "parou num erro",
          "desde": "2026-10-18T23:07:00.000Z", "minutos": 3, "local": null },
        { "sessao": "s3", "titulo": "fila-de-tarefas", "projeto": null, "conta": { "rotulo": "cliente", "cor": "#3b82f6" },
          "nivel": "sua-vez", "motivo": "sua-vez", "motivoCurto": "Sua vez", "motivoLongo": "terminou o turno, sua vez",
          "desde": "2026-10-18T23:09:00.000Z", "minutos": 1, "local": null }
      ]
    }"##;

    const ZERO: &str = r#"{ "cursor": "c1", "total": 0, "precisam": 0, "suaVez": 0, "ativas": 4, "comErro": 0, "itens": [] }"#;

    fn entrada<'a>(nucleo: &'a EstadoDoNucleo, atencao: Option<&'a Atencao>) -> Entrada<'a> {
        Entrada { nucleo, atencao, sem_atencao: false, notificacoes: true, login: false, versao: "0.0.1", atualizacao: None }
    }

    fn textos(m: &[Item]) -> Vec<String> {
        m.iter()
            .map(|i| match i {
                Item::Texto { texto, .. } | Item::Cabecalho { texto, .. } | Item::Sessao { texto, .. } | Item::Acao { texto, .. } => texto.clone(),
                Item::Detalhe(t) => format!("  {t}"),
                Item::Marcavel { texto, marcado, .. } => format!("{}{texto}", if *marcado { "✓ " } else { "" }),
                Item::Separador => "—".into(),
            })
            .collect()
    }

    #[test]
    fn a2_tres_esperando() {
        let a = Atencao::do_json(TRES).unwrap();
        let n = EstadoDoNucleo::DePe { porta: 4720 };
        let m = montar(&entrada(&n, Some(&a)));
        assert_eq!(
            textos(&m),
            [
                "Ahrena Console",
                "Núcleo de pé · 127.0.0.1:4720",
                "—",
                "3 precisam de você · abrir na janela",
                "motor-de-regras · Pede permissão · 2 min",
                "painel-de-metricas · Com erro · 3 min",
                "fila-de-tarefas · Sua vez · 1 min",
                "—",
                "4 ativas",
                "—",
                "Abrir o console",
                "✓ Notificações",
                "Abrir no login",
                "—",
                "Ahrena Console 0.0.1",
                "Sair do Ahrena Console",
            ]
        );
        assert_eq!(titulo_da_bandeja(&n, Some(&a)).as_deref(), Some("3"));
    }

    #[test]
    fn a2_alternativos_pontos_e_conta() {
        let a = Atencao::do_json(TRES).unwrap();
        let n = EstadoDoNucleo::DePe { porta: 4720 };
        let m = montar(&entrada(&n, Some(&a)));
        let Item::Cabecalho { alternativo, .. } = &m[3] else { panic!("cabeçalho") };
        assert_eq!(alternativo, "3 precisam de você · abrir no Claude Desktop");
        let sessoes: Vec<_> = m
            .iter()
            .filter_map(|i| match i {
                Item::Sessao { alternativo, ponto, dica, local, .. } => Some((alternativo.as_str(), *ponto, dica.as_str(), local.is_some())),
                _ => None,
            })
            .collect();
        assert_eq!(
            sessoes,
            [
                ("motor-de-regras · Abrir no Claude Desktop", Ponto::Amarelo, "equipe · pede permissão para usar Bash", true),
                ("painel-de-metricas · Abrir no Claude Desktop", Ponto::Vermelho, "Sem conta · parou num erro", false),
                ("fila-de-tarefas · Abrir no Claude Desktop", Ponto::Amarelo, "cliente · terminou o turno, sua vez", false),
            ]
        );
    }

    #[test]
    fn a1_ninguem_esperando() {
        let a = Atencao::do_json(ZERO).unwrap();
        let n = EstadoDoNucleo::DePe { porta: 4720 };
        let m = montar(&entrada(&n, Some(&a)));
        assert_eq!(&textos(&m)[..6], ["Ahrena Console", "Núcleo de pé · 127.0.0.1:4720", "—", "Ninguém precisa de você", "4 ativas · nenhuma com erro", "—"]);
        assert!(matches!(m[3], Item::Texto { ponto: Some(Ponto::Vazio), .. }));
        assert_eq!(titulo_da_bandeja(&n, Some(&a)), None);
    }

    #[test]
    fn a4_nucleo_parado_sem_node() {
        let n = EstadoDoNucleo::Parado { motivo: "Node não encontrado no PATH do login".into(), sem_node: true };
        let m = montar(&entrada(&n, None));
        assert_eq!(
            &textos(&m)[..7],
            ["Ahrena Console", "Núcleo parado", "  Node não encontrado no PATH do login", "—", "Como instalar o Node 24", "Procurar o núcleo de novo", "—"]
        );
        assert_eq!(titulo_da_bandeja(&n, None), None);
    }

    #[test]
    fn parado_com_node_nao_oferece_instalar() {
        let n = EstadoDoNucleo::Parado { motivo: "O núcleo não respondeu".into(), sem_node: false };
        let m = montar(&entrada(&n, None));
        assert!(!textos(&m).iter().any(|t| t.contains("instalar")));
        assert!(textos(&m).iter().any(|t| t == "Procurar o núcleo de novo"));
    }

    #[test]
    fn singular_e_tempo() {
        let mut a = Atencao::do_json(TRES).unwrap();
        a.itens.truncate(1);
        a.total = 1;
        a.ativas = 1;
        let n = EstadoDoNucleo::DePe { porta: 4720 };
        let t = textos(&montar(&entrada(&n, Some(&a))));
        assert!(t.contains(&"1 precisa de você · abrir na janela".to_string()));
        assert!(t.contains(&"1 ativa".to_string()));
        assert_eq!([tempo(0), tempo(59), tempo(60), tempo(150), tempo(60 * 24 * 2)], ["agora", "59 min", "1 h", "2 h", "2 d"]);
    }

    #[test]
    fn nucleo_sem_a_rota() {
        let n = EstadoDoNucleo::DePe { porta: 4720 };
        let m = montar(&Entrada { sem_atencao: true, ..entrada(&n, None) });
        assert_eq!(&textos(&m)[..5], ["Ahrena Console", "Núcleo de pé · 127.0.0.1:4720", "—", "  Este núcleo não lista quem precisa de você: atualize-o", "—"]);
    }

    #[test]
    fn procurando() {
        let n = EstadoDoNucleo::Procurando;
        let m = montar(&entrada(&n, None));
        assert_eq!(&textos(&m)[..4], ["Ahrena Console", "Procurando o núcleo…", "—", "Abrir o console"]);
    }

    #[test]
    fn atualizacao_logo_abaixo_da_versao() {
        let n = EstadoDoNucleo::DePe { porta: 4720 };
        let sem = textos(&montar(&entrada(&n, None)));
        assert!(!sem.iter().any(|t| t.starts_with("Atualizar")));
        let m = montar(&Entrada { atualizacao: Some("0.0.2"), ..entrada(&n, None) });
        let t = textos(&m);
        assert_eq!(&t[t.len() - 4..], ["—", "Ahrena Console 0.0.1", "Atualizar para a versão 0.0.2", "Sair do Ahrena Console"]);
        assert!(m.iter().any(|i| matches!(i, Item::Acao { id: ID_ATUALIZAR, .. })));
    }

    #[test]
    fn json_invalido_nao_monta() {
        assert!(Atencao::do_json("{}").is_none());
        assert!(Atencao::do_json("não é json").is_none());
    }
}
