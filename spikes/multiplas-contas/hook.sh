#!/bin/sh
# Grava o que o hook recebe: as chaves do stdin e as variáveis de conta do ambiente.
out="$CLAUDE_CONFIG_DIR/hook-$(date +%s%N).txt"
{ echo "stdin:"; cat; echo; echo "env:"; env | grep -E '^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_ACCOUNT_UUID|CLAUDE_CODE_ORGANIZATION_UUID|CLAUDE_CODE_USER_EMAIL)='; } > "$out"
