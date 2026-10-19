// Adota o núcleo que já responde ou sobe um como processo filho.
//
// Um núcleo por máquina: o SQLite aceita um escritor só. Se a extensão .mcpb, o
// plugin ou um terminal já subiram o núcleo, o app só olha; nunca o encerra.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const ENDERECO: &str = "127.0.0.1:4720";

pub enum Nucleo {
    Adotado,
    Proprio(Child),
    Fora(String),
}

impl Nucleo {
    pub fn origem(&self) -> String {
        match self {
            Nucleo::Adotado => "adotado (já estava rodando)".into(),
            Nucleo::Proprio(c) => format!("subido pelo app (pid {})", c.id()),
            Nucleo::Fora(motivo) => format!("fora do ar ({motivo})"),
        }
    }

    pub fn encerrar(self) {
        if let Nucleo::Proprio(mut c) = self {
            // SIGTERM primeiro, para o núcleo fechar o banco; SIGKILL se não sair.
            let _ = Command::new("kill").arg(c.id().to_string()).status();
            let fim = Instant::now() + Duration::from_secs(3);
            while Instant::now() < fim {
                if let Ok(Some(_)) = c.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = c.kill();
        }
    }
}

pub fn adotar_ou_subir() -> Nucleo {
    if saudavel() {
        return Nucleo::Adotado;
    }
    let entrada = std::env::var("AHRENA_NUCLEO_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../nucleo-teste/server.mjs")));
    if !entrada.exists() {
        return Nucleo::Fora(format!("sem {}", entrada.display()));
    }
    let log = std::env::temp_dir().join("ahrena-console-nucleo.log");
    let saida = std::fs::File::create(&log).ok();
    let mut cmd = Command::new("node");
    cmd.arg(&entrada).stdin(Stdio::null());
    if let Some(f) = saida {
        cmd.stdout(f.try_clone().map(Stdio::from).unwrap_or(Stdio::null())).stderr(Stdio::from(f));
    }
    let filho = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Nucleo::Fora(format!("node: {e}")),
    };
    let prazo = Instant::now() + Duration::from_secs(15);
    while Instant::now() < prazo {
        if saudavel() {
            return Nucleo::Proprio(filho);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Nucleo::Proprio(filho)
}

fn saudavel() -> bool {
    get("/api/overview").map(|b| b.contains("\"sessions\"")).unwrap_or(false)
}

/// (ativas, ociosas) de /api/fleet.
pub fn frota() -> Option<(u64, u64)> {
    let corpo = get("/api/fleet")?;
    let v: serde_json::Value = serde_json::from_str(&corpo).ok()?;
    let t = v.get("totals")?;
    Some((t.get("active")?.as_u64()?, t.get("idle")?.as_u64()?))
}

// HTTP/1.0 cru, para não trazer um cliente HTTP inteiro para três rotas locais.
fn get(caminho: &str) -> Option<String> {
    let mut s = TcpStream::connect_timeout(&ENDERECO.parse().ok()?, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    write!(s, "GET {caminho} HTTP/1.0\r\nHost: {ENDERECO}\r\nUser-Agent: ahrena-console-desktop\r\n\r\n").ok()?;
    let mut resp = String::new();
    s.read_to_string(&mut resp).ok()?;
    let (cabecalho, corpo) = resp.split_once("\r\n\r\n")?;
    cabecalho.starts_with("HTTP/1.1 200").then(|| corpo.to_string()).or_else(|| {
        cabecalho.starts_with("HTTP/1.0 200").then(|| corpo.to_string())
    })
}
