[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'FigwrightKiwi')
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

function Assert-SafeDirectory {
  param([string]$Path, [string]$Marker)
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $root = [IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
  if (-not $fullPath -or $fullPath -eq $root) {
    throw "Refusing to remove unsafe directory: $Path"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $fullPath $Marker))) {
    throw "Refusing to remove unverified directory: $fullPath"
  }
  return $fullPath
}

$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$statePath = Join-Path $InstallDir 'install-state.json'
if (-not (Test-Path -LiteralPath $statePath)) {
  throw "FigLens installation state was not found at $statePath."
}
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$recordedInstallDir = [string](Get-OptionalProperty $state 'installDir')
$nodeCommand = [string](Get-OptionalProperty $state 'nodeCommand')
if ($recordedInstallDir -and
  [IO.Path]::GetFullPath($recordedInstallDir) -ne [IO.Path]::GetFullPath($InstallDir)) {
  throw 'The requested directory does not match the directory recorded by FigLens.'
}

$clients = @(Get-OptionalProperty $state 'clients')
if ($clients.Count -eq 0) { $clients = @('Codex') }
$proxyEntry = [string](Get-OptionalProperty $state 'proxyEntry')

if ($clients -contains 'Cursor') {
  $cursorConfigPath = [string](Get-OptionalProperty $state 'cursorConfigPath')
  $clientConfigEntry = [string](Get-OptionalProperty $state 'clientConfigEntry')
  if ($cursorConfigPath -and $clientConfigEntry -and (Test-Path -LiteralPath $clientConfigEntry)) {
    $cursorResult = (& $nodeCommand $clientConfigEntry remove $cursorConfigPath fk $nodeCommand $proxyEntry).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cursor MCP cleanup failed.' }
    if ($cursorResult -eq 'changed') {
      Write-Warning 'Cursor MCP server fk was changed after installation and was preserved.'
    }
  }
}

if ($clients -contains 'ClaudeCode') {
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if ($null -eq $claude) {
    Write-Warning 'Claude Code CLI was not found; its MCP registration was preserved.'
  } else {
    $existingClaude = (& $claude.Source mcp get fk 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0) {
      if ($proxyEntry -and
        $existingClaude.IndexOf($proxyEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        & $claude.Source mcp remove fk --scope user
        if ($LASTEXITCODE -ne 0) { throw 'Claude Code MCP cleanup failed.' }
      } else {
        Write-Warning 'Claude Code MCP server fk was changed after installation and was preserved.'
      }
    }
  }
}

$marketplacePath = [string](Get-OptionalProperty $state 'marketplacePath')
if (($clients -contains 'Codex') -and $marketplacePath -and (Test-Path -LiteralPath $marketplacePath)) {
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  if ($null -ne $codex) {
    $codexPluginSelector = [string](Get-OptionalProperty $state 'codexPluginSelector')
    if (-not $codexPluginSelector) { $codexPluginSelector = 'fk@personal' }
    & $codex.Source plugin remove $codexPluginSelector --json
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'Codex did not remove the installed plugin; continuing with local cleanup.'
    }
  }
  $marketplace = Get-Content -Raw -LiteralPath $marketplacePath | ConvertFrom-Json
  $marketplace.plugins = @($marketplace.plugins | Where-Object {
    $source = Get-OptionalProperty $_ 'source'
    $sourcePath = [string](Get-OptionalProperty $source 'path')
    $_.name -ne 'fk' -or $sourcePath -ne './plugins/fk'
  })
  Write-Utf8NoBom -Path $marketplacePath -Content ($marketplace | ConvertTo-Json -Depth 10)
}

$hubPid = Get-OptionalProperty $state 'hubPid'
if ($null -ne $hubPid) {
  $hubProcess = Get-Process -Id ([int]$hubPid) -ErrorAction SilentlyContinue
  if ($null -ne $hubProcess) {
    if ($hubProcess.ProcessName -ne 'node') {
      throw "Recorded hub PID $hubPid now belongs to $($hubProcess.ProcessName)."
    }
    if ($nodeCommand -and $hubProcess.Path -and
      [IO.Path]::GetFullPath($hubProcess.Path) -ne [IO.Path]::GetFullPath($nodeCommand)) {
      throw "Recorded hub PID $hubPid now uses a different Node.js executable."
    }
    $expectedStart = Get-OptionalProperty $state 'hubStartedAt'
    $maximumStartDelta = 2
    if ($null -eq $expectedStart) {
      $expectedStart = Get-OptionalProperty $state 'installedAt'
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
        ($hubProcess.StartTime.ToUniversalTime() - $expectedStartUtc).TotalSeconds
      )
      if ($delta -gt $maximumStartDelta) {
        throw "Recorded hub PID $hubPid was reused by another process."
      }
    } else {
      throw 'The hub process cannot be identified safely from the installation state.'
    }
    Stop-Process -Id $hubProcess.Id -Force -ErrorAction Stop
    $hubProcess.WaitForExit(5000) | Out-Null
  }
}

$pluginDir = [string](Get-OptionalProperty $state 'pluginDir')
if ($pluginDir -and (Test-Path -LiteralPath $pluginDir)) {
  $safePluginDir = Assert-SafeDirectory $pluginDir '.codex-plugin\plugin.json'
  $pluginManifest = Get-Content -Raw -LiteralPath (Join-Path $safePluginDir '.codex-plugin\plugin.json') |
    ConvertFrom-Json
  if ($pluginManifest.name -ne 'fk') {
    throw "Refusing to remove plugin directory with unexpected identity: $safePluginDir"
  }
  Remove-Item -LiteralPath $safePluginDir -Recurse -Force
}

$safeInstallDir = Assert-SafeDirectory $InstallDir 'install-state.json'
Remove-Item -LiteralPath $safeInstallDir -Recurse -Force
Write-Host 'FigLens was removed. Restart Chrome and any MCP clients that were open.'
