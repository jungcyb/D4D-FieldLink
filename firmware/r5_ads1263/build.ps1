param(
    [ValidateSet('out', 'all', 'clean')]
    [string]$Target = 'out',
    [ValidateSet('debug', 'release')]
    [string]$Profile = 'debug'
)

$ErrorActionPreference = 'Stop'
$make = 'C:\ti\ccs2101\ccs\utils\bin\gmake.exe'
$buildDirectory = Join-Path $PSScriptRoot 'ti-arm-clang'

if (-not (Test-Path -LiteralPath $make)) {
    throw "GNU make not found: $make"
}

& $make -C $buildDirectory -f makefile "PROFILE=$Profile" $Target
exit $LASTEXITCODE
