$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$makeDir = Join-Path $project 'ti-arm-clang'
$make = 'C:\ti\ccs2101\ccs\utils\bin\gmake.exe'

if (-not (Test-Path $make)) {
    throw "gmake not found: $make"
}

& $make -C $makeDir out PROFILE=release
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
