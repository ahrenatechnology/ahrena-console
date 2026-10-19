#!/bin/sh
# Spike #106: duas pastas de configuração (CLAUDE_CONFIG_DIR) rodando ao mesmo tempo.
# Tudo numa pasta temporária, com HOME falso e uma API falsa em 127.0.0.1: não toca no
# login, no Keychain nem no ~/.claude de quem roda. Contas e orgs são UUIDs sintéticos.
set -eu
aqui=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
porta=${PORTA:-4799}
mkdir -p "$tmp/home" "$tmp/proj" "$tmp/a" "$tmp/b"
for c in a b; do
  cat > "$tmp/$c/settings.json" <<JSON
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"$aqui/hook.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"$aqui/hook.sh"}]}]}}
JSON
done
node "$aqui/api-falsa.mjs" "$porta" 2> "$tmp/api.log" &
api=$!
trap 'kill $api 2>/dev/null' EXIT
sleep 1

roda() { # pasta conta org
  (cd "$tmp/proj" && env -i HOME="$tmp/home" PATH="/usr/bin:/bin:$HOME/.local/bin:/opt/homebrew/bin" TERM=dumb \
    CLAUDE_CONFIG_DIR="$tmp/$1" ANTHROPIC_BASE_URL="http://127.0.0.1:$porta" ANTHROPIC_API_KEY=chave-falsa-da-prova \
    CLAUDE_CODE_ACCOUNT_UUID="$2" CLAUDE_CODE_ORGANIZATION_UUID="$3" DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 \
    claude -p "diga ok" --model claude-sonnet-5-5 < /dev/null)
}
roda a 00000000-0000-4000-8000-00000000000a 00000000-0000-4000-8000-0000000000a1 &
roda b 00000000-0000-4000-8000-00000000000b 00000000-0000-4000-8000-0000000000b1 &
wait %2 %3 2>/dev/null || wait

echo "== arquivos (HOME falso deve ficar vazio)"
(cd "$tmp" && find a b home -type f | grep -v -e '/backups/' -e '/cache/' | sort)
for c in a b; do
  echo "== hooks da pasta $c"
  for f in "$tmp/$c"/hook-*.txt; do
    sed -n 's/.*"hook_event_name":"\([^"]*\)".*/evento: \1/p' "$f"
    sed -n "s|.*\"transcript_path\":\"$tmp/\([^\"]*\)/projects/.*|transcript_path sob: \1/projects|p" "$f"
    grep -E '^CLAUDE_' "$f" | sed "s|$tmp/||"
  done
done
echo "pasta da prova: $tmp"
