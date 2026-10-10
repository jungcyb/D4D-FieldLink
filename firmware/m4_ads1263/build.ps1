param(
    [ValidateSet('out', 'all', 'clean')]
    [string]$Target = 'out',
    [ValidateSet('debug', 'release')]
    [string]$Profile = 'release'
)

$ErrorActionPreference = 'Stop'
$buildDirectory = Join-Path $PSScriptRoot 'ti-arm-clang'

# CCS / SysConfig versions differ between team PCs; use the newest one installed.
function Find-Newest([string]$pattern, [string]$probe) {
    Get-ChildItem -Path 'C:\ti' -Directory -Filter $pattern -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName $probe) } |
        Sort-Object Name -Descending | Select-Object -First 1
}
$ccs = Find-Newest 'ccs*' 'ccs\tools\compiler\ti-cgt-armllvm_5.1.1.LTS'
$syscfg = Find-Newest 'sysconfig_*' 'dist\cli.js'
if (-not $ccs) { throw 'No CCS with ti-cgt-armllvm_5.1.1.LTS found under C:\ti' }
if (-not $syscfg) { throw 'No SysConfig found under C:\ti' }

$ccsPath = ($ccs.FullName + '\ccs') -replace '\\', '/'
$make = Join-Path $ccs.FullName 'ccs\utils\bin\gmake.exe'

& $make -C $buildDirectory -f makefile "PROFILE=$Profile" "CCS_PATH=$ccsPath" `
    "SYSCFG_PATH=$($syscfg.FullName -replace '\\', '/')" $Target
exit $LASTEXITCODE
