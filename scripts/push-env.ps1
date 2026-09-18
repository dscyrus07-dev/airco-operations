# Pushes every variable from local .env to the linked Railway service.
# Skips PORT (Railway injects its own) and empty values.
$vars = @{}
Get-Content ".env" | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)\s*$') {
    $key = $Matches[1]; $val = $Matches[2].Trim()
    if ($key -and $key -ne 'PORT' -and $key -ne 'WHATSAPP_DRY_RUN' -and $val) {
      railway variables --skip-deploys --set "$key=$val" | Out-Null
      Write-Output "set $key"
    }
  }
}
Write-Output "done"
