param(
    [string]$BoardIp = '',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..").Path
$config = @{}
$profilePath = Join-Path $root '.meta\connection.txt'
if (-not (Test-Path -LiteralPath $profilePath)) {
    throw 'Create .meta/connection.txt from tools/connection.example.txt before deployment.'
}
Get-Content -LiteralPath $profilePath | ForEach-Object {
    if ($_ -match '^\s*([^#:=]+)\s*[:=]\s*(.+?)\s*$') {
        $config[$matches[1].Trim().ToLower()] = $matches[2].Trim()
    }
}
if (-not $config.user) {
    throw 'user is missing from .meta/connection.txt'
}
if (-not $BoardIp) {
    $hostPath = Join-Path $root '.meta\client\host.txt'
    $BoardIp = if (Test-Path -LiteralPath $hostPath) { (Get-Content -LiteralPath $hostPath -Raw).Trim() } else { $config.ip }
}
if (-not $BoardIp) { throw 'Set -BoardIp or .meta/client/host.txt or ip in .meta/connection.txt.' }

if (-not $SkipBuild) {
    & "$root\firmware\build_phase2.ps1"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$env:SSH_ASKPASS = (Resolve-Path "$root\tools\ssh\askpass.cmd").Path
$env:SSH_ASKPASS_REQUIRE = 'force'
$env:DISPLAY = 'codex-ssh'
$knownHosts = Join-Path $root '.meta\tools\ssh\known_hosts'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $knownHosts) | Out-Null
$sshOptions = @('-o', 'BatchMode=no', '-o', "UserKnownHostsFile=$knownHosts")
$target = "$($config.user)@$BoardIp"

ssh @sshOptions $target 'systemctl stop ads8688-phase2.service 2>/dev/null || true; mkdir -p /opt/ads8688 /lib/firmware/ads8688 /var/lib/ads8688/data'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

scp @sshOptions "$root\firmware\m4_ads8688\ti-arm-clang\m4_ads8688.release.out" "${target}:/lib/firmware/ads8688/m4_ads8688_stream.out"
scp @sshOptions "$root\firmware\r5_ads8688_relay\ti-arm-clang\r5_ads8688_relay.release.out" "${target}:/lib/firmware/ads8688/r5_ads8688_relay.out"
scp @sshOptions "$root\board\activate_phase2.sh" "${target}:/opt/ads8688/activate_phase2.sh"
scp @sshOptions "$root\board\ads8688d.py" "${target}:/opt/ads8688/ads8688d.py"
scp @sshOptions "$root\board\ads8688-phase2.service" "${target}:/etc/systemd/system/ads8688-phase2.service"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

ssh @sshOptions $target 'chmod 755 /opt/ads8688/activate_phase2.sh /opt/ads8688/ads8688d.py; test -x /opt/ads8688/venv/bin/python; systemctl daemon-reload; systemctl enable --now ads8688-phase2.service; systemctl --no-pager --full status ads8688-phase2.service'
exit $LASTEXITCODE
