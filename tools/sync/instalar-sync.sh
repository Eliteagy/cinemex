#!/bin/sh
# Liga a sincronização automática deste Mac com o GitHub (versão Mac do instalar-sync.ps1).
#   - Cada commit no branch main é enviado logo para o GitHub (hook post-commit).
#   - A cada 15 minutos o Mac vai buscar o que os colaboradores enviaram (LaunchAgent, git pull --ff-only).
# Correr uma vez, na pasta do Cinemex:  sh tools/sync/instalar-sync.sh
# Só receber (sem o envio a cada commit):  sh tools/sync/instalar-sync.sh --so-pull
# Desligar:  sh tools/sync/instalar-sync.sh --remover
# O que o pull faz fica em ~/Library/Logs/cinemex-sync.log.
repo=$(cd "$(dirname "$0")/../.." && pwd)
hook="$repo/.git/hooks/post-commit"
label='com.eliteagency.cinemex.sync'
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/cinemex-sync.log"
domain="gui/$(id -u)"

launchctl bootout "$domain/$label" >/dev/null 2>&1

if [ "$1" = '--remover' ]; then
  rm -f "$plist"
  # Só apaga o hook que este instalador pôs.
  grep -q 'Cinemex: cada commit no main' "$hook" 2>/dev/null && rm -f "$hook"
  echo 'Sincronização desligada.'
  exit 0
fi

if [ "$1" = '--so-pull' ]; then
  grep -q 'Cinemex: cada commit no main' "$hook" 2>/dev/null && rm -f "$hook"
else
  cat > "$hook" <<'EOF'
#!/bin/sh
# Cinemex: cada commit no main vai logo para o GitHub (em segundo plano).
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || exit 0
( git pull --rebase --autostash --quiet origin main >/dev/null 2>&1; git push --quiet origin main >/dev/null 2>&1 ) &
exit 0
EOF
  chmod +x "$hook"
fi

git=$(command -v git) || { echo 'Não encontrei o git.'; exit 1; }
mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$git</string><string>-C</string><string>$repo</string>
    <string>pull</string><string>--ff-only</string><string>--quiet</string><string>origin</string><string>main</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
launchctl bootstrap "$domain" "$plist" || { echo 'Não consegui ligar o LaunchAgent.'; exit 1; }

if [ "$1" = '--so-pull' ]; then
  echo "Sincronização ligada: pull a cada 15 min ($repo)."
else
  echo "Sincronização ligada: push a cada commit, pull a cada 15 min ($repo)."
fi
