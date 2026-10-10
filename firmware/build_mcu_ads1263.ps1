# ADS1263 on the MCU header: build m4_ads1263 (M4F) and r5_ads8688_relay (R5FSS0-0).
# The M4F image borrows the relay's IPC shared region, so SysConfig must run
# for both contexts in one invocation (same as build_phase2.ps1 for ADS8688).
$ErrorActionPreference = 'Stop'

$firmware = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdk = 'C:\ti\mcu_plus_sdk_am64x_11_02_00_24'

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

$node = Join-Path $syscfg.FullName 'nodejs\node.exe'
$cli = Join-Path $syscfg.FullName 'dist\cli.js'
$product = Join-Path $sdk '.metadata\product.json'
$make = Join-Path $ccs.FullName 'ccs\utils\bin\gmake.exe'
$ccsPath = ($ccs.FullName + '\ccs') -replace '\\', '/'
$m4 = Join-Path $firmware 'm4_ads1263'
$r5 = Join-Path $firmware 'r5_ads8688_relay'

& $node $cli --product $product `
    --script (Join-Path $m4 'example.syscfg') --context m4fss0-0 `
    --output (Join-Path $m4 'ti-arm-clang\generated') `
    --script (Join-Path $r5 'example.syscfg') --context r5fss0-0 `
    --output (Join-Path $r5 'ti-arm-clang\generated')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

foreach ($project in @($m4, $r5)) {
    & $make -C (Join-Path $project 'ti-arm-clang') out PROFILE=release SYSTEM_FLAG=true "CCS_PATH=$ccsPath"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
