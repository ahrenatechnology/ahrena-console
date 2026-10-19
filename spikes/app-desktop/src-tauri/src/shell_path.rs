// Um app aberto pelo Finder, pelo Dock ou no login herda do launchd um PATH mínimo
// (/usr/bin:/bin:/usr/sbin:/sbin) e não acha `claude` (em ~/.local/bin) nem `node`
// (em /opt/homebrew/bin ou num gerenciador de versões). Como o app do CCAM
// (desktop/src/shell-path.ts), roda o shell de login uma vez e junta o PATH dele.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARCA: &str = "__AHRENA_PATH__";

pub fn corrigir_path() {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut partes: Vec<String> = Vec::new();
    let mut juntar = |valor: &str| {
        for p in valor.split(':') {
            if !p.is_empty() && !partes.iter().any(|x| x == p) {
                partes.push(p.to_string());
            }
        }
    };
    if let Some(p) = path_do_shell() {
        juntar(&p);
    }
    juntar(&format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin"));
    juntar(&std::env::var("PATH").unwrap_or_default());
    std::env::set_var("PATH", partes.join(":"));
}

fn path_do_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut filho = Command::new(shell)
        .args(["-ilc", &format!("printf '%s' \"{MARCA}$PATH{MARCA}\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Um .zshrc lento não pode travar a abertura do app.
    let prazo = Instant::now() + Duration::from_secs(5);
    loop {
        match filho.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < prazo => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = filho.kill();
                return None;
            }
        }
    }
    let mut saida = String::new();
    std::io::Read::read_to_string(&mut filho.stdout.take()?, &mut saida).ok()?;
    let ini = saida.find(MARCA)? + MARCA.len();
    let fim = ini + saida[ini..].find(MARCA)?;
    Some(saida[ini..fim].to_string())
}
