$ErrorActionPreference = 'Stop'

$client = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent $client
$python = Join-Path $project '.venv-client\Scripts\pythonw.exe'

if (-not (Test-Path $python)) {
    throw "Client environment not found. See client/README.md."
}

Start-Process -FilePath $python `
    -ArgumentList (Join-Path $client 'pygame_scope.py') `
    -WorkingDirectory $project
