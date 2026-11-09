# Liga o Cinemex ao Claude Code (MCP por HTTP em 127.0.0.1). Corre uma vez, com o Cinemex já aberto uma vez.
$disc = Join-Path $env:USERPROFILE '.cinemex\mcp.json'
if (-not (Test-Path $disc)) { Write-Host 'Abre o Cinemex uma vez primeiro.'; exit 1 }
$info = Get-Content $disc -Raw | ConvertFrom-Json
$token = (Get-Content $info.tokenFile -Raw).Trim()
claude mcp remove elite-cinema --scope user 2>$null | Out-Null  # nome antigo (antes de 09/11/2026)
claude mcp remove cinemex --scope user 2>$null | Out-Null
claude mcp add --transport http --scope user cinemex $info.url --header "Authorization: Bearer $token" | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "Cinemex ligado ao Claude Code ($($info.url)). Abre uma sessão nova do Claude." } else { Write-Host 'Falhou o registo.' }
