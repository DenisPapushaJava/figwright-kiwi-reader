param([string]$RepoRoot, [string]$TestRoot, [string]$NodePath, [string]$Scenario)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Write-Json([string]$Path, [object]$Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}
function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
$bundle = Join-Path $TestRoot 'bundle'
$install = Join-Path $TestRoot 'installed'
$plugin = Join-Path $TestRoot 'plugins/fl'
$marketplace = Join-Path $TestRoot 'marketplace.json'
$cursor = Join-Path $TestRoot 'cursor.json'
$server = Join-Path $bundle 'server'
New-Item -ItemType Directory -Force -Path $server, $install | Out-Null
foreach ($entry in @('mcp.mjs', 'stdio-proxy.mjs', 'hub.mjs')) {
  [IO.File]::WriteAllText((Join-Path $server $entry), '')
}
Copy-Item (Join-Path $RepoRoot 'packages/kiwi-reader/dist/client-config.mjs') $server
Copy-Item (Join-Path $RepoRoot 'packages/kiwi-reader/release/install.ps1') $bundle
Copy-Item (Join-Path $RepoRoot 'packages/kiwi-reader/release/uninstall.ps1') $bundle
Copy-Item (Join-Path $RepoRoot 'packages/kiwi-reader/release/codex-plugin') $bundle -Recurse
New-Item -ItemType Directory (Join-Path $bundle 'extension') | Out-Null
[IO.File]::WriteAllText((Join-Path $bundle 'VERSION'), '0.6.0')
$oldProxy = Join-Path $TestRoot 'old/proxy.mjs'
$global:FakeClaude = @{ other = 'unrelated' }
$global:CodexCalls = @()
$cursorServers = @{ other = @{ command = 'unrelated' } }
$marketplacePlugins = @(@{ name = 'other'; source = @{ path = './plugins/other' } })
if ($Scenario -ne 'fresh') {
  $previous = @{
    installDir = $install; pluginDir = (Join-Path $TestRoot 'plugins/fk')
    marketplacePath = $marketplace; cursorConfigPath = $cursor
    nodeCommand = $NodePath; proxyEntry = $oldProxy
    clients = @('Codex', 'Cursor', 'ClaudeCode'); codexPluginSelector = 'fk@personal'
  }
  Write-Json (Join-Path $install 'install-state.json') $previous
  $cursorServers.fk = @{ command = $NodePath; args = @($oldProxy) }
  $global:FakeClaude.fk = $oldProxy
  $marketplacePlugins += @{ name = 'fk'; source = @{ path = './plugins/fk' } }
}
if ($Scenario -eq 'foreign') {
  $cursorServers.fk = @{ command = 'foreign'; args = @('foreign') }
  $global:FakeClaude.fk = 'foreign'
  $marketplacePlugins[1].source.path = './custom/fk'
}
if ($Scenario -eq 'conflict') {
  $cursorServers.fl = @{ command = 'foreign'; args = @('foreign') }
}
Write-Json $cursor @{ theme = 'dark'; mcpServers = $cursorServers }
Write-Json $marketplace @{ name = 'personal'; plugins = $marketplacePlugins }
function Get-Command {
  [CmdletBinding()] param([string]$Name)
  switch ($Name) {
    'node' { return [pscustomobject]@{ Source = $NodePath } }
    'claude' { return [pscustomobject]@{ Source = 'Invoke-FakeClaude' } }
    'codex' { return [pscustomobject]@{ Source = 'Invoke-FakeCodex' } }
    default { return Microsoft.PowerShell.Core\Get-Command $Name }
  }
}
function Invoke-FakeClaude {
  $global:LASTEXITCODE = 0
  switch ($args[1]) {
    'get' {
      if ($global:FakeClaude.ContainsKey($args[2])) { return $global:FakeClaude[$args[2]] }
      $global:LASTEXITCODE = 1
    }
    'remove' { $global:FakeClaude.Remove($args[2]) }
    'add-json' {
      $config = $args[5] | ConvertFrom-Json
      $global:FakeClaude[$args[4]] = $config.args[0]
    }
    default { throw "Unexpected Claude call: $args" }
  }
}
function Invoke-FakeCodex {
  $global:LASTEXITCODE = 0
  $global:CodexCalls += ($args -join ' ')
}
function Start-Process {
  [CmdletBinding()] param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle,
    [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
  return [pscustomobject]@{ HasExited = $false; Id = 12345; StartTime = [DateTime]::Now }
}
function Get-Process { [CmdletBinding()] param($Id) }
function Invoke-RestMethod { param($Uri, $TimeoutSec) return @{ ok = $true } }
$arguments = @{
  InstallDir = $install; PluginDir = $plugin; MarketplacePath = $marketplace
  CursorConfigPath = $cursor
}
if ($Scenario -eq 'partial') { $arguments.Clients = @('Cursor') }
$before = [IO.File]::ReadAllText($cursor)
if ($Scenario -eq 'conflict') {
  $failed = $false
  try { & (Join-Path $bundle 'install.ps1') @arguments } catch {
    Assert ($_.Exception.Message -match 'preflight failed') 'Unexpected conflict failure'
    $failed = $true
  }
  Assert $failed 'Installation overwrote foreign fl'
  Assert ([IO.File]::ReadAllText($cursor) -eq $before) 'Conflict modified Cursor config'
  Assert ($global:CodexCalls.Count -eq 0) 'Conflict modified Codex'
  Write-Output 'FIGLENS_INSTALLER_OK'
  exit 0
}
& (Join-Path $bundle 'install.ps1') @arguments
& (Join-Path $bundle 'install.ps1') @arguments
$state = Get-Content -Raw (Join-Path $install 'install-state.json') | ConvertFrom-Json
$currentCursor = Get-Content -Raw $cursor | ConvertFrom-Json
Assert ($currentCursor.theme -eq 'dark') 'Unrelated setting lost'
Assert ($currentCursor.mcpServers.fl.args[0] -eq $state.proxyEntry) 'Cursor fl missing'
Assert ($state.cursorServerName -eq 'fl') 'Cursor name not recorded'
$hasFk = $null -ne $currentCursor.mcpServers.PSObject.Properties['fk']
Assert ($hasFk -eq ($Scenario -eq 'foreign')) 'Wrong legacy Cursor ownership'
if ($Scenario -eq 'partial') {
  Assert ($state.claudeServerName -eq 'fk') 'Unselected Claude name changed'
  Assert ($state.codexPluginSelector -eq 'fk@personal') 'Unselected Codex selector changed'
} else {
  Assert ($state.claudeServerName -eq 'fl') 'Claude name not recorded'
  Assert ($global:FakeClaude.ContainsKey('fl')) 'Claude fl missing'
  Assert ($global:FakeClaude.ContainsKey('fk') -eq ($Scenario -eq 'foreign')) 'Wrong legacy Claude ownership'
  Assert ($state.codexPluginSelector -eq 'fl@personal') 'Wrong Codex selector'
  $plugins = @( (Get-Content -Raw $marketplace | ConvertFrom-Json).plugins )
  Assert (@($plugins | Where-Object name -eq 'fl').Count -eq 1) 'Codex fl missing or duplicated'
  Assert (@($plugins | Where-Object name -eq 'fk').Count -eq [int]($Scenario -eq 'foreign')) 'Wrong legacy marketplace ownership'
  $manifest = Get-Content -Raw (Join-Path $plugin '.codex-plugin/plugin.json') | ConvertFrom-Json
  Assert ($manifest.name -eq 'fl') 'Wrong plugin name'
  $mcp = Get-Content -Raw (Join-Path $plugin '.mcp.json') | ConvertFrom-Json
  Assert ($null -ne $mcp.mcpServers.PSObject.Properties['fl']) 'Wrong plugin MCP name'
}
& (Join-Path $install 'uninstall.ps1') -InstallDir $install
$currentCursor = Get-Content -Raw $cursor | ConvertFrom-Json
Assert ($null -eq $currentCursor.mcpServers.PSObject.Properties['fl']) 'Cursor fl not removed'
Assert ($null -ne $currentCursor.mcpServers.PSObject.Properties['other']) 'Unrelated Cursor removed'
Assert (-not $global:FakeClaude.ContainsKey('fl')) 'Claude fl not removed'
Assert ($global:FakeClaude.ContainsKey('other')) 'Unrelated Claude removed'
Assert ($global:FakeClaude.ContainsKey('fk') -eq ($Scenario -eq 'foreign')) 'Foreign Claude not preserved'
$plugins = @((Get-Content -Raw $marketplace | ConvertFrom-Json).plugins)
Assert (@($plugins | Where-Object name -eq 'other').Count -eq 1) 'Unrelated plugin removed'
Assert (@($plugins | Where-Object name -eq 'fk').Count -eq [int]($Scenario -eq 'foreign')) 'Foreign plugin not preserved'
Assert (-not (Test-Path $install)) 'Installation not removed'
Write-Output 'FIGLENS_INSTALLER_OK'
