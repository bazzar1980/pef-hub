<#
  Trusts the PEF Hub local CA so Chrome/Edge accept wss://127.0.0.1:<port>.
  Default: current user store (shows a Windows confirmation prompt).
  -Machine: LocalMachine store (admin, silent) - use this from MSI/Intune.

  .\install-ca.ps1
  .\install-ca.ps1 -CaPath C:\pef-hub\certs\customer\ca.crt -Machine
#>
param(
  [string]$CaPath = (Join-Path $PSScriptRoot "..\..\certs\test\ca.crt"),
  [switch]$Machine
)
$store = if ($Machine) { "Cert:\LocalMachine\Root" } else { "Cert:\CurrentUser\Root" }
$cert = Import-Certificate -FilePath (Resolve-Path $CaPath) -CertStoreLocation $store
Write-Host "Trusted in $store" -ForegroundColor Green
$cert | Format-List Subject, Thumbprint, NotAfter
