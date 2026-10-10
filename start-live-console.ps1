param(
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.\-]*(:[0-9]{1,5})?$')][string[]]$BoardHost = @(),
  [ValidatePattern('^[0-9.]+$')][string[]]$DiscoveryAddress = @()
)
$ErrorActionPreference = 'Stop'
$consolePython = Join-Path $PSScriptRoot '.venv-client\Scripts\pythonw.exe'
if (-not (Test-Path -LiteralPath $consolePython)) {
  throw 'Existing .venv-client is required. See live_console/README.md; no global Python installation is needed.'
}
$consoleAddresses = @($DiscoveryAddress)
if (-not $consoleAddresses.Count) {
  # Send to each physical private LAN, not just the default-route adapter.
  $interfaces = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
    $_.AddressState -eq 'Preferred' -and $_.PrefixLength -ge 16 -and $_.PrefixLength -le 30 -and
    $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|Loopback' -and
    ($_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or $_.IPAddress -match '^172\.(1[6-9]|2[0-9]|3[01])\.')
  }
  foreach ($networkInterface in $interfaces) {
    $addressBytes = [Net.IPAddress]::Parse($networkInterface.IPAddress).GetAddressBytes()
    for ($byteIndex = 0; $byteIndex -lt 4; $byteIndex++) {
      $bits = [Math]::Max(0, [Math]::Min(8, $networkInterface.PrefixLength - 8 * $byteIndex))
      $hostMask = (1 -shl (8 - $bits)) - 1
      $addressBytes[$byteIndex] = $addressBytes[$byteIndex] -bor $hostMask
    }
    $consoleAddresses += ([Net.IPAddress]::new($addressBytes)).ToString()
  }
  $consoleAddresses += '255.255.255.255'
}
$consoleArguments = @('-m', 'live_console')
foreach ($boardAddress in $BoardHost) { $consoleArguments += @('--host', $boardAddress) }
foreach ($broadcastAddress in ($consoleAddresses | Select-Object -Unique)) { $consoleArguments += @('--broadcast', $broadcastAddress) }
$consoleLogDirectory = Join-Path $PSScriptRoot '.meta\live_console'
New-Item -ItemType Directory -Force -Path $consoleLogDirectory | Out-Null
$consoleLogName = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
# The pygame window is the requested interactive UI; no shell window is opened.
$consoleProcess = Start-Process -FilePath $consolePython -ArgumentList $consoleArguments -WorkingDirectory $PSScriptRoot -WindowStyle Normal -PassThru -RedirectStandardOutput (Join-Path $consoleLogDirectory "$consoleLogName.out.log") -RedirectStandardError (Join-Path $consoleLogDirectory "$consoleLogName.err.log")
Write-Host "Live Console started (PID $($consoleProcess.Id)). No dashboard or collector dependency."
