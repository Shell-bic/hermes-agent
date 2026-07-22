[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$PythonHome = "$env:APPDATA\uv\python\cpython-3.11-windows-x86_64-none",
    [string]$GitHome = "$env:LOCALAPPDATA\Atlassian\SourceTree\git_local",
    [string]$NodeHome,
    [string]$UvPath = "$env:LOCALAPPDATA\hermes\bin\uv.exe",
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$desktopRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = (& git -C $desktopRoot rev-parse --show-toplevel).Trim()
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $desktopRoot 'build\offline-runtime'
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not $NodeHome) {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $NodeHome = Split-Path $nodeCommand.Source -Parent
}
$PythonHome = [System.IO.Path]::GetFullPath($PythonHome)
$GitHome = [System.IO.Path]::GetFullPath($GitHome)
$NodeHome = [System.IO.Path]::GetFullPath($NodeHome)
$UvPath = [System.IO.Path]::GetFullPath($UvPath)

$requiredInputs = @(
    (Join-Path $PythonHome 'python.exe'),
    (Join-Path $GitHome 'cmd\git.exe'),
    (Join-Path $GitHome 'bin\bash.exe'),
    (Join-Path $NodeHome 'node.exe'),
    (Join-Path $NodeHome 'npm.cmd'),
    (Join-Path $NodeHome 'node_modules\npm'),
    $UvPath
)
foreach ($required in $requiredInputs) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required offline runtime input is missing: $required"
    }
}

$trackedStatus = @(& git -C $repoRoot status --porcelain=v1 --untracked-files=no)
if ($trackedStatus.Count -gt 0) {
    throw 'Tracked files are modified. Commit the offline runtime implementation before building its immutable payload.'
}

if (Test-Path -LiteralPath $outputRoot) {
    if (-not $Force) {
        throw "Offline runtime output already exists. Pass -Force to replace it: $outputRoot"
    }
    Remove-Item -LiteralPath $outputRoot -Recurse -Force
}
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null

$runtimeRoot = Join-Path $outputRoot 'runtime'
$pythonTarget = Join-Path $outputRoot 'python'
$gitTarget = Join-Path $outputRoot 'git'
$nodeTarget = Join-Path $outputRoot 'node'
$archivePath = Join-Path ([System.IO.Path]::GetTempPath()) "hermes-offline-$([guid]::NewGuid().ToString('N')).tar"

