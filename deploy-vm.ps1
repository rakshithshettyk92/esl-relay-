[CmdletBinding()]
param(
    [string]$HostName = '20.121.68.137',
    [string]$UserName = 'saiuser',
    [string]$KeyPath = "$env:USERPROFILE\.ssh\playbook_vm_ed25519"
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$outputRoot = Join-Path $projectRoot 'outputs'
$archive = Join-Path $outputRoot 'esl-relay-vm.tar'
$release = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$remote = "$UserName@$HostName"
$remoteRoot = '~/esl-relay'
$remoteRelease = "$remoteRoot/releases/$release"

function Read-DotEnv([string]$Path) {
    $result = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $result[$matches[1]] = $matches[2]
        }
    }
    return $result
}

function New-RandomValue([int]$ByteCount, [switch]$Base64) {
    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $value = [Convert]::ToBase64String($bytes)
    if (-not $Base64) { $value = $value.TrimEnd('=').Replace('+', '-').Replace('/', '_') }
    return $value
}

if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH key not found: $KeyPath" }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env'))) {
    throw 'Local .env is required for FIREBASE_SERVICE_ACCOUNT and AUTH_KEY.'
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Push-Location $projectRoot
try {
    git archive --format=tar -o $archive HEAD -- .
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the committed relay source.' }
}
finally {
    Pop-Location
}

ssh -i $KeyPath -o BatchMode=yes $remote "mkdir -p $remoteRoot/releases/$release"
if ($LASTEXITCODE -ne 0) { throw 'Could not create the relay release directory on the VM.' }

ssh -i $KeyPath -o BatchMode=yes $remote "test -f $remoteRoot/.env.vm"
$hasRemoteEnv = $LASTEXITCODE -eq 0
if (-not $hasRemoteEnv) {
    $localEnv = Read-DotEnv (Join-Path $projectRoot '.env')
    foreach ($required in @('FIREBASE_SERVICE_ACCOUNT', 'AUTH_KEY')) {
        if (-not $localEnv[$required]) { throw "Local .env is missing $required." }
    }
    $bootstrap = Join-Path ([IO.Path]::GetTempPath()) "esl-relay-$release.env"
    $lines = @(
        "FIREBASE_SERVICE_ACCOUNT=$($localEnv['FIREBASE_SERVICE_ACCOUNT'])",
        "AUTH_HEADER_NAME=$(if ($localEnv['AUTH_HEADER_NAME']) { $localEnv['AUTH_HEADER_NAME'] } else { 'x-auth-key' })",
        "AUTH_KEY=$($localEnv['AUTH_KEY'])",
        "ESL_BASE_URL=$(if ($localEnv['ESL_BASE_URL']) { $localEnv['ESL_BASE_URL'] } else { 'https://eastus.common.solumesl.com/common' })",
        'ESL_REQUEST_TIMEOUT_MS=20000',
        'TOKEN_REFRESH_BUFFER_SECONDS=300',
        'ARTICLE_LOOKUP_TIMEOUT_MS=30000',
        'ARTICLE_CACHE_TTL_SECONDS=300',
        "POSTGRES_PASSWORD=$(New-RandomValue 24)",
        "TOKEN_ENCRYPTION_KEY=$(New-RandomValue 32 -Base64)",
        'OPS_USERNAME=esladmin',
        "OPS_PASSWORD=$(New-RandomValue 24)"
    )
    try {
        [IO.File]::WriteAllLines($bootstrap, $lines, (New-Object Text.UTF8Encoding($false)))
        scp -i $KeyPath $bootstrap "${remote}:esl-relay/.env.vm.new"
        if ($LASTEXITCODE -ne 0) { throw 'Could not upload the initial VM environment.' }
        ssh -i $KeyPath -o BatchMode=yes $remote "sed -i 's/\r$//' $remoteRoot/.env.vm.new && chmod 600 $remoteRoot/.env.vm.new && mv $remoteRoot/.env.vm.new $remoteRoot/.env.vm"
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the VM environment.' }
    }
    finally {
        Remove-Item -LiteralPath $bootstrap -Force -ErrorAction SilentlyContinue
    }
}

scp -i $KeyPath $archive "${remote}:esl-relay/releases/$release/source.tar"
if ($LASTEXITCODE -ne 0) { throw 'Could not upload the relay release archive.' }

$deploy = "set -e; cd $remoteRelease; tar -xf source.tar; sed -i 's/\r$//' tools/*.sh; ln -s $remoteRoot/.env.vm .env.vm; sudo docker network inspect solum_apps >/dev/null; sudo docker compose -p esl-relay --env-file $remoteRoot/.env.vm -f docker-compose.vm.yml up -d --build --remove-orphans --wait --wait-timeout 240; sudo docker compose -p esl-relay --env-file $remoteRoot/.env.vm -f docker-compose.vm.yml exec -T relay wget -qO- http://127.0.0.1:3000/health >/dev/null; ln -sfn $remoteRelease $remoteRoot/current; bash tools/prune-releases.sh $remoteRoot 8"
ssh -i $KeyPath -o BatchMode=yes $remote $deploy
if ($LASTEXITCODE -ne 0) { throw 'ESL Relay deployment failed.' }

Write-Host "ESL Relay deployed behind the shared HTTPS gateway at https://$HostName/"
Write-Host "Operations page: https://$HostName/ops"
Write-Host "Secrets remain in $remoteRoot/.env.vm with mode 600."
