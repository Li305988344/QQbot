# Restart the whole QQ bridge stack cleanly.
# 1) stop leftover start.bat loops, bridge instances and DSH engines
# 2) start the DSH engine on 127.0.0.1:3080 (needed by the bridge)
# 3) start exactly one bridge via start.bat
#
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'SilentlyContinue'

$root = 'D:\QQbot'
$bridgeDir = Join-Path $root 'qq-bridge-01'
# Only DSH engine source: the CLI shipped inside deepseek_harness.
# (The old dsh-engine/ standalone copy was @deepseek-ai/dsh@0.2.1-rc.2, never started, now deleted.)
$dshCli = Join-Path $root 'deepseek_harness\resources\runtime\cli\bin\dsh.cmd'
$lockFile = Join-Path $bridgeDir 'state\bridge.lock'

Write-Host '[reset] stopping leftovers...'
$all = Get-CimInstance Win32_Process
foreach ($p in $all) {
    if ($null -eq $p.CommandLine) { continue }
    if ($p.Name -eq 'cmd.exe' -and $p.CommandLine -match 'start\.bat') {
        Stop-Process -Id $p.ProcessId -Force
    }
}
Start-Sleep -Milliseconds 800
$all = Get-CimInstance Win32_Process
foreach ($p in $all) {
    if ($null -eq $p.CommandLine) { continue }
    if ($p.Name -eq 'node.exe' -and ($p.CommandLine -match 'bridge\.js' -or $p.CommandLine -match 'dsh-desktop-host')) {
        Stop-Process -Id $p.ProcessId -Force
    }
}
Start-Sleep -Milliseconds 1500
if (Test-Path $lockFile) { Remove-Item $lockFile -Force }

# Start DSH engine on the fixed port the bridge expects.
$listening = $false
try {
    $probe = New-Object System.Net.Sockets.TcpClient
    $probe.Connect('127.0.0.1', 3080)
    $listening = $probe.Connected
    $probe.Close()
} catch { $listening = $false }

if (-not $listening) {
    Write-Host '[reset] starting DSH engine on 127.0.0.1:3080 ...'
    $env:DSH_HOME = 'C:\Users\Administrator\.dsh'
    Start-Process -FilePath $dshCli -ArgumentList @('web', '--host', '127.0.0.1', '--port', '3080', '--no-open') -WindowStyle Hidden -WorkingDirectory $root
    Start-Sleep -Seconds 10
} else {
    Write-Host '[reset] DSH engine already listening on 3080'
}

Write-Host '[reset] starting bridge...'
Start-Process -FilePath (Join-Path $bridgeDir 'start.bat') -WorkingDirectory $bridgeDir
Start-Sleep -Seconds 6

Write-Host '[reset] ----- port check -----'
foreach ($port in 3000, 3001, 3080, 3100) {
    $ok = $false
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $port)
        $ok = $c.Connected
        $c.Close()
    } catch { $ok = $false }
    Write-Host ("{0}: {1}" -f $port, $(if ($ok) { 'LISTENING' } else { 'closed' }))
}

Write-Host '[reset] ----- bridge log tail -----'
Get-Content (Join-Path $bridgeDir 'state\bridge.log') -Tail 12
