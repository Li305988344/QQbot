# stop-loops.ps1 -- stop every leftover start.bat loop and bridge instance.
# ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'SilentlyContinue'

$all = Get-CimInstance Win32_Process
foreach ($p in $all) {
    if ($null -eq $p.CommandLine) { continue }
    $isLoop = ($p.Name -eq 'cmd.exe') -and ($p.CommandLine -match 'start\.bat')
    $isBridge = ($p.Name -eq 'node.exe') -and ($p.CommandLine -match 'bridge\.js')
    if ($isLoop -or $isBridge) {
        Write-Host ('[stop-loops] kill {0} pid={1}' -f $p.Name, $p.ProcessId)
        Stop-Process -Id $p.ProcessId -Force
    }
}

Start-Sleep -Milliseconds 1500
Remove-Item 'D:\QQbot\qq-bridge-01\state\bridge.lock' -Force
Write-Host '[stop-loops] done'
