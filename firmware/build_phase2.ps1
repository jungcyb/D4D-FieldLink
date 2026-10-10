$ErrorActionPreference = 'Stop'

$firmware = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdk = 'C:\ti\mcu_plus_sdk_am64x_11_02_00_24'
$syscfg = 'C:\ti\sysconfig_1.27.0'
$node = Join-Path $syscfg 'nodejs\node.exe'
$cli = Join-Path $syscfg 'dist\cli.js'
$product = Join-Path $sdk '.metadata\product.json'
$make = 'C:\ti\ccs2101\ccs\utils\bin\gmake.exe'
$m4 = Join-Path $firmware 'm4_ads8688'
$r5 = Join-Path $firmware 'r5_ads8688_relay'

foreach ($path in @($node, $cli, $product, $make)) {
    if (-not (Test-Path $path)) {
        throw "Required build tool not found: $path"
    }
}

& $node $cli --product $product `
    --script (Join-Path $m4 'example.syscfg') --context m4fss0-0 `
    --output (Join-Path $m4 'ti-arm-clang\generated') `
    --script (Join-Path $r5 'example.syscfg') --context r5fss0-0 `
    --output (Join-Path $r5 'ti-arm-clang\generated')
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $make -C (Join-Path $m4 'ti-arm-clang') out PROFILE=release SYSTEM_FLAG=true
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $make -C (Join-Path $r5 'ti-arm-clang') out PROFILE=release SYSTEM_FLAG=true
exit $LASTEXITCODE
