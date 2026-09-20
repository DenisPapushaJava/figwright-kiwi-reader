[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'FigwrightKiwi'),
  [string]$PluginDir = (Join-Path $HOME 'plugins\fk'),
  [string]$MarketplacePath = (Join-Path $HOME '.agents\plugins\marketplace.json'),
  [switch]$SkipCodexInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$bundleRoot = Split-Path -Parent $PSCommandPath
$serverEntry = Join-Path $bundleRoot 'server\mcp.mjs'
$proxyEntry = Join-Path $bundleRoot 'server\stdio-proxy.mjs'
$hubEntry = Join-Path $bundleRoot 'server\hub.mjs'
$extensionSource = Join-Path $bundleRoot 'extension'
$pluginSource = Join-Path $bundleRoot 'codex-plugin'
$versionFile = Join-Path $bundleRoot 'VERSION'
$statePath = Join-Path $InstallDir 'install-state.json'

foreach ($required in @($serverEntry, $proxyEntry, $hubEntry, $extensionSource, $pluginSource, $versionFile)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Release bundle is incomplete: $required is missing."
  }
}

$node = Get-Command node -ErrorAction Stop
$nodeVersion = (& $node.Source --version).TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 24) {
  throw 'Figwright Kiwi Reader requires Node.js 24 or newer.'
}

if (Test-Path -LiteralPath $statePath) {
  try {
    $previousState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $previousHub = [string]$previousState.hubEntry
    if ($previousHub) {
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object {
          $_.CommandLine -and
          $_.CommandLine.IndexOf($previousHub, [StringComparison]::OrdinalIgnoreCase) -ge 0
        } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
    }
  } catch {
    throw "Could not stop the previously installed Kiwi hub safely: $($_.Exception.Message)"
  }
}

$serverTarget = Join-Path $InstallDir 'server'
$extensionTarget = Join-Path $InstallDir 'extension'
New-Item -ItemType Directory -Force -Path $serverTarget, $extensionTarget | Out-Null
Copy-Item -Path (Join-Path $bundleRoot 'server\*') -Destination $serverTarget -Recurse -Force
Copy-Item -Path (Join-Path $extensionSource '*') -Destination $extensionTarget -Recurse -Force

$pluginTarget = $PluginDir
New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
Copy-Item -Path (Join-Path $pluginSource '*') -Destination $pluginTarget -Recurse -Force

$hubTarget = Join-Path $serverTarget 'hub.mjs'
$hubProcess = Start-Process -FilePath $node.Source -ArgumentList @("`"$hubTarget`"") `
  -WorkingDirectory $serverTarget -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $InstallDir 'hub.stdout.log') `
  -RedirectStandardError (Join-Path $InstallDir 'hub.stderr.log')
$hubReady = $false
for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
  if ($hubProcess.HasExited) {
    throw "Kiwi hub exited during startup with code $($hubProcess.ExitCode)."
  }
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:9225/health' -TimeoutSec 1
    if ($health.ok -eq $true) {
      $hubReady = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 200
  }
}
if (-not $hubReady) {
  Stop-Process -Id $hubProcess.Id -Force -ErrorAction SilentlyContinue
  throw 'Kiwi hub did not become healthy at http://127.0.0.1:9225/health.'
}

$mcp = [ordered]@{
  mcpServers = [ordered]@{
    fk = [ordered]@{
      command = $node.Source
      args = @((Join-Path $serverTarget 'stdio-proxy.mjs'))
      cwd = $InstallDir
      startup_timeout_sec = 120
      tool_timeout_sec = 120
      default_tools_approval_mode = 'auto'
    }
  }
}
Write-Utf8NoBom -Path (Join-Path $pluginTarget '.mcp.json') -Content ($mcp | ConvertTo-Json -Depth 10)

$version = (Get-Content -Raw -LiteralPath $versionFile).Trim()
$pluginManifestPath = Join-Path $pluginTarget '.codex-plugin\plugin.json'
$pluginManifest = Get-Content -Raw -LiteralPath $pluginManifestPath | ConvertFrom-Json
$pluginManifest.version = "$version+codex.local-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))"
Write-Utf8NoBom -Path $pluginManifestPath -Content ($pluginManifest | ConvertTo-Json -Depth 10)

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $MarketplacePath) | Out-Null
if (Test-Path -LiteralPath $MarketplacePath) {
  $marketplace = Get-Content -Raw -LiteralPath $MarketplacePath | ConvertFrom-Json
} else {
  $marketplace = [pscustomobject]@{
    name = 'personal'
    interface = [pscustomobject]@{ displayName = 'Personal' }
    plugins = @()
  }
}

$existingPlugins = @($marketplace.plugins | Where-Object { $_.name -ne 'fk' })
$fkEntry = [pscustomobject]@{
  name = 'fk'
  source = [pscustomobject]@{ source = 'local'; path = './plugins/fk' }
  policy = [pscustomobject]@{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
  category = 'Productivity'
}
$marketplace.plugins = @($existingPlugins) + @($fkEntry)
Write-Utf8NoBom -Path $MarketplacePath -Content ($marketplace | ConvertTo-Json -Depth 10)

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($SkipCodexInstall) {
  Write-Host 'Codex plugin registration skipped.'
} elseif ($null -ne $codex) {
  & $codex.Source plugin add "fk@$($marketplace.name)" --json
  if ($LASTEXITCODE -ne 0) { throw 'Codex plugin installation failed.' }
} else {
  Write-Warning 'Codex CLI was not found in PATH. The plugin source is ready, but must be installed later.'
}

$state = [ordered]@{
  version = $version
  installedAt = [DateTime]::UtcNow.ToString('o')
  extensionPath = $extensionTarget
  serverEntry = (Join-Path $serverTarget 'mcp.mjs')
  proxyEntry = (Join-Path $serverTarget 'stdio-proxy.mjs')
  hubEntry = (Join-Path $serverTarget 'hub.mjs')
  hubPid = $hubProcess.Id
}
Write-Utf8NoBom -Path $statePath -Content ($state | ConvertTo-Json)

Write-Host ''
Write-Host "Figwright Kiwi Reader $version installed."
Write-Host "Chrome extension: $extensionTarget"
Write-Host "Shared MCP hub: $(Join-Path $serverTarget 'hub.mjs')"
Write-Host 'Open chrome://extensions, enable Developer mode, choose Load unpacked, and select that folder.'
Write-Host 'Restart Codex, then use: @fk read the selected frame'
