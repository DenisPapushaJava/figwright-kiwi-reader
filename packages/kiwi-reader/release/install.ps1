[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'FigwrightKiwi'),
  [string]$PluginDir = (Join-Path $HOME 'plugins\fk'),
  [string]$MarketplacePath = (Join-Path $HOME '.agents\plugins\marketplace.json'),
  [string]$CursorConfigPath = (Join-Path $HOME '.cursor\mcp.json'),
  [ValidateSet('Codex', 'Cursor', 'ClaudeCode')]
  [string[]]$Clients = @('Codex', 'Cursor', 'ClaudeCode'),
  [switch]$SkipCodexInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-OptionalProperty {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Test-SelectedClient {
  param([string]$Name)
  return $Clients -contains $Name
}

function Stop-RecordedHub {
  param([object]$State)
  $hubPid = Get-OptionalProperty $State 'hubPid'
  if ($null -eq $hubPid) { return }
  $process = Get-Process -Id ([int]$hubPid) -ErrorAction SilentlyContinue
  if ($null -eq $process) { return }
  if ($process.ProcessName -ne 'node') {
    throw "Recorded hub PID $hubPid now belongs to $($process.ProcessName)."
  }
  $expectedNode = [string](Get-OptionalProperty $State 'nodeCommand')
  if ($expectedNode -and $process.Path -and
    [IO.Path]::GetFullPath($process.Path) -ne [IO.Path]::GetFullPath($expectedNode)) {
    throw "Recorded hub PID $hubPid now uses a different Node.js executable."
  }
  $expectedStart = Get-OptionalProperty $State 'hubStartedAt'
  $maximumStartDelta = 2
  if ($null -eq $expectedStart) {
    $expectedStart = Get-OptionalProperty $State 'installedAt'
    $maximumStartDelta = 60
  }
  if ($null -ne $expectedStart) {
    $expectedStartUtc = if ($expectedStart -is [DateTime]) {
      $expectedStart.ToUniversalTime()
    } else {
      [DateTime]::Parse(
        [string]$expectedStart,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
      ).ToUniversalTime()
    }
    $delta = [Math]::Abs(
      ($process.StartTime.ToUniversalTime() - $expectedStartUtc).TotalSeconds
    )
    if ($delta -gt $maximumStartDelta) {
      throw "Recorded hub PID $hubPid was reused by another process."
    }
  } else {
    throw 'The previous hub process cannot be identified safely from the installation state.'
  }
  Stop-Process -Id $process.Id -Force -ErrorAction Stop
  $process.WaitForExit(5000) | Out-Null
}

$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$PluginDir = [IO.Path]::GetFullPath($PluginDir)
$MarketplacePath = [IO.Path]::GetFullPath($MarketplacePath)
$CursorConfigPath = [IO.Path]::GetFullPath($CursorConfigPath)

$bundleRoot = Split-Path -Parent $PSCommandPath
$serverEntry = Join-Path $bundleRoot 'server\mcp.mjs'
$proxyEntry = Join-Path $bundleRoot 'server\stdio-proxy.mjs'
$hubEntry = Join-Path $bundleRoot 'server\hub.mjs'
$clientConfigEntry = Join-Path $bundleRoot 'server\client-config.mjs'
$extensionSource = Join-Path $bundleRoot 'extension'
$pluginSource = Join-Path $bundleRoot 'codex-plugin'
$uninstallerSource = Join-Path $bundleRoot 'uninstall.ps1'
$versionFile = Join-Path $bundleRoot 'VERSION'
$statePath = Join-Path $InstallDir 'install-state.json'

foreach ($required in @(
  $serverEntry,
  $proxyEntry,
  $hubEntry,
  $clientConfigEntry,
  $extensionSource,
  $pluginSource,
  $uninstallerSource,
  $versionFile
)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Release bundle is incomplete: $required is missing."
  }
}

$node = Get-Command node -ErrorAction Stop
$nodeVersion = (& $node.Source --version).TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 24) {
  throw 'FigLens requires Node.js 24 or newer.'
}

