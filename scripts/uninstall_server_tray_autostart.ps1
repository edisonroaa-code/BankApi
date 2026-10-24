$ErrorActionPreference = 'Stop'

$taskName = 'BankApi-ServerTray'

try {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Output "No existe la tarea: $taskName"
    exit 0
  }

  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
  Write-Output "Tarea eliminada: $taskName"
} catch {
  throw
}
