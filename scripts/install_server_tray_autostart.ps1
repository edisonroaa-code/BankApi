param(
  [switch]$ConfirmServer
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startScript = Join-Path $repoRoot 'scripts\server_tray_start.ps1'
$taskName = 'BankApi-ServerTray'

if (-not $ConfirmServer) {
  Write-Output "IMPORTANTE: este auto-inicio se instala SOLO en la PC SERVIDOR."
  Write-Output "En PCs cliente NO debe existir esta tarea."
  Write-Output ""
  Write-Output "Si realmente esta PC es el servidor, re-ejecuta con:"
  Write-Output "  scripts\\install_server_tray_autostart.ps1 -ConfirmServer"
  exit 0
}

if (-not (Test-Path $startScript)) {
  throw "No existe: $startScript"
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
  "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -Quiet"
)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

try {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
  }
} catch { }

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

Write-Output "Tarea creada: $taskName"
Write-Output "Se ejecuta al iniciar sesion: $env:USERNAME"
Write-Output "Script: $startScript"
