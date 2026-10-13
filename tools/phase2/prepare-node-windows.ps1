$ErrorActionPreference = 'Stop'
# Portable diagnostic runtime: no system installation, PATH or registry changes.
# Official SHA256: https://nodejs.org/dist/v24.16.0/SHASUMS256.txt
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$toolRoot = Join-Path $repositoryRoot 'test-results\phase2\tooling'
$archive = Join-Path $toolRoot 'node-v24.16.0-win-x64.zip'
$destination = Join-Path $toolRoot 'node-v24.16.0-win-x64'
$expected = 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56'
New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'NODE_ARCHIVE_HASH_MISMATCH; preserve file for inspection' }
if (-not (Test-Path -LiteralPath $destination)) { Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot }
& (Join-Path $destination 'node.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'PORTABLE_NODE_FAILED' }
Write-Output "Portable runtime ready at $destination; use a session-local PATH to select it."
