# ensure-dsh.ps1 -- make sure a DSH engine is listening on 127.0.0.1:3080.
#
# qq-bridge talks to DSH over a fixed address (config.json -> dsh.baseUrl).
# The DSH desktop app spawns its engine on a random port, so that engine can
# never be used by the bridge. This script starts a detached engine that serves
# the *same* DSH home, which keeps the user's API key, sessions, presets and MCP
# mounts.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'SilentlyContinue'

$port = 3080
$dshCli = 'D:\QQbot\deepseek_harness\resources\runtime\cli\bin\dsh.cmd'
$dshHome = Join-Path $env:USERPROFILE '.dsh'

function Test-Port([int]$p) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $p)
        $ok = $client.Connected
        $client.Close()
        return $ok
    } catch {
        return $false
    }
}

if (Test-Port $port) {
    Write-Host ('[ensure-dsh] port {0} already listening' -f $port)
    exit 0
}

if (-not (Test-Path $dshCli)) {
    Write-Host '[ensure-dsh] WARN: DSH CLI not found:'
    Write-Host ('            ' + $dshCli)
    Write-Host '[ensure-dsh] the bridge will start, but replies need a running DSH'
    exit 1
}

Write-Host ('[ensure-dsh] starting engine on 127.0.0.1:{0} (DSH_HOME={1})' -f $port, $dshHome)
$env:DSH_HOME = $dshHome
Start-Process -FilePath $dshCli `
    -ArgumentList @('web', '--host', '127.0.0.1', '--port', "$port", '--no-open') `
    -WindowStyle Hidden `
    -WorkingDirectory 'D:\QQbot'

$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
    if (Test-Port $port) {
        Write-Host '[ensure-dsh] engine is up'
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

Write-Host '[ensure-dsh] WARN: engine did not come up within 40s'
exit 1
