param([Parameter(Mandatory = $true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
$updatePlanPath = [IO.Path]::GetFullPath($PlanPath)
$updateStatusPath = $updatePlanPath + '.status.json'
$updateCancelPath = $updatePlanPath + '.cancel'
$updatePlan = $null
$updateChild = $null
$updateMovedOld = $false
$updateHealthy = $false
$updateParentExited = $false

function Write-UpdateStatus([string]$phase, [string]$message = '') {
    $payload = @{ token = $updatePlan.token; phase = $phase; message = $message; version = $updatePlan.version; childPid = $(if ($updateChild) { $updateChild.Id } else { 0 }) }
    $temporary = $updateStatusPath + '.tmp'
    [IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $updateStatusPath -Force
}

function Assert-UpdateFile([string]$filename, [string]$expectedHash, [long]$expectedSize = 0) {
    $item = Get-Item -LiteralPath $filename
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid update file.' }
    if ($expectedSize -gt 0 -and $item.Length -ne $expectedSize) { throw 'Unexpected update size.' }
    $stream = [IO.File]::OpenRead($filename)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
    if ($actualHash -ne $expectedHash) { throw 'Update checksum mismatch.' }
}

function Read-AppInfo {
    Invoke-RestMethod -UseBasicParsing -Uri ('http://127.0.0.1:' + $updatePlan.port + '/api/app-info') -TimeoutSec 2
}

function Start-UpdateApp {
    # Inherit the parent's fixed data directory, ports and bootstrap token.
    # pkg marks children so its own executable can act as a Node interpreter.
    # A replacement app must use its bundled default entrypoint instead.
    [Environment]::SetEnvironmentVariable('PKG_EXECPATH', $null, [EnvironmentVariableTarget]::Process)
    Start-Process -FilePath $updatePlan.targetPath -WorkingDirectory ([IO.Path]::GetDirectoryName($updatePlan.targetPath)) -WindowStyle Hidden -PassThru
}

try {
    $planItem = Get-Item -LiteralPath $updatePlanPath
    if ($planItem.Length -gt 16384 -or $planItem.PSIsContainer -or ($planItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid update plan.' }
    $updatePlan = [IO.File]::ReadAllText($updatePlanPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($updatePlan.schemaVersion -ne 1 -or $updatePlan.token -cnotmatch '^[a-f0-9]{32}$' -or $updatePlan.version -cnotmatch '^\d+\.\d+\.\d+$' -or $updatePlan.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $updatePlan.oldSha256 -cnotmatch '^[a-f0-9]{64}$' -or $updatePlan.storeId -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid update identity.' }
    if ([int]$updatePlan.port -lt 1 -or [int]$updatePlan.port -gt 65535 -or [int]$updatePlan.parentPid -lt 1 -or [long]$updatePlan.sizeBytes -lt 2 -or [long]$updatePlan.sizeBytes -gt 188743680) { throw 'Invalid update bounds.' }
    foreach ($field in @('targetPath', 'stagePath', 'dataDir', 'nextPath', 'backupPath')) {
        $value = [string]$updatePlan.$field
        if (-not [IO.Path]::IsPathRooted($value) -or [IO.Path]::GetFullPath($value) -ine $value) { throw 'Invalid absolute update path.' }
    }
    $stageRoot = [IO.Path]::Combine($updatePlan.dataDir, 'app-updates') + [IO.Path]::DirectorySeparatorChar
    if (-not $updatePlan.stagePath.StartsWith($stageRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Update escaped its staging folder.' }
    if ([IO.Path]::GetExtension($updatePlan.targetPath) -ine '.exe' -or $updatePlan.targetPath -ieq $updatePlan.stagePath) { throw 'Invalid update target.' }
    if ($updatePlan.nextPath -ine ($updatePlan.targetPath + '.updating-' + $updatePlan.token + '.exe') -or $updatePlan.backupPath -ine ($updatePlan.targetPath + '.previous-' + $updatePlan.token + '.exe')) { throw 'Invalid update backup paths.' }
    Assert-UpdateFile $updatePlan.stagePath $updatePlan.sha256 $updatePlan.sizeBytes
    Assert-UpdateFile $updatePlan.targetPath $updatePlan.oldSha256
    $parent = [Diagnostics.Process]::GetProcessById([int]$updatePlan.parentPid)
    if ($parent.MainModule.FileName -ine $updatePlan.targetPath) { throw 'The update parent is not this application.' }
    Write-UpdateStatus 'waiting-parent'
    while (-not $parent.WaitForExit(250)) {
        if (Test-Path -LiteralPath $updateCancelPath) { Write-UpdateStatus 'cancelled'; exit 0 }
    }
    $updateParentExited = $true
    if (Test-Path -LiteralPath $updateCancelPath) { Write-UpdateStatus 'cancelled'; exit 0 }
    # Never terminate the old application or replace an unverified file.
    Assert-UpdateFile $updatePlan.stagePath $updatePlan.sha256 $updatePlan.sizeBytes
    Assert-UpdateFile $updatePlan.targetPath $updatePlan.oldSha256
    Copy-Item -LiteralPath $updatePlan.stagePath -Destination $updatePlan.nextPath
    Assert-UpdateFile $updatePlan.nextPath $updatePlan.sha256 $updatePlan.sizeBytes
    Move-Item -LiteralPath $updatePlan.targetPath -Destination $updatePlan.backupPath
    $updateMovedOld = $true
    Move-Item -LiteralPath $updatePlan.nextPath -Destination $updatePlan.targetPath
    Write-UpdateStatus 'starting'
    $updateChild = Start-UpdateApp
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($updateChild.HasExited) { throw 'The new version exited during startup.' }
        try {
            $info = Read-AppInfo
            if ($info.application -eq 'videorandom' -and $info.version -eq $updatePlan.version -and $info.dataStoreId -eq $updatePlan.storeId -and $info.ready -eq $true -and $info.updating -eq $true) {
                $updateHealthy = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $updateHealthy) { throw 'The new version did not become ready.' }
    # Once activation may have started, never kill or roll back working jobs.
    # A lost activation response leaves the new application alive for retry.
    $activationSucceeded = $false
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            $body = @{ token = $updatePlan.token } | ConvertTo-Json -Compress
            $null = Invoke-RestMethod -UseBasicParsing -Uri ('http://127.0.0.1:' + $updatePlan.port + '/api/updates/complete') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
            $info = Read-AppInfo
            if ($info.version -eq $updatePlan.version -and $info.dataStoreId -eq $updatePlan.storeId -and $info.ready -eq $true -and $info.updating -eq $false) { $activationSucceeded = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if ($activationSucceeded) { Write-UpdateStatus 'completed' }
    else { Write-UpdateStatus 'activation-needed' 'The new version is open; activation needs to be retried.' }
} catch {
    if ($updateParentExited -and -not $updateMovedOld -and -not $updateHealthy) {
        try {
            Assert-UpdateFile $updatePlan.targetPath $updatePlan.oldSha256
            $env:VIDEORANDOM_UPDATE_BOOTSTRAP = ''
            Write-UpdateStatus 'rolled-back' 'The previous version was preserved and restarted.'
            $updateChild = Start-UpdateApp
            Write-UpdateStatus 'rolled-back' 'The previous version was preserved and restarted.'
            exit 1
        } catch { }
    }
    if ($updateMovedOld -and -not $updateHealthy) {
        try {
            # This is only the bootstrap child created above. The old parent
            # was allowed to finish normally and is never killed by this helper.
            if ($updateChild -and -not $updateChild.HasExited) { $updateChild.Kill(); $null = $updateChild.WaitForExit(10000) }
            if (Test-Path -LiteralPath $updatePlan.targetPath) {
                Assert-UpdateFile $updatePlan.targetPath $updatePlan.sha256 $updatePlan.sizeBytes
                Remove-Item -LiteralPath $updatePlan.targetPath
            }
            Assert-UpdateFile $updatePlan.backupPath $updatePlan.oldSha256
            Move-Item -LiteralPath $updatePlan.backupPath -Destination $updatePlan.targetPath
            $env:VIDEORANDOM_UPDATE_BOOTSTRAP = ''
            Write-UpdateStatus 'rolled-back' 'The previous version was restored.'
            $updateChild = Start-UpdateApp
            Write-UpdateStatus 'rolled-back' 'The previous version was restored.'
            exit 1
        } catch { }
    }
    if ($updatePlan) { Write-UpdateStatus 'error' 'The update could not finish. Existing data and verified backups are preserved.' }
    exit 1
}
