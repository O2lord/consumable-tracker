# Consumables Tracker - label printing setup for Windows.
# Makes QZ Tray trust the Consumables Tracker certificate, so QZ Tray can remember "Allow" instead of asking
# every time. Started by setup-qz-windows.bat. It asks for administrator permission once.

$ErrorActionPreference = "Stop"
$cert = Join-Path $PSScriptRoot "override.crt"

function Stop-Setup($message) {
  Write-Host ""
  Write-Host "ERROR: $message" -ForegroundColor Red
  Write-Host ""
  Read-Host "Press Enter to close this window"
  exit 1
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  # Copying into Program Files needs administrator rights: run this script again as administrator.
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

if (-not (Test-Path $cert)) { Stop-Setup "override.crt is missing from this folder. Unzip the whole consumables-setup folder first." }
if (-not ((Get-Content $cert -TotalCount 1) -match "BEGIN CERTIFICATE")) {
  Stop-Setup "override.crt is not a certificate. Ask the person who gave you this folder for a new copy."
}

$dir = @("$env:ProgramFiles\QZ Tray", "${env:ProgramFiles(x86)}\QZ Tray") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $dir) {
  Stop-Setup "QZ Tray is not installed. Install it from https://qz.io/download, open it once, then run this setup again."
}

Write-Host "Consumables Tracker label printing setup"
Write-Host ""
Copy-Item -Path $cert -Destination (Join-Path $dir "override.crt") -Force
if ((Get-FileHash $cert).Hash -ne (Get-FileHash (Join-Path $dir "override.crt")).Hash) {
  Stop-Setup "The certificate was copied but does not match. Try again."
}
Write-Host "Certificate installed in $dir"

# QZ Tray reads the certificate when it starts, so close it. Open it again from the Start menu (as a normal user,
# not as administrator).
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*qz-tray*" -and $_.Name -match "java|qz" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "Done. Now open QZ Tray from the Start menu."
Write-Host "Then open the Consumables Tracker in Chrome, press a Print button, tick 'Remember this decision' and click Allow."
Write-Host ""
Read-Host "Press Enter to close this window"
