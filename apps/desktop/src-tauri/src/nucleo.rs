// Adota o núcleo de pé ou sobe um, pelo dono único da #86 (packages/nucleo/src/dono).
//
// Um núcleo por máquina: o SQLite aceita um escritor só. Com um Node 24 no PATH do login, o app
// roda `node <núcleo>/src/dono/cli.ts subir --pai <pid do app> --json`, que adota o núcleo de pé
// (e registra o app como cliente) ou sobe um em segundo plano. Sem Node, o app só procura um núcleo
// na porta padrão; se não há, mostra o A4.
//
// Ao sair, o app não sinaliza ninguém: o núcleo que ele subiu tem o app como `--pai` e sai sozinho
// quando o app some, a menos que outro cliente (a extensão, por exemplo) o tenha adotado. O que o
// app adotou nunca é encerrado por ele.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Deserialize;

use crate::http;
use crate::menu::EstadoDoNucleo;

pub const PORTA_PADRAO: u16 = 4720;
pub const SEM_NODE: &str = "Node não encontrado no PATH do login";

/// O que fazer, decidido antes de rodar qualquer coisa.
#[derive(Debug, PartialEq)]
pub enum Plano {
    /// Rodar o `subir` do dono com este `node`: ele adota ou sobe.
    Subir { node: PathBuf },
    /// Sem Node, mas há um núcleo respondendo: só olhar.
    Adotar { porta: u16 },
    Parado { motivo: String, sem_node: bool },
}

/// `node`: o Node 24+ achado no PATH (ou `Err` com a versão velha achada). `entrada`: se o
/// núcleo empacotado existe. `porta_viva`: a porta padrão respondeu como núcleo.
pub fn escolher(node: Result<PathBuf, Option<String>>, entrada: bool, porta_viva: bool) -> Plano {
    match node {
        Ok(node) if entrada => Plano::Subir { node },
        _ if porta_viva => Plano::Adotar { porta: PORTA_PADRAO },
        Ok(_) => Plano::Parado { motivo: "O núcleo não está dentro do app".into(), sem_node: false },
        Err(None) => Plano::Parado { motivo: SEM_NODE.into(), sem_node: true },
        Err(Some(v)) => Plano::Parado { motivo: format!("O núcleo pede o Node 24; o PATH do login tem o {v}"), sem_node: true },
    }
}

#[derive(Debug, Deserialize)]
struct SaidaDoSubir {
    estado: String,
    porta: Option<u16>,
    subiu: Option<bool>,
    motivo: Option<String>,
}

/// O núcleo em uso e se foi este app que o subiu.
#[derive(Debug, PartialEq)]
pub struct Resultado {
    pub estado: EstadoDoNucleo,
    pub subiu: bool,
}

/// Lê a linha JSON do `subir --json` (src/dono/subir.ts, `Saida`).
pub fn ler_subir(saida: &str) -> Resultado {
    let linha = saida.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    match serde_json::from_str::<SaidaDoSubir>(linha) {
        Ok(s) if s.estado == "de-pe" && s.porta.is_some() => Resultado { estado: EstadoDoNucleo::DePe { porta: s.porta.unwrap() }, subiu: s.subiu.unwrap_or(false) },
        Ok(s) => Resultado {
            estado: EstadoDoNucleo::Parado { motivo: s.motivo.map(|m| format!("O núcleo não subiu: {m}")).unwrap_or_else(|| "O núcleo não subiu".into()), sem_node: false },
            subiu: false,
        },
        Err(_) => Resultado { estado: EstadoDoNucleo::Parado { motivo: "O núcleo não respondeu ao subir".into(), sem_node: false }, subiu: false },
    }
}

/// `v24.1.0` serve; `v22.12.0` não (o núcleo pede `node:sqlite` e TypeScript sem flag).
pub fn versao_serve(v: &str) -> bool {
    v.trim().trim_start_matches('v').split('.').next().and_then(|m| m.parse::<u32>().ok()).is_some_and(|m| m >= 24)
}

/// O primeiro `node` do PATH (já corrigido pelo shell de login), se for Node 24+. `AHRENA_NODE`
/// troca o caminho; vazio, finge que não há Node (para ver o A4).
pub fn achar_node() -> Result<PathBuf, Option<String>> {
    let node = match std::env::var("AHRENA_NODE") {
        Ok(p) if p.is_empty() => return Err(None),
        Ok(p) => PathBuf::from(p),
        Err(_) => {
            let path = std::env::var("PATH").unwrap_or_default();
            path.split(':').map(|d| Path::new(d).join("node")).find(|p| p.is_file()).ok_or(None)?
        }
    };
    let saida = Command::new(&node).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|_| None)?;
    let versao = String::from_utf8_lossy(&saida.stdout).trim().to_string();
    if versao_serve(&versao) {
        Ok(node)
    } else {
        Err(Some(versao))
    }
}

/// `/api/overview` responde como o núcleo do Ahrena Console.
pub fn responde(porta: u16) -> bool {
    http::get(porta, "/api/overview", Duration::from_secs(3))
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .is_some_and(|v| eh_o_nucleo(&v))
}

/// O `name` (#173 fase 2b) ou, num núcleo mais antigo, o `nome` é `ahrena-console`.
fn eh_o_nucleo(v: &serde_json::Value) -> bool {
    let nome = v.get("name").or_else(|| v.get("nome")).and_then(|n| n.as_str());
    nome == Some("ahrena-console")
}

