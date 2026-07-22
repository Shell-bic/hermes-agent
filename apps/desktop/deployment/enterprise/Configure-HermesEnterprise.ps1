[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GatewayUrl,

    [ValidateSet('Machine', 'User', 'Portable')]
    [string]$Scope = 'Machine',

    [string]$PortableDirectory,

    [switch]$AllowInsecureLanHttp
)

$ErrorActionPreference = 'Stop'

function Test-PrivateIpLiteral {
    param([Parameter(Mandatory = $true)][string]$HostName)

    $address = $null
    if (-not [System.Net.IPAddress]::TryParse($HostName, [ref]$address)) {
        return $false
    }

    $bytes = $address.GetAddressBytes()
    if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        return (
            $bytes[0] -eq 10 -or
            ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
        )
    }

    if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        return (($bytes[0] -band 0xFE) -eq 0xFC)
    }

    return $false
}

$uri = $null
if (-not [System.Uri]::TryCreate($GatewayUrl.Trim(), [System.UriKind]::Absolute, [ref]$uri)) {
    throw 'GatewayUrl must be an absolute URL.'
}
if ($uri.Scheme -notin @('http', 'https')) {
    throw 'GatewayUrl must use HTTP or HTTPS.'
}
if ($uri.Scheme -eq 'http' -and -not $uri.IsLoopback) {
    if (-not $AllowInsecureLanHttp) {
        throw 'Private IP HTTP requires -AllowInsecureLanHttp. Production GatewayUrl must use HTTPS.'
    }
    if (-not (Test-PrivateIpLiteral -HostName $uri.Host)) {
        throw 'AllowInsecureLanHttp accepts only an RFC1918 IPv4 or unique-local IPv6 literal.'
    }
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
    weComGatewayRunnerExperiment = $true
}
if ($AllowInsecureLanHttp) {
    $config.allowInsecureLanHttp = $true
}
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText($target, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

Write-Host "Hermes Enterprise Desktop configured: $target"
Write-Host "Gateway: $($config.gatewayUrl)"
if ($AllowInsecureLanHttp) {
    Write-Warning 'Private-network HTTP is enabled for internal rehearsal. Use HTTPS before production release.'
}
Write-Host 'No CorpId, AgentId, CorpSecret, OAuth code, or access token is stored in this file.'
