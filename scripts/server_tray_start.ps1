

param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entry = Join-Path $repoRoot 'electron\server_tray.cjs'

if (-not (Test-Path $entry)) {
  Write-Output "No existe: $entry"
  exit 1
}

try {
  $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*server_tray.cjs*" }
} catch {
  $running = @()
}

if ($running -and $running.Count -gt 0) {
  if (-not $Quiet) {
    $pids = ($running | Select-Object -ExpandProperty ProcessId) -join ', '
    Write-Output "Server tray ya esta en ejecucion (PID: $pids)."
  }
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Output 'Node.js no esta disponible (no se encontro `node`).'
  exit 1
}

$electronCmd = Join-Path $repoRoot 'node_modules\.bin\electron.cmd'
if (-not (Test-Path $electronCmd)) {
  Write-Output "Electron no esta instalado (no existe: $electronCmd)."
  Write-Output "Ejecuta: npm install"
  exit 1
}

$args = @("`"$entry`"")
$p = Start-Process -PassThru -WindowStyle Hidden -FilePath $electronCmd -ArgumentList $args -WorkingDirectory $repoRoot
if (-not $Quiet) {
  Write-Output "Server tray iniciado (PID: $($p.Id))."
}