$previousState = $null
if (Test-Path -LiteralPath $statePath) {
  try {
    $previousState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  } catch {
    throw "Could not read the previous FigLens installation safely: $($_.Exception.Message)"
  }
}

$previousClients = @(Get-OptionalProperty $previousState 'clients')
$previousNodeCommand = [string](Get-OptionalProperty $previousState 'nodeCommand')
$previousProxyEntry = [string](Get-OptionalProperty $previousState 'proxyEntry')
$serverTarget = Join-Path $InstallDir 'server'
$extensionTarget = Join-Path $InstallDir 'extension'
$proxyTarget = Join-Path $serverTarget 'stdio-proxy.mjs'
$hubTarget = Join-Path $serverTarget 'hub.mjs'
$clientConfigTarget = Join-Path $serverTarget 'client-config.mjs'
$cursorOwnershipArgs = @($CursorConfigPath, 'fk', $node.Source, $proxyTarget)
if ($previousNodeCommand -and $previousProxyEntry -and ($previousClients -contains 'Cursor')) {
  $cursorOwnershipArgs += @($previousNodeCommand, $previousProxyEntry)
}
if (Test-SelectedClient 'Cursor') {
  & $node.Source $clientConfigEntry check @cursorOwnershipArgs
  if ($LASTEXITCODE -ne 0) { throw 'Cursor MCP configuration preflight failed.' }
}

