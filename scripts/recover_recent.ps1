# Read shortcut metadata only. A shortcut timestamp is not a playback timestamp.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$entries = New-Object 'System.Collections.Generic.List[object]'
$warnings = New-Object 'System.Collections.Generic.List[string]'
$limit = 50000
$shell = $null

try {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        $warnings.Add('Windows 최근 항목 폴더를 찾을 수 없습니다.')
    } else {
        $recentDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Recent'
        if (-not (Test-Path -LiteralPath $recentDirectory -PathType Container)) {
            $warnings.Add('Windows 최근 항목 폴더가 없습니다. 이전 실행 기록이 저장되지 않았을 수 있습니다.')
        } else {
            # Never recurse into automatic/custom destination databases or open targets.
            $links = @(Get-ChildItem -LiteralPath $recentDirectory -Filter '*.lnk' -File |
                Select-Object -First ($limit + 1))
            if ($links.Count -gt $limit) {
                $warnings.Add('Windows 최근 항목이 50,000개를 넘어 처음 50,000개만 확인했습니다.')
                $links = @($links | Select-Object -First $limit)
            }
            $shell = New-Object -ComObject WScript.Shell
            $unreadable = 0
            foreach ($link in $links) {
                try {
                    # CreateShortcut loads an existing .lnk. Do not call Save or execute it.
                    $shortcut = $shell.CreateShortcut($link.FullName)
                    $target = [string]$shortcut.TargetPath
                    if (-not [string]::IsNullOrWhiteSpace($target)) {
                        $entries.Add([pscustomobject]@{
                            path = $target
                            observedAt = $link.LastWriteTimeUtc.ToString('o')
                            sourcePath = $link.FullName
                        })
                    }
                    if ([System.Runtime.InteropServices.Marshal]::IsComObject($shortcut)) {
                        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
                    }
                } catch {
                    $unreadable++
                }
            }
            if ($unreadable -gt 0) {
                $warnings.Add(('읽을 수 없는 최근 항목 {0}개를 건너뛰었습니다.' -f $unreadable))
            }
        }
    }
} catch {
    # Do not expose filesystem paths or raw PowerShell/COM errors.
    $warnings.Add('Windows 최근 항목을 모두 읽지 못했습니다. 확인된 항목만 표시합니다.')
} finally {
    if ($null -ne $shell -and [System.Runtime.InteropServices.Marshal]::IsComObject($shell)) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
}

$result = @{ entries = @($entries.ToArray()); warnings = @($warnings.ToArray()) }
[Console]::WriteLine(($result | ConvertTo-Json -Depth 4 -Compress))
