# Installs the label print helper on this Windows PC. Run it once, from install-windows.bat.
#
# What it does: finds (or installs) Python, puts the helper in %LOCALAPPDATA%\PrintHelper, finds the label
# printer, makes the helper start by itself every time this user signs in, and starts it now. Afterwards
# nobody has to open anything: the app's "Print label to printer" button just works on this PC.
#
# Before handing the installer out, set $DefaultAppUrl below to the address of the deployed app.
# Remove it again with:  install-windows.bat -Uninstall

param(
  [string]$AppUrl = "",
  [string]$Printer = "",
  [string]$ExtensionId = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# ---- set this to the deployed app's address, e.g. https://tracker.uath.example (no trailing slash) ----
$DefaultAppUrl = "https://uath-consumables.netlify.app/"
# -----------------------------------------------------------------------------------------------------

$InstallDir = Join-Path $env:LOCALAPPDATA "PrintHelper"
$StartupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "Label Print Helper.lnk"

function Stop-Helper {
  Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" |
    Where-Object { $_.CommandLine -like "*print_bridge.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Stop-Helper
  Remove-Item $StartupLink -Force -ErrorAction SilentlyContinue
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "The print helper has been removed from this PC."
  exit 0
}

if (-not $AppUrl) { $AppUrl = $DefaultAppUrl }
$AppUrl = $AppUrl.TrimEnd("/")
if ($AppUrl -like "*CHANGE-ME*") {
  $AppUrl = (Read-Host "Address of the app (for example https://tracker.uath.example)").Trim().TrimEnd("/")
}
if ($AppUrl -notmatch "^https?://[^/\s]+$") {
  throw "The app address must look like https://tracker.uath.example (no path at the end)."
}

# ---- the helper script, next to this installer or one folder up ----
$bridge = @((Join-Path $PSScriptRoot "print_bridge.py"), (Join-Path $PSScriptRoot "..\print_bridge.py")) |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bridge) { throw "print_bridge.py was not found next to this installer." }

# ---- Python ----
function Find-Python {
  foreach ($candidate in @("py", "python")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    $pyArgs = if ($candidate -eq "py") { @("-3", "-c", "import sys;print(sys.executable)") } else { @("-c", "import sys;print(sys.executable)") }
    try {
      $path = & $cmd.Source @pyArgs 2>$null
      if ($LASTEXITCODE -eq 0 -and $path -and (Test-Path $path) -and ($path -notlike "*WindowsApps*")) { return $path }
    } catch { }
  }
  return $null
}

$python = Find-Python
if (-not $python) {
  Write-Host "Python is not installed on this PC. Installing it now (this takes a minute)..."
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Python is missing and winget is not available. Install Python 3 from python.org (tick 'Add python.exe to PATH'), then run this installer again."
  }
  winget install --id Python.Python.3.12 -e --silent --scope user --accept-package-agreements --accept-source-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
  $python = Find-Python
  if (-not $python) { throw "Python was installed but could not be found. Close this window, open the installer again." }
}

# ---- install ----
Stop-Helper
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $bridge (Join-Path $InstallDir "print_bridge.py") -Force

$venv = Join-Path $InstallDir "venv"
if (-not (Test-Path (Join-Path $venv "Scripts\pythonw.exe"))) {
  Write-Host "Setting up the helper..."
  & $python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "Could not create the helper's Python environment." }
}
& (Join-Path $venv "Scripts\python.exe") -m pip install --quiet --disable-pip-version-check websockets pywin32
if ($LASTEXITCODE -ne 0) { throw "Could not install the helper's requirements. Check the internet connection and try again." }

# ---- the label printer ----
if (-not $Printer) {
  $skip = "Microsoft|OneNote|Fax|XPS|PDF"
  $printers = @(Get-Printer | Where-Object { $_.Name -notmatch $skip } | Select-Object -ExpandProperty Name)
  if ($printers.Count -eq 0) { throw "No printer is installed on this PC. Plug in the label printer, install its driver, then run this again." }
  $guess = @($printers | Where-Object { $_ -match "xprinter|label|365|tsc|zebra" })
  if ($guess.Count -eq 1) {
    $Printer = $guess[0]
  } elseif ($printers.Count -eq 1) {
    $Printer = $printers[0]
  } else {
    Write-Host ""
    Write-Host "Which one is the label printer?"
    for ($i = 0; $i -lt $printers.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $printers[$i]) }
    do { $pick = [int](Read-Host "Number") } until ($pick -ge 1 -and $pick -le $printers.Count)
    $Printer = $printers[$pick - 1]
  }
}
Write-Host "Label printer: $Printer"

# ---- start at sign-in, then start now ----
$pythonw = Join-Path $venv "Scripts\pythonw.exe"
$scriptPath = Join-Path $InstallDir "print_bridge.py"
$arguments = "`"$scriptPath`" --printer `"$Printer`" --origin `"$AppUrl`""
if ($ExtensionId) {
  if ($ExtensionId -notmatch "^[a-p]{32}$") { throw "The extension ID should be 32 letters (a to p), copied from the extension's error message." }
  $arguments += " --extension-id `"$ExtensionId`""
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($StartupLink)
$link.TargetPath = $pythonw
$link.Arguments = $arguments
$link.WorkingDirectory = $InstallDir
$link.WindowStyle = 7
$link.Save()

Start-Process -FilePath $pythonw -ArgumentList $arguments -WorkingDirectory $InstallDir -WindowStyle Hidden
Start-Sleep -Seconds 2
$running = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" | Where-Object { $_.CommandLine -like "*print_bridge.py*" }
if (-not $running) { throw "The helper did not start. Look in $env:USERPROFILE\print_helper.log." }

Write-Host ""
Write-Host "Done. The print helper is running and will start by itself whenever this user signs in."
Write-Host "Open the app in Chrome or Edge and use 'Print label to printer'."
