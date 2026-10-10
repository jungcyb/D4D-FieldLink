param(
    [string]$BoardIp = '',
    [switch]$SkipBuild,
    [switch]$NoTest,
    [switch]$Keep,
    [double]$Seconds = 5
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

$firmware = "$root\firmware\r5_ads1263_scan\ti-arm-clang\am64-main-r5f1_0-fw"
if (-not $SkipBuild) {
    & "$root\firmware\r5_ads1263_scan\build.ps1"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path -LiteralPath $firmware)) { throw "Firmware not built: $firmware" }

# Same SSH setup as deploy_ads1263.ps1: keys if present, otherwise askpass from .meta.
$env:SSH_ASKPASS = (Resolve-Path "$root\tools\ssh\askpass.cmd").Path
$env:SSH_ASKPASS_REQUIRE = 'prefer'
$env:DISPLAY = 'codex-ssh'
$knownHosts = Join-Path $root '.meta\tools\ssh\known_hosts'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $knownHosts) | Out-Null
$sshOptions = @('-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3',
    '-o', "UserKnownHostsFile=$knownHosts", '-o', 'StrictHostKeyChecking=accept-new')
$target = "$($config.user)@$BoardIp"

ssh @sshOptions $target 'mkdir -p /opt/ads1263 /lib/firmware/ads1263_scan'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
scp @sshOptions $firmware "${target}:/lib/firmware/ads1263_scan/am64-main-r5f1_0-fw"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
scp @sshOptions "$root\board\ads1263_scan_test.py" "${target}:/opt/ads1263/"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
ssh @sshOptions $target 'chmod 755 /opt/ads1263/ads1263_scan_test.py'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($NoTest) {
    Write-Host 'ADS1263 scan firmware staged; R5FSS1-0 was not changed.'
    exit 0
}

$testArgs = "--seconds $Seconds"
if ($Keep) { $testArgs += ' --keep' }
ssh @sshOptions $target "/opt/ads1263/ads1263_scan_test.py $testArgs"
exit $LASTEXITCODE
