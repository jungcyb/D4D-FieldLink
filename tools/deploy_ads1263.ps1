param(
    [string]$BoardIp = '',
    [switch]$SkipBuild,
    [switch]$Activate,
    [ValidateSet('external', 'header')]
    [string]$PowerSource = 'external'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..").Path
$profilePath = Join-Path $root '.meta\connection.txt'
$config = @{}

if (-not (Test-Path -LiteralPath $profilePath)) {
    throw 'Create .meta/connection.txt from tools/connection.example.txt.'
}
Get-Content -LiteralPath $profilePath | ForEach-Object {
    if ($_ -match '^\s*([^#:=]+)\s*[:=]\s*(.+?)\s*$') {
        $config[$matches[1].Trim().ToLower()] = $matches[2].Trim()
    }
}
if (-not $config.user) { throw 'user is missing from .meta/connection.txt' }
if (-not $BoardIp) { $BoardIp = $config.ip }
if (-not $BoardIp) { throw 'Set -BoardIp or ip in .meta/connection.txt.' }

if (-not $SkipBuild) {
    & "$root\firmware\r5_ads1263\build.ps1"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$env:SSH_ASKPASS = (Resolve-Path "$root\tools\ssh\askpass.cmd").Path
$env:SSH_ASKPASS_REQUIRE = 'force'
$env:DISPLAY = 'codex-ssh'
$knownHosts = Join-Path $root '.meta\tools\ssh\known_hosts'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $knownHosts) | Out-Null
$sshOptions = @('-o', 'BatchMode=no', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '-o', "UserKnownHostsFile=$knownHosts")
$target = "$($config.user)@$BoardIp"

ssh @sshOptions $target 'mkdir -p /opt/ads1263 /lib/firmware/ads1263'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

scp @sshOptions "$root\firmware\r5_ads1263\ti-arm-clang\am64-main-r5f1_0-fw" "${target}:/lib/firmware/ads1263/am64-main-r5f1_0-fw"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
scp @sshOptions "$root\board\activate_ads1263.sh" "$root\board\ads1263_smoke.py" "$root\board\ads1263_diag.py" "${target}:/opt/ads1263/"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

ssh @sshOptions $target 'chmod 755 /opt/ads1263/activate_ads1263.sh /opt/ads1263/ads1263_smoke.py'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Activate) {
    ssh @sshOptions $target "/opt/ads1263/activate_ads1263.sh start $PowerSource && sleep 1 && /opt/ads1263/activate_ads1263.sh status && /opt/ads1263/ads1263_smoke.py"
    exit $LASTEXITCODE
}

Write-Host 'ADS1263 firmware and smoke test staged; hardware state was not changed.'
