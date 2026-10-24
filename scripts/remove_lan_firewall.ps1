$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Host "Este script necesita permisos de Administrador." -ForegroundColor Yellow
  Write-Host "Abri PowerShell como Administrador y ejecuta:" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\\remove_lan_firewall.ps1" -ForegroundColor Cyan
  exit 1
}

$names = @('BankApi API 3000', 'BankApi Web 5173')
foreach ($name in $names) {
  $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    Remove-NetFirewallRule -DisplayName $name
    Write-Host "Regla eliminada: $name" -ForegroundColor Green
  } else {
    Write-Host "No existe la regla: $name" -ForegroundColor DarkGray
  }
}
