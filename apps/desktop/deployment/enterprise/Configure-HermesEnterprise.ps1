[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GatewayUrl,

    [ValidateSet('Machine', 'User', 'Portable')]
    [string]$Scope = 'Machine',

    [string]$PortableDirectory
)

$ErrorActionPreference = 'Stop'

$uri = $null
if (-not [System.Uri]::TryCreate($GatewayUrl.Trim(), [System.UriKind]::Absolute, [ref]$uri)) {
    throw 'GatewayUrl must be an absolute URL.'
}
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) {
    throw 'GatewayUrl must use HTTPS. HTTP is allowed only for localhost rehearsal.'
}
if (-not [string]::IsNullOrEmpty($uri.UserInfo)) {
    throw 'GatewayUrl must not contain a username or password.'
}
if (-not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
    throw 'GatewayUrl must not contain a query string or fragment.'
}
if ($uri.AbsolutePath -ne '/') {
    throw 'GatewayUrl must be an origin without a path.'
}

switch ($Scope) {
    'Machine' {
        if (-not $env:ProgramData) { throw 'ProgramData is not available on this machine.' }
        $target = Join-Path $env:ProgramData 'Hermes\enterprise-desktop.json'
    }
    'User' {
        if (-not $env:APPDATA) { throw 'APPDATA is not available for this user.' }
        $target = Join-Path $env:APPDATA 'Hermes\enterprise\enterprise-desktop.json'
    }
    'Portable' {
        if (-not $PortableDirectory) { throw 'PortableDirectory is required when Scope is Portable.' }
        $target = Join-Path (Resolve-Path -LiteralPath $PortableDirectory) 'enterprise-desktop.json'
    }
}

$parent = Split-Path -Parent $target
[System.IO.Directory]::CreateDirectory($parent) | Out-Null
$config = [ordered]@{
    schemaVersion = 1
    enabled = $true
    gatewayUrl = $uri.GetLeftPart([System.UriPartial]::Authority)
}
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText($target, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

Write-Host "Hermes Enterprise Desktop configured: $target"
Write-Host "Gateway: $($config.gatewayUrl)"
Write-Host 'No CorpId, AgentId, CorpSecret, OAuth code, or access token is stored in this file.'
