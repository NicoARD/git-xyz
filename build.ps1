# Packages the extension into a .vsix. Add -Install to also install it into VS Code.
param([switch]$Install)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

npm install --omit=dev
if ($LASTEXITCODE) { throw 'npm install failed' }

npx --yes @vscode/vsce package --allow-missing-repository --skip-license
if ($LASTEXITCODE) { throw 'vsce package failed' }

$vsix = Get-ChildItem -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "Built $($vsix.Name)"

if ($Install) {
  code --install-extension $vsix.FullName --force
  if ($LASTEXITCODE) { throw 'code --install-extension failed' }
  Write-Host 'Installed. Reload VS Code to pick it up.'
}
