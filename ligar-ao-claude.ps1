# Liga o Elite Cinema ao Claude Code (MCP por HTTP em 127.0.0.1). Corre uma vez, com o Elite Cinema já aberto uma vez.
$disc = Join-Path $env:USERPROFILE '.elite-cinema\mcp.json'
if (-not (Test-Path $disc)) { Write-Host 'Abre o Elite Cinema uma vez primeiro.'; exit 1 }
$info = Get-Content $disc -Raw | ConvertFrom-Json
$token = (Get-Content $info.tokenFile -Raw).Trim()
claude mcp remove elite-cinema --scope user 2>$null | Out-Null
claude mcp add --transport http --scope user elite-cinema $info.url --header "Authorization: Bearer $token" | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "Elite Cinema ligado ao Claude Code ($($info.url)). Abre uma sessão nova do Claude." } else { Write-Host 'Falhou o registo.' }
