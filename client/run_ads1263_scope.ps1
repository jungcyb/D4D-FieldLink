param([string]$BoardHost = '192.168.0.240')
$ErrorActionPreference = 'Stop'
$taskProject = (Resolve-Path "$PSScriptRoot\..").Path
$taskPython = Join-Path $taskProject '.venv-client\Scripts\pythonw.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Existing pygame client environment not found.' }
# The user explicitly requested the interactive scope window.
Start-Process -FilePath $taskPython -WorkingDirectory $taskProject `
    -ArgumentList @('client/ads1263_scope.py', '--host', $BoardHost) `
    -RedirectStandardOutput (Join-Path $taskProject '.meta/ads1263-scope.stdout.log') `
    -RedirectStandardError (Join-Path $taskProject '.meta/ads1263-scope.stderr.log') -PassThru
