param([Parameter(Mandatory = $true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
$updatePlanPath = [IO.Path]::GetFullPath($PlanPath)
$updateHelperPath = [IO.Path]::Combine($PSScriptRoot, 'apply-update.ps1')
if (-not [IO.File]::Exists($updatePlanPath) -or -not [IO.File]::Exists($updateHelperPath)) { exit 1 }
# Start a separate hidden console. Node's DETACHED_PROCESS makes Windows
# PowerShell exit before -File runs on some hosts; an attached worker can die
# with its Node parent's console. This short launcher owns neither app lifetime.
$updateArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $updateHelperPath + '" -PlanPath "' + $updatePlanPath + '"'
$null = Start-Process -FilePath ([IO.Path]::Combine($PSHOME, 'powershell.exe')) -ArgumentList $updateArguments -WindowStyle Hidden -PassThru
