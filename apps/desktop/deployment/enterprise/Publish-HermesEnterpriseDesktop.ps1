[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [string]$ReleaseDirectory,

    [switch]$RequireOfflineRuntime,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$desktopRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $ReleaseDirectory) {
    $ReleaseDirectory = Join-Path $desktopRoot 'release'
}
$releaseRoot = [System.IO.Path]::GetFullPath($ReleaseDirectory)
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
    throw "Electron Builder release directory does not exist: $releaseRoot"
}

$unpacked = Join-Path $releaseRoot 'win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'Hermes.exe') -PathType Leaf)) {
    throw "Runnable win-unpacked/Hermes.exe was not found in: $releaseRoot"
}

$offlineRuntimeManifestPath = Join-Path $unpacked 'resources\offline-runtime\manifest.json'
$offlineRuntimeManifest = $null
if (Test-Path -LiteralPath $offlineRuntimeManifestPath -PathType Leaf) {
    $offlineRuntimeManifest = Get-Content -LiteralPath $offlineRuntimeManifestPath -Raw | ConvertFrom-Json
}
if ($RequireOfflineRuntime -and -not $offlineRuntimeManifest) {
    throw "Required offline runtime payload is missing from win-unpacked: $offlineRuntimeManifestPath"
}

if (Test-Path -LiteralPath $outputRoot) {
    $existing = @(Get-ChildItem -LiteralPath $outputRoot -Force)
    if ($existing.Count -gt 0 -and -not $Force) {
        throw "OutputDirectory is not empty. Choose an empty directory or pass -Force: $outputRoot"
    }
    if ($existing.Count -gt 0) {
        foreach ($entry in $existing) {
            Remove-Item -LiteralPath $entry.FullName -Recurse -Force
        }
    }
} else {
    [System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
}

$package = Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json
$portableName = "Hermes-$($package.version)-win-x64-portable.zip"
$portablePath = Join-Path $outputRoot $portableName
Compress-Archive -LiteralPath $unpacked -DestinationPath $portablePath -CompressionLevel Optimal

$installers = @(Get-ChildItem -LiteralPath $releaseRoot -File | Where-Object {
    $_.Extension -in '.exe', '.msi' -and $_.Name -like 'Hermes-*'
})
foreach ($installer in $installers) {
    Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path $outputRoot $installer.Name)
}

$deploymentTarget = Join-Path $outputRoot 'deployment'
[System.IO.Directory]::CreateDirectory($deploymentTarget) | Out-Null
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $deploymentTarget $file.Name)
}

$repoRoot = (& git -C $desktopRoot rev-parse --show-toplevel).Trim()
$gitCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
$gitBranch = (& git -C $repoRoot branch --show-current).Trim()
$trackedStatusLines = @(& git -C $repoRoot status --porcelain=v1 --untracked-files=no | Sort-Object)
$trackedSourceFiles = @(& git -C $repoRoot diff --name-only HEAD -- | Sort-Object -Unique)
$untrackedBuildScopes = @(
    'apps/desktop/assets',
    'apps/desktop/deployment',
    'apps/desktop/electron',
    'apps/desktop/public',
    'apps/desktop/scripts',
    'apps/desktop/src',
    'apps/desktop/package.json'
)
$untrackedBuildFiles = @(
    & git -C $repoRoot ls-files --others --exclude-standard -- $untrackedBuildScopes |
        Sort-Object -Unique
)
$statusLines = @(
    $trackedStatusLines
    $untrackedBuildFiles | ForEach-Object { "?? $_" }
)
$sourceFiles = @($trackedSourceFiles + $untrackedBuildFiles | Sort-Object -Unique)
$sourceStateLines = [System.Collections.Generic.List[string]]::new()
foreach ($line in $statusLines) {
    $sourceStateLines.Add("status:$line")
}
foreach ($relativePath in $sourceFiles) {
    $sourcePath = Join-Path $repoRoot $relativePath
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $sourceStateLines.Add("file:$($relativePath.Replace('\', '/')):$sourceHash")
    }
}
$sourceStateText = ($sourceStateLines | Sort-Object) -join "`n"
$sourceStateBytes = [System.Text.Encoding]::UTF8.GetBytes($sourceStateText)
$sourceStateDigest = [System.Security.Cryptography.SHA256]::HashData($sourceStateBytes)
$sourceStateSha256 = [System.Convert]::ToHexString($sourceStateDigest).ToLowerInvariant()
$gitDirty = $statusLines.Count -gt 0

