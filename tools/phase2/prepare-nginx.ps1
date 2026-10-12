$ErrorActionPreference = 'Stop'
# A pinned test-only executable under the workspace; never installs a service
# or touches the user's gateway/nginx configuration.
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskDir = Join-Path $taskRoot 'test-results/phase2/tooling'
$archivePath = Join-Path $taskDir 'nginx-1.30.5.zip'
$expectedHash = 'e5afe28b6a50bec92c478bfe1a4d3758206b80fb77159277bc5c4e88955c2a35'
New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
if (!(Test-Path -LiteralPath $archivePath)) {
    Invoke-WebRequest -Uri 'https://nginx.org/download/nginx-1.30.5.zip' -OutFile $archivePath -UseBasicParsing
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Pinned nginx archive hash mismatch. Artifact retained for inspection.'
}
$binaryPath = Join-Path $taskDir 'nginx-1.30.5/nginx.exe'
if (!(Test-Path -LiteralPath $binaryPath)) { Expand-Archive -LiteralPath $archivePath -DestinationPath $taskDir }
& $binaryPath -v
if ($LASTEXITCODE -ne 0) { throw 'Test nginx executable check failed.' }
