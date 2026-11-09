# Liga a sincronização automática deste PC com o GitHub (Eliteagy/cinemex).
#   - Cada commit no branch main é enviado logo para o GitHub (hook post-commit).
#   - A cada 15 minutos o PC vai buscar o que os colaboradores enviaram (tarefa agendada, git pull --ff-only).
# Correr uma vez, na pasta do Cinemex:  powershell -ExecutionPolicy Bypass -File tools\sync\instalar-sync.ps1
# Desligar:  powershell -ExecutionPolicy Bypass -File tools\sync\instalar-sync.ps1 -Remover
param([switch]$Remover)
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$hook = Join-Path $repo '.git\hooks\post-commit'
$task = 'Cinemex - atualizar do GitHub'

if ($Remover) {
  Remove-Item $hook -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'Sincronização desligada.'
  return
}

$hookText = @'
#!/bin/sh
# Cinemex: cada commit no main vai logo para o GitHub (em segundo plano).
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || exit 0
( git pull --rebase --autostash --quiet origin main >/dev/null 2>&1; git push --quiet origin main >/dev/null 2>&1 ) &
exit 0
'@
[IO.File]::WriteAllText($hook, $hookText.Replace("`r`n", "`n"))

$git = (Get-Command git).Source
$action = New-ScheduledTaskAction -Execute $git -Argument "-C `"$repo`" pull --ff-only --quiet origin main"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Description 'git pull do Eliteagy/cinemex a cada 15 min' -Force | Out-Null
Write-Host "Sincronização ligada: push a cada commit, pull a cada 15 min ($repo)."
