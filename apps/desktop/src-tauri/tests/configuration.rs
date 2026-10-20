// A configuração que a release depende de estar certa (issue #90): a mesma versão nos três
// arquivos (a tag `app-v<versão>` é conferida contra o tauri.conf.json no CI), o updater
// apontando para as releases deste repositório e o identificador do app.

use std::path::Path;

use serde_json::Value;

const RELEASES: &str = "https://github.com/ahrenatechnology/ahrena-console/releases/";

fn ler(relativo: &str) -> String {
    let caminho = Path::new(env!("CARGO_MANIFEST_DIR")).join(relativo);
    std::fs::read_to_string(&caminho).unwrap_or_else(|e| panic!("ler {}: {e}", caminho.display()))
}

fn json(relativo: &str) -> Value {
    serde_json::from_str(&ler(relativo)).unwrap_or_else(|e| panic!("{relativo}: {e}"))
}

fn conf() -> Value {
    json("tauri.conf.json")
}

/// O `version` da seção `[package]` do Cargo.toml.
fn versao_do_cargo() -> String {
    let cargo = ler("Cargo.toml");
    let mut no_package = false;
    for linha in cargo.lines().map(str::trim) {
        if linha.starts_with('[') {
            no_package = linha == "[package]";
        } else if let Some(resto) = linha.strip_prefix("version").filter(|_| no_package) {
            if let Some(valor) = resto.trim_start().strip_prefix('=') {
                return valor.trim().trim_matches('"').to_string();
            }
        }
    }
    panic!("Cargo.toml sem version em [package]")
}

#[test]
fn a_versao_e_a_mesma_nos_tres_arquivos() {
    let conf = conf()["version"].as_str().expect("tauri.conf.json sem version").to_string();
    let npm = json("../package.json")["version"].as_str().expect("package.json sem version").to_string();
    assert_eq!(conf, versao_do_cargo(), "tauri.conf.json e Cargo.toml");
    assert_eq!(conf, npm, "tauri.conf.json e package.json");
}

#[test]
fn o_updater_busca_nas_releases_deste_repositorio() {
    let conf = conf();
    let endpoints = conf["plugins"]["updater"]["endpoints"].as_array().expect("plugins.updater.endpoints");
    assert!(!endpoints.is_empty());
    for e in endpoints {
        let e = e.as_str().expect("endpoint é texto");
        assert!(e.starts_with(RELEASES), "endpoint fora das releases do repositório: {e}");
    }
}

#[test]
fn a_chave_publica_e_texto_e_os_artefatos_do_updater_ficam_para_o_ci() {
    let conf = conf();
    // Vazia até o projeto ter a chave; o app só liga o updater com ela (updater.rs).
    assert!(conf["plugins"]["updater"]["pubkey"].is_string(), "plugins.updater.pubkey tem de ser texto");
    // Ligado aqui, toda build local pediria a chave privada; o CI liga com `--config`.
    let artefatos = &conf["bundle"]["createUpdaterArtifacts"];
    assert!(matches!(artefatos, Value::Null | Value::Bool(false)), "bundle.createUpdaterArtifacts ligado no conf: {artefatos}");
}

#[test]
fn o_identificador_do_app() {
    assert_eq!(conf()["identifier"], "dev.ahrena.console");
}