/// Onde está o núcleo: `AHRENA_NUCLEO_DIR`, senão os recursos do app (`packages/nucleo`), senão o
/// checkout (em desenvolvimento, `cargo run`).
pub fn pasta_do_nucleo(recursos: Option<PathBuf>) -> PathBuf {
    if let Ok(p) = std::env::var("AHRENA_NUCLEO_DIR") {
        return PathBuf::from(p);
    }
    if let Some(r) = recursos.map(|r| r.join("packages/nucleo")).filter(|p| p.join("src/dono/cli.ts").is_file()) {
        return r;
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/nucleo"))
}

/// A porta onde procurar um núcleo sem o dono: `AHRENA_NUCLEO_PORTA` (uma `--demo` do simulador),
/// senão a padrão.
pub fn porta_procurada() -> u16 {
    std::env::var("AHRENA_NUCLEO_PORTA").ok().and_then(|p| p.parse().ok()).unwrap_or(PORTA_PADRAO)
}

pub fn adotar_ou_subir(nucleo: &Path) -> Resultado {
    let cli = nucleo.join("src/dono/cli.ts");
    let porta = porta_procurada();
    let plano = escolher(achar_node(), cli.is_file(), responde(porta));
    match plano {
        Plano::Adotar { .. } => Resultado { estado: EstadoDoNucleo::DePe { porta }, subiu: false },
        Plano::Parado { motivo, sem_node } => Resultado { estado: EstadoDoNucleo::Parado { motivo, sem_node }, subiu: false },
        Plano::Subir { node } => {
            let saida = Command::new(node)
                .arg("--disable-warning=ExperimentalWarning")
                .arg(&cli)
                .args(["subir", "--pai", &std::process::id().to_string(), "--json"])
                .current_dir(nucleo)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output();
            match saida {
                Ok(s) => ler_subir(&String::from_utf8_lossy(&s.stdout)),
                Err(e) => Resultado { estado: EstadoDoNucleo::Parado { motivo: format!("node: {e}"), sem_node: false }, subiu: false },
            }
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    fn node() -> Result<PathBuf, Option<String>> {
        Ok(PathBuf::from("/opt/homebrew/bin/node"))
    }

    #[test]
    fn com_node_sobe_pelo_dono_mesmo_com_nucleo_de_pe() {
        // O `subir` adota o de pé e registra o app como cliente: o núcleo não some com a extensão.
        assert_eq!(escolher(node(), true, true), Plano::Subir { node: PathBuf::from("/opt/homebrew/bin/node") });
        assert_eq!(escolher(node(), true, false), Plano::Subir { node: PathBuf::from("/opt/homebrew/bin/node") });
    }

    #[test]
    fn sem_node_adota_o_de_pe() {
        assert_eq!(escolher(Err(None), true, true), Plano::Adotar { porta: 4720 });
        assert_eq!(escolher(Err(Some("v20.1.0".into())), true, true), Plano::Adotar { porta: 4720 });
    }

    #[test]
    fn sem_node_e_sem_nucleo_e_o_a4() {
        assert_eq!(escolher(Err(None), true, false), Plano::Parado { motivo: SEM_NODE.into(), sem_node: true });
        let Plano::Parado { motivo, sem_node } = escolher(Err(Some("v22.12.0".into())), true, false) else { panic!() };
        assert!(sem_node);
        assert!(motivo.contains("v22.12.0"), "{motivo}");
    }

    #[test]
    fn sem_o_nucleo_empacotado() {
        assert_eq!(escolher(node(), false, true), Plano::Adotar { porta: 4720 });
        assert!(matches!(escolher(node(), false, false), Plano::Parado { sem_node: false, .. }));
    }

    #[test]
    fn le_a_saida_do_subir() {
        let subiu = r#"{"estado":"de-pe","url":"http://127.0.0.1:4720","porta":4720,"pid":4242,"versao":"0.0.1","inicio":"x","pai":777,"subiu":true}"#;
        assert_eq!(ler_subir(subiu), Resultado { estado: EstadoDoNucleo::DePe { porta: 4720 }, subiu: true });
        let adotou = r#"{"estado":"de-pe","porta":4731,"subiu":false,"aviso":"versão mais velha"}"#;
        assert_eq!(ler_subir(&format!("[log] algo\n{adotou}\n")), Resultado { estado: EstadoDoNucleo::DePe { porta: 4731 }, subiu: false });
        let parado = r#"{"estado":"parado","motivo":"o núcleo saiu com código 1"}"#;
        let r = ler_subir(parado);
        assert!(!r.subiu);
        assert!(matches!(r.estado, EstadoDoNucleo::Parado { ref motivo, sem_node: false } if motivo.contains("código 1")));
        assert!(matches!(ler_subir("").estado, EstadoDoNucleo::Parado { .. }));
    }

    #[test]
    fn overview_pelo_name_ou_pelo_nome() {
        let v = |t: &str| serde_json::from_str::<serde_json::Value>(t).unwrap();
        assert!(eh_o_nucleo(&v(r#"{"ok":true,"name":"ahrena-console","version":"0.2.0","nome":"ahrena-console","versao":"0.2.0"}"#)));
        assert!(eh_o_nucleo(&v(r#"{"ok":true,"name":"ahrena-console"}"#)));
        assert!(eh_o_nucleo(&v(r#"{"ok":true,"nome":"ahrena-console","versao":"0.1.0"}"#)), "um núcleo de antes da #173");
        assert!(!eh_o_nucleo(&v(r#"{"name":"outro"}"#)));
        assert!(!eh_o_nucleo(&v(r#"{"ok":true}"#)));
    }

    #[test]
    fn versao_do_node() {
        assert!(versao_serve("v24.0.0"));
        assert!(versao_serve("v26.8.1\n"));
        assert!(!versao_serve("v22.18.0"));
        assert!(!versao_serve("lixo"));
    }
}
