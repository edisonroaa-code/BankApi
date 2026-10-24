param(
  [switch]$IncludeUploads,
  [switch]$IncludeUsers,
  [switch]$NoBackup,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Read-EnvFile([string]$Path) {
  if (!(Test-Path $Path)) { throw "No se encontró el archivo .env: $Path" }
  $envMap = @{}
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line) { return }
    if ($line.StartsWith('#')) { return }
    $parts = $line.Split('=', 2)
    if ($parts.Count -ne 2) { return }
    $key = $parts[0].Trim()
    $val = $parts[1].Trim()
    if ($key) { $envMap[$key] = $val }
  }
  return $envMap
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot 'backend'
$envPath = Join-Path $backendDir '.env'
$envMap = Read-EnvFile $envPath

$dbUser = $envMap['DB_USERNAME']
$dbPass = $envMap['DB_PASSWORD']
$dbName = $envMap['DB_DATABASE']

if (-not $dbUser -or -not $dbName) {
  throw "DB_USERNAME y DB_DATABASE deben estar definidos en $envPath"
}

$containerName = 'bankapi_db'
$containerId = (& docker ps -q -f "name=^${containerName}$") | Select-Object -First 1
if (-not $containerId) {
  throw "No se encontró el contenedor Docker '$containerName'. Encendé Docker y ejecutá: docker compose -f backend/docker-compose.yml --env-file backend/.env up -d"
}

$what = @(
  'payments (consultas)',
  'bank_transfers / bank_transfer_claims (transferencias y tomas)',
  'movements (extractos importados)',
  'audit_logs (auditoría)'
)
if ($IncludeUsers) { $what += 'users (usuarios)' }
if ($IncludeUploads) { $what += 'backend/uploads (comprobantes)' }

Write-Host ''
Write-Host 'RESET DE DATOS (modo producción)' -ForegroundColor Yellow
Write-Host 'Esto BORRA datos de pruebas para empezar con datos reales.'
Write-Host ('Se borrará: ' + ($what -join ', '))
Write-Host ''

if (-not $Force) {
  $confirm = Read-Host "Escribí BORRAR para confirmar"
  if ($confirm -ne 'BORRAR') {
    Write-Host 'Cancelado.' -ForegroundColor Cyan
    exit 0
  }
}

if (-not $NoBackup) {
  $dumpDir = Join-Path $repoRoot 'backups\db_dumps'
  New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $dumpPath = Join-Path $dumpDir "db_dump_$stamp.sql"

  Write-Host "Creando backup SQL: $dumpPath" -ForegroundColor Cyan
  $dumpCmd = "PGPASSWORD='$dbPass' pg_dump -U $dbUser -d $dbName"
  docker exec $containerName sh -c $dumpCmd | Set-Content -Encoding utf8 $dumpPath
}

$tables = @('public.audit_logs', 'public.bank_transfer_claims', 'public.bank_transfers', 'public.payments', 'public.movements')
if ($IncludeUsers) { $tables += 'public.users' }

$sql = "TRUNCATE TABLE $($tables -join ', ') RESTART IDENTITY CASCADE;"
Write-Host "Ejecutando: $sql" -ForegroundColor Cyan
docker exec -e "PGPASSWORD=$dbPass" $containerName psql -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -c $sql | Out-Null

if ($IncludeUploads) {
  $uploadsDir = Join-Path $backendDir 'uploads'
  if (Test-Path $uploadsDir) {
    Write-Host "Borrando archivos en: $uploadsDir" -ForegroundColor Cyan
    Get-ChildItem -Path $uploadsDir -File -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'Listo. Base limpia para empezar con datos reales.' -ForegroundColor Green
