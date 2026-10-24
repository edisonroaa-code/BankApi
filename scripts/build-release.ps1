param(
    [switch]$WithDocker,
    [switch]$SkipDocker,
    [int]$MaxInstallerMB = 180
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

$env:NODE_ENV = "production"
$env:MAX_INSTALLER_MB = "$MaxInstallerMB"

Write-Host "[1/3] Prebuild" -ForegroundColor Cyan
if ($WithDocker -and -not $SkipDocker) {
    npm run desktop:pre:full
}
else {
    npm run desktop:pre:simple
}

Write-Host "[2/3] Build installer" -ForegroundColor Cyan
npm run build:desktop:app
npm run build:desktop:installer:client
npm run build:desktop:installer:server

Write-Host "[3/3] Postbuild checks" -ForegroundColor Cyan
npm run desktop:post

Write-Host "Build completado. Artefactos en ./release y ./release-build." -ForegroundColor Green