try {
    $commit = (& git -C $repoRoot rev-parse HEAD).Trim()
    $branch = (& git -C $repoRoot branch --show-current).Trim()
    $package = Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json

    Write-Host "Staging Hermes source at $commit ..."
    & git -C $repoRoot archive --format=tar "--output=$archivePath" $commit
    if ($LASTEXITCODE -ne 0) { throw "git archive failed with exit code $LASTEXITCODE" }
    [System.IO.Directory]::CreateDirectory($runtimeRoot) | Out-Null
    & tar -xf $archivePath -C $runtimeRoot
    if ($LASTEXITCODE -ne 0) { throw "tar extraction failed with exit code $LASTEXITCODE" }

    Write-Host 'Copying portable Python 3.11 ...'
    Copy-Item -LiteralPath $PythonHome -Destination $pythonTarget -Recurse -Force

    Write-Host 'Creating relocatable Python environment from uv.lock ...'
    $venvRoot = Join-Path $runtimeRoot 'venv'
    $payloadPython = Join-Path $pythonTarget 'python.exe'
    $previousProjectEnvironment = $env:UV_PROJECT_ENVIRONMENT
    $previousRelocatable = $env:UV_VENV_RELOCATABLE
    $previousDownloads = $env:UV_PYTHON_DOWNLOADS
    try {
        $env:UV_PROJECT_ENVIRONMENT = $venvRoot
        $env:UV_VENV_RELOCATABLE = '1'
        $env:UV_PYTHON_DOWNLOADS = 'never'
        & $UvPath venv $venvRoot --python $payloadPython --relocatable
        if ($LASTEXITCODE -ne 0) { throw "uv venv failed with exit code $LASTEXITCODE" }
        & $UvPath sync --project $runtimeRoot --locked --extra all --no-install-project --python (Join-Path $venvRoot 'Scripts\python.exe')
        if ($LASTEXITCODE -ne 0) { throw "uv sync failed with exit code $LASTEXITCODE" }
    } finally {
        $env:UV_PROJECT_ENVIRONMENT = $previousProjectEnvironment
        $env:UV_VENV_RELOCATABLE = $previousRelocatable
        $env:UV_PYTHON_DOWNLOADS = $previousDownloads
    }

    & (Join-Path $venvRoot 'Scripts\python.exe') -c 'import fastapi,uvicorn,winpty,openai,pydantic;print(1)'
    if ($LASTEXITCODE -ne 0) { throw 'Offline Python runtime import probe failed.' }

    Write-Host 'Copying Git for Windows / Git Bash ...'
    Copy-Item -LiteralPath $GitHome -Destination $gitTarget -Recurse -Force

    Write-Host 'Staging portable Node.js and browser CLI ...'
    [System.IO.Directory]::CreateDirectory($nodeTarget) | Out-Null
    foreach ($fileName in @('node.exe', 'LICENSE', 'README.md', 'CHANGELOG.md', 'npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1')) {
        $source = Join-Path $NodeHome $fileName
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $nodeTarget $fileName) -Force
        }
    }
    [System.IO.Directory]::CreateDirectory((Join-Path $nodeTarget 'node_modules')) | Out-Null
    Copy-Item -LiteralPath (Join-Path $NodeHome 'node_modules\npm') -Destination (Join-Path $nodeTarget 'node_modules\npm') -Recurse -Force
    & (Join-Path $nodeTarget 'npm.cmd') install -g --prefix $nodeTarget --silent --ignore-scripts 'agent-browser@^0.26.0' '@askjo/camofox-browser@^1.5.2'
    if ($LASTEXITCODE -ne 0) { throw "npm browser payload install failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath (Join-Path $nodeTarget 'agent-browser.cmd'))) {
        throw 'npm completed but agent-browser.cmd was not staged.'
    }

    $criticalRelativePaths = @(
        'runtime/pyproject.toml',
        'runtime/hermes_cli/main.py',
        'runtime/venv/Scripts/python.exe',
        'runtime/venv/pyvenv.cfg',
        'python/python.exe',
        'git/cmd/git.exe',
        'git/bin/bash.exe',
        'node/node.exe',
        'node/agent-browser.cmd'
    )
    $criticalFiles = [ordered]@{}
    foreach ($relative in $criticalRelativePaths) {
        $fullPath = Join-Path $outputRoot $relative
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Critical offline payload file is missing: $relative"
        }
        $criticalFiles[$relative] = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    $payloadFiles = @(Get-ChildItem -LiteralPath $outputRoot -Recurse -File)
    $payloadBytes = ($payloadFiles | Measure-Object Length -Sum).Sum
    $manifest = [ordered]@{
        schemaVersion = 1
        product = 'Hermes Enterprise Offline Runtime'
        version = $package.version
        commit = $commit
        branch = $branch
        platform = 'win32'
        arch = 'x64'
        generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        firstLaunchNetworkRequired = $false
        components = [ordered]@{
            source = 'exact Git commit archive'
            python = 'portable CPython 3.11'
            dependencies = 'uv.lock + hermes-agent[all], preinstalled'
            git = 'Git for Windows with Git Bash'
            node = 'portable Node.js with agent-browser and camofox browser CLI'
        }
        fileCount = $payloadFiles.Count
        bytesBeforeManifest = $payloadBytes
        criticalFiles = $criticalFiles
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $outputRoot 'manifest.json'),
        (($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
        [System.Text.UTF8Encoding]::new($false)
    )

    Write-Host "Offline runtime staged: $outputRoot"
    Write-Host ("Payload: {0:N1} MiB across {1} files" -f ($payloadBytes / 1MB), $payloadFiles.Count)
} finally {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
}
