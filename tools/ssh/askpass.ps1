$profilePath = Join-Path $PSScriptRoot '..\..\.meta\connection.txt'
$line = Get-Content -LiteralPath $profilePath |
    Where-Object { $_ -match '^\s*(pwd|password)\s*[:=]' } |
    Select-Object -First 1

if ($line) {
    ([regex]::Split($line, '\s*[:=]\s*', 2)[1]).Trim()
}
