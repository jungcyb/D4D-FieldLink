param([int]$Port = 3000, [string]$ListenAddress = '127.0.0.1')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runtimeCandidates = @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
)
foreach ($runtimePath in $runtimeCandidates) {
  if ($runtimePath -and (Test-Path -LiteralPath $runtimePath)) {
    $runtimeVersion = & $runtimePath --version
    if ([version]($runtimeVersion.TrimStart('v')) -ge [version]'22.18.0') {
      & $runtimePath node_modules/next/dist/bin/next dev --hostname $ListenAddress --port $Port
      exit $LASTEXITCODE
    }
  }
}
throw 'Node.js 22.18 이상이 필요합니다. 설치 후 npm run dev를 실행해 주세요.'
