$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Host "Este script necesita permisos de Administrador." -ForegroundColor Yellow
  Write-Host "Abri PowerShell como Administrador y ejecuta:" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\\allow_lan_firewall.ps1" -ForegroundColor Cyan
  exit 1
}

$rules = @(
  @{ Name = 'BankApi API 48300'; Port = 48300 },
  @{ Name = 'BankApi Web 48517'; Port = 48517 }
)

foreach ($r in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    New-NetFirewallRule `
      -DisplayName $r.Name `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort $r.Port `
      -Profile Private `
      -Enabled True | Out-Null
    Write-Host "Regla creada: $($r.Name) (TCP $($r.Port), Private)" -ForegroundColor Green
  } else {
    Set-NetFirewallRule -DisplayName $r.Name -Enabled True | Out-Null
    Write-Host "Regla existente habilitada: $($r.Name)" -ForegroundColor Green
  }
}

Write-Host "Listo. Ahora otros dispositivos en la LAN pueden acceder a:" -ForegroundColor Green
Write-Host "  http://IP_DE_TU_PC:48517  (Web)" -ForegroundColor Cyan
Write-Host "  http://IP_DE_TU_PC:48300  (API)" -ForegroundColor Cyan