$claude = $null
$existingClaude = ''
$existingClaudeCode = 1
if (Test-SelectedClient 'ClaudeCode') {
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if ($null -ne $claude) {
    $existingClaude = (& $claude.Source mcp get fk 2>&1 | Out-String)
    $existingClaudeCode = $LASTEXITCODE
    if ($existingClaudeCode -eq 0) {
      $ownedPrevious =
        ($previousClients -contains 'ClaudeCode') -and
        $previousProxyEntry -and
        ($existingClaude.IndexOf($previousProxyEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0)
      if (-not $ownedPrevious) {
        throw 'Claude Code already has an MCP server named fk that is not owned by FigLens.'
      }
    }
  }
}

if ((Test-SelectedClient 'Codex') -and -not $SkipCodexInstall -and
  (Test-Path -LiteralPath $MarketplacePath)) {
  $marketplacePreflight = Get-Content -Raw -LiteralPath $MarketplacePath | ConvertFrom-Json
  $existingFkEntries = @($marketplacePreflight.plugins | Where-Object { $_.name -eq 'fk' })
  foreach ($entry in $existingFkEntries) {
    $source = Get-OptionalProperty $entry 'source'
    $sourcePath = [string](Get-OptionalProperty $source 'path')
    if ($sourcePath -ne './plugins/fk') {
      throw 'Codex marketplace already has a plugin named fk that is not owned by FigLens.'
    }
  }
}

try {
  Stop-RecordedHub $previousState
} catch {
  throw "Could not replace the previous FigLens hub safely: $($_.Exception.Message)"
}

New-Item -ItemType Directory -Force -Path $serverTarget, $extensionTarget | Out-Null
Copy-Item -Path (Join-Path $bundleRoot 'server\*') -Destination $serverTarget -Recurse -Force
Copy-Item -Path (Join-Path $extensionSource '*') -Destination $extensionTarget -Recurse -Force
Copy-Item -LiteralPath $uninstallerSource -Destination (Join-Path $InstallDir 'uninstall.ps1') -Force

$pluginTarget = $PluginDir
New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
Copy-Item -Path (Join-Path $pluginSource '*') -Destination $pluginTarget -Recurse -Force

$hubPort = if ($env:FIGWRIGHT_KIWI_HUB_PORT) { $env:FIGWRIGHT_KIWI_HUB_PORT } else { '9225' }
$hubHealthUri = "http://127.0.0.1:$hubPort/health"
$hubProcess = Start-Process -FilePath $node.Source -ArgumentList @("`"$hubTarget`"") `
  -WorkingDirectory $serverTarget -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $InstallDir 'hub.stdout.log') `
  -RedirectStandardError (Join-Path $InstallDir 'hub.stderr.log')
$hubReady = $false
for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
  if ($hubProcess.HasExited) {
    throw "FigLens hub exited during startup with code $($hubProcess.ExitCode)."
  }
  try {
    $health = Invoke-RestMethod -Uri $hubHealthUri -TimeoutSec 1
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
  throw "FigLens hub did not become healthy at $hubHealthUri."
}

$mcp = [ordered]@{
  mcpServers = [ordered]@{
    fk = [ordered]@{
      command = $node.Source
      args = @($proxyTarget)
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

$installedClients = @($previousClients)
$codexPluginSelector = [string](Get-OptionalProperty $previousState 'codexPluginSelector')

if ((Test-SelectedClient 'Codex') -and -not $SkipCodexInstall) {
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
  if ($null -ne $codex) {
    $codexPluginSelector = "fk@$($marketplace.name)"
    & $codex.Source plugin add $codexPluginSelector --json
    if ($LASTEXITCODE -ne 0) { throw 'Codex plugin installation failed.' }
    $installedClients += 'Codex'
  } else {
    Write-Warning 'Codex CLI was not found in PATH. Its plugin source is ready for later installation.'
  }
} elseif ($SkipCodexInstall) {
  Write-Host 'Codex plugin registration skipped.'
}

if (Test-SelectedClient 'Cursor') {
  & $node.Source $clientConfigTarget install @cursorOwnershipArgs
  if ($LASTEXITCODE -ne 0) { throw 'Cursor MCP configuration failed.' }
  $installedClients += 'Cursor'
}

if (Test-SelectedClient 'ClaudeCode') {
  if ($null -eq $claude) {
    Write-Warning 'Claude Code CLI was not found in PATH. Its MCP server was not registered.'
  } else {
    if ($existingClaudeCode -eq 0) {
      & $claude.Source mcp remove fk --scope user
      if ($LASTEXITCODE -ne 0) { throw 'Could not update the previous Claude Code registration.' }
    }
    $claudeConfig = [ordered]@{
      type = 'stdio'
      command = $node.Source
      args = @($proxyTarget)
    } | ConvertTo-Json -Compress
    & $claude.Source mcp add-json --scope user fk $claudeConfig
    if ($LASTEXITCODE -ne 0) { throw 'Claude Code MCP configuration failed.' }
    $installedClients += 'ClaudeCode'
  }
}

$state = [ordered]@{
  version = $version
  installedAt = [DateTime]::UtcNow.ToString('o')
  installDir = $InstallDir
  pluginDir = $PluginDir
  marketplacePath = $MarketplacePath
  codexPluginSelector = $codexPluginSelector
  cursorConfigPath = $CursorConfigPath
  clients = @($installedClients | Sort-Object -Unique)
  nodeCommand = $node.Source
  extensionPath = $extensionTarget
  serverEntry = (Join-Path $serverTarget 'mcp.mjs')
  proxyEntry = $proxyTarget
  hubEntry = $hubTarget
  clientConfigEntry = $clientConfigTarget
  hubPort = $hubPort
  hubPid = $hubProcess.Id
  hubStartedAt = $hubProcess.StartTime.ToUniversalTime().ToString('o')
}
Write-Utf8NoBom -Path $statePath -Content ($state | ConvertTo-Json -Depth 10)

Write-Host ''
Write-Host "FigLens $version installed."
Write-Host "Chrome extension: $extensionTarget"
Write-Host "Shared MCP hub: $hubTarget"
Write-Host "Configured clients: $(@($state.clients) -join ', ')"
Write-Host 'Open chrome://extensions, enable Developer mode, choose Load unpacked, and select that folder.'
Write-Host 'Restart your MCP clients, then ask @fk to read the selected Figma frame.'
Write-Host "Clean uninstall: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'uninstall.ps1')`""
