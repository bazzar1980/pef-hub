<#
  Removes PEF Hub local CAs by subject match.
  .\uninstall-ca.ps1                       # removes "PEF Hub TEST Local CA"
  .\uninstall-ca.ps1 -Subject "ACME*Local CA" -Machine
#>
param(
  [string]$Subject = "*PEF Hub TEST Local CA*",
  [switch]$Machine
)
$store = if ($Machine) { "Cert:\LocalMachine\Root" } else { "Cert:\CurrentUser\Root" }
Get-ChildItem $store | Where-Object { $_.Subject -like $Subject } | ForEach-Object {
  Write-Host "Removing $($_.Subject) [$($_.Thumbprint)]" -ForegroundColor Yellow
  Remove-Item $_.PSPath
}
