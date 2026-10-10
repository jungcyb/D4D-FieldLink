param(
    [ValidateSet('out', 'all', 'clean')]
    [string]$Target = 'out'
)

$make = 'C:\ti\ccs2101\ccs\utils\bin\gmake.exe'
$buildDirectory = Join-Path $PSScriptRoot 'ti-arm-clang'
$openSslDirectory = 'C:\Program Files\Git\mingw64\bin'

if (-not (Test-Path -LiteralPath $make)) {
    throw "GNU make not found: $make"
}

if ($Target -eq 'all' -and (Test-Path -LiteralPath $openSslDirectory)) {
    $env:Path = "$openSslDirectory;$env:Path"
}

& $make -C $buildDirectory -f makefile PROFILE=release $Target
exit $LASTEXITCODE
