#!/bin/sh
# Empacota o núcleo de teste como extensão do Claude Desktop (.mcpb).
# Uso: sh spikes/extensao-teste/empacotar.sh  →  gera spikes/extensao-teste/ahrena-console.mcpb
set -e
aqui=$(cd "$(dirname "$0")" && pwd)
nucleo="$aqui/../nucleo-teste"
pacote=$(mktemp -d)
(cd "$nucleo" && npm ci --silent)
mkdir -p "$pacote/server"
cp "$aqui/manifest.json" "$pacote/"
cp -R "$nucleo/server.mjs" "$nucleo/ui.html" "$nucleo/package.json" "$nucleo/node_modules" "$pacote/server/"
(cd "$pacote" && zip -qr "$aqui/ahrena-console.mcpb" .)
echo "gerado: $aqui/ahrena-console.mcpb"
