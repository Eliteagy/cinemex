#!/bin/sh
# Liga o Elite Cinema ao Claude Code no Mac (MCP por HTTP em 127.0.0.1). Corre uma vez, com o
# Elite Cinema já aberto uma vez:  sh ligar-ao-claude.sh   (no Windows: ligar-ao-claude.ps1)
disc="$HOME/.elite-cinema/mcp.json"
[ -f "$disc" ] || { echo 'Abre o Elite Cinema uma vez primeiro.'; exit 1; }
field() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))[process.argv[2]]" "$disc" "$1"; }
url=$(field url)
token=$(tr -d '[:space:]' < "$(field tokenFile)")
[ -n "$url" ] && [ -n "$token" ] || { echo 'Não consegui ler o endereço ou o token.'; exit 1; }
claude mcp remove elite-cinema --scope user >/dev/null 2>&1
if claude mcp add --transport http --scope user elite-cinema "$url" --header "Authorization: Bearer $token" >/dev/null; then
  echo "Elite Cinema ligado ao Claude Code ($url). Abre uma sessão nova do Claude."
else
  echo 'Falhou o registo.'
  exit 1
fi
