// O que já está instalado do lado do Claude. Só leitura: o app não instala hooks,
// não edita ~/.claude/settings.json e não mexe no Claude Desktop.

use std::process::Command;

pub struct Integracao {
    pub cli: String,
    pub plugin: String,
    pub extensao: String,
}

pub fn levantar() -> Integracao {
    let home = std::env::var("HOME").unwrap_or_default();

    let cli = Command::new("claude")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| format!("CLI claude {}", String::from_utf8_lossy(&o.stdout).split_whitespace().next().unwrap_or("?")))
        .unwrap_or_else(|| "CLI claude não encontrado no PATH".into());

    // Plugins habilitados no escopo do usuário (onde ficam o painel e os hooks).
    let plugin = std::fs::read_to_string(format!("{home}/.claude/settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("enabledPlugins").and_then(|p| p.as_object()).cloned())
        .map(|p| {
            let nossos: Vec<_> = p.keys().filter(|k| k.contains("ahrena-console")).cloned().collect();
            if nossos.is_empty() { "Plugin do console: não instalado".into() } else { format!("Plugin: {}", nossos.join(", ")) }
        })
        .unwrap_or_else(|| "Plugin do console: sem settings.json".into());

    // Extensão .mcpb instalada no Claude Desktop (é ela que dá o host: aos artefatos).
    let extensoes = format!("{home}/Library/Application Support/Claude/Claude Extensions");
    let extensao = std::fs::read_dir(&extensoes)
        .ok()
        .and_then(|d| d.flatten().find(|e| e.file_name().to_string_lossy().ends_with("ahrena-console")))
        .map(|e| format!("Extensão .mcpb: {}", e.file_name().to_string_lossy()))
        .unwrap_or_else(|| "Extensão .mcpb: não instalada".into());

    Integracao { cli, plugin, extensao }
}