$runtimeArtifacts = @(
    Get-ChildItem -LiteralPath $outputRoot -File |
        Where-Object { $_.Name -ne 'manifest.json' -and $_.Name -ne 'SHA256SUMS.txt' } |
        Sort-Object Name
)
$artifactEntries = @($runtimeArtifacts | ForEach-Object {
    [ordered]@{
        path = $_.Name
        bytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        type = if ($_.Name -like '*portable.zip') { 'portable' } elseif ($_.Extension -eq '.msi') { 'msi' } else { 'installer' }
        signatureStatus = if ($_.Extension -in '.exe', '.msi') { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status.ToString() } else { 'not-applicable' }
    }
})

$manifest = [ordered]@{
    schemaVersion = 1
    product = 'Hermes Enterprise Desktop'
    version = $package.version
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    source = [ordered]@{
        commit = $gitCommit
        branch = $gitBranch
        dirty = $gitDirty
        statusEntryCount = $statusLines.Count
        sourceFileCount = $sourceFiles.Count
        sourceStateSha256 = $sourceStateSha256
        sourceStateScope = 'all tracked repository changes plus untracked Desktop build inputs; unrelated untracked workspace files excluded'
    }
    configuration = [ordered]@{
        machinePath = '%ProgramData%\Hermes\enterprise-desktop.json'
        precedence = @('machine', 'portable', 'user', 'environment fallback only when no deployment config exists')
        allowedFields = @('schemaVersion', 'enabled', 'gatewayUrl', 'allowInsecureLanHttp', 'weComGatewayRunnerExperiment')
        gatewayUrlPolicy = 'HTTPS origin by default; loopback HTTP allowed; private IP HTTP requires explicit internal rehearsal gate'
        desktopSecretsAllowed = $false
    }
    updatePolicy = [ordered]@{
        authority = 'https://github.com/Shell-bic/hermes-agent.git'
        runtimePin = 'exact build commit'
        clientLocalUpdate = $false
        publicUpstreamAllowed = $false
        delivery = 'new enterprise desktop package'
    }
    distribution = [ordered]@{
        supportedPlatforms = @('windows')
        releaseClass = if ($gitDirty) { 'internal-pilot-dirty' } else { 'internal-pilot-unsigned' }
        codeSigning = 'unsigned'
        productionRequirement = 'authorized commit, clean worktree, enterprise code signing, rebuild, and verification'
        offlineFirstLaunch = [bool]$offlineRuntimeManifest
        githubRequiredForFirstLaunch = -not [bool]$offlineRuntimeManifest
        offlineRuntime = if ($offlineRuntimeManifest) {
            [ordered]@{
                schemaVersion = $offlineRuntimeManifest.schemaVersion
                commit = $offlineRuntimeManifest.commit
                version = $offlineRuntimeManifest.version
                platform = $offlineRuntimeManifest.platform
                arch = $offlineRuntimeManifest.arch
                fileCount = $offlineRuntimeManifest.fileCount
                bytesBeforeManifest = $offlineRuntimeManifest.bytesBeforeManifest
            }
        } else { $null }
    }
    artifacts = $artifactEntries
}
$manifestPath = Join-Path $outputRoot 'manifest.json'
[System.IO.File]::WriteAllText(
    $manifestPath,
    (($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)

$checksumFiles = @(
    Get-ChildItem -LiteralPath $outputRoot -Recurse -File |
        Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
        Sort-Object FullName
)
$checksumLines = @($checksumFiles | ForEach-Object {
    $relative = [System.IO.Path]::GetRelativePath($outputRoot, $_.FullName).Replace('\', '/')
    "{0} *{1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
})
[System.IO.File]::WriteAllLines(
    (Join-Path $outputRoot 'SHA256SUMS.txt'),
    $checksumLines,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Hermes Enterprise Desktop distribution published: $outputRoot"
Write-Host "Runtime artifacts: $($artifactEntries.Count)"
Write-Host 'Desktop distribution contains no CorpId, AgentId, CorpSecret, service token, OAuth code, or signing private key.'
