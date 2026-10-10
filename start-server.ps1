param(
  [int]$Port = 3000,
  [string]$BoardHost = '',
  [string]$DiscoveryAddress = '255.255.255.255',
  [switch]$DashboardOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$nodeCandidates = @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
)
$nodePath = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) -and [version]((& $_ --version).TrimStart('v')) -ge [version]'22.18.0' } | Select-Object -First 1
if (-not $nodePath) { throw 'Node.js 22.18 이상이 필요합니다.' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dashboard\node_modules\next'))) { throw 'dashboard 의존성이 없습니다. dashboard 폴더에서 npm ci를 먼저 실행하세요.' }

$logDirectory = Join-Path $repoRoot '.tmp'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$env:DAQ_MODE = 'external'
$env:DATA_DIR = Join-Path $repoRoot 'dashboard\data'
$env:DASHBOARD_URL = "http://127.0.0.1:$Port"
$env:BOARD_DISCOVERY_ADDRESS = $DiscoveryAddress
$env:DAQ_DISCOVERY_ADDRESS = $DiscoveryAddress
$env:BOARD_HOST = $BoardHost

Write-Host 'Building FIELDLINK dashboard for LAN access...'
Push-Location (Join-Path $repoRoot 'dashboard')
try {
  & $nodePath node_modules/next/dist/bin/next build
  if ($LASTEXITCODE -ne 0) { throw "Dashboard build failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$collector = $null
if (-not $DashboardOnly) {
  $collector = Start-Process -FilePath $nodePath -ArgumentList (Join-Path $repoRoot 'integration\collector.mjs') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'collector.out.log') -RedirectStandardError (Join-Path $logDirectory 'collector.err.log') -PassThru
}
Write-Host "FIELDLINK server: http://localhost:$Port (LAN: http://<server-ip>:$Port)"
if ($collector) { Write-Host "Collector log: $logDirectory\collector.out.log" } else { Write-Host 'Collector disabled for this run.' }
try {
  Push-Location (Join-Path $repoRoot 'dashboard')
  & $nodePath node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port $Port
  exit $LASTEXITCODE
} finally {
  Pop-Location
  if ($collector -and -not $collector.HasExited) { Stop-Process -Id $collector.Id -Force }
}
