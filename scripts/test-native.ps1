# Smoke test for OneShellNative.exe: starts it, sends a few commands over stdin and checks the
# JSON answers, then closes stdin and makes sure the helper exits (and restores the taskbar).
$ErrorActionPreference = 'Stop'
$exe = Join-Path (Split-Path $PSScriptRoot -Parent) 'build\native\OneShellNative.exe'

$psi = New-Object System.Diagnostics.ProcessStartInfo $exe
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$p = [System.Diagnostics.Process]::Start($psi)

$script:nextId = 1
function Invoke-Helper([string]$cmd, $arguments = @{}) {
  $id = $script:nextId++
  $p.StandardInput.WriteLine((@{ id = $id; cmd = $cmd; args = $arguments } | ConvertTo-Json -Compress))
  $p.StandardInput.Flush()
  while ($true) {
    $task = $p.StandardOutput.ReadLineAsync()
    if (-not $task.Wait(15000)) { throw "timeout waiting for '$cmd'" }
    $line = $task.Result
    if ($null -eq $line) { throw "helper exited while waiting for '$cmd'" }
    $msg = $line | ConvertFrom-Json
    if ($msg.event) { Write-Host "  event: $($msg.event)"; continue }
    if ($msg.id -eq $id) { return $msg }
  }
}

function Assert-Ok($msg, [string]$what) {
  if (-not $msg.ok) { throw "$what failed: $($msg.error)" }
  Write-Host "ok   $what"
}

Assert-Ok (Invoke-Helper 'ping') 'ping'
$b = Invoke-Helper 'battery'; Assert-Ok $b 'battery'; Write-Host "     $($b.result | ConvertTo-Json -Compress)"
$w = Invoke-Helper 'listWindows'; Assert-Ok $w 'listWindows'; Write-Host "     $(@($w.result).Count) windows"
$i = Invoke-Helper 'icon' @{ path = (Join-Path $env:WINDIR 'notepad.exe') }; Assert-Ok $i 'icon'
if (-not ("$($i.result)".StartsWith('data:image/png;base64,'))) { throw 'icon did not return a PNG data URL' }
Assert-Ok (Invoke-Helper 'setHooks' @{ winKey = $true; winA = $true; winTab = $true }) 'setHooks'
Assert-Ok (Invoke-Helper 'setIgnorePids' @{ pids = @($PID) }) 'setIgnorePids'
Assert-Ok (Invoke-Helper 'foreground') 'foreground'
Assert-Ok (Invoke-Helper 'getDarkMode') 'getDarkMode'
Assert-Ok (Invoke-Helper 'hideTaskbar') 'hideTaskbar'
Assert-Ok (Invoke-Helper 'showTaskbar') 'showTaskbar'
# These depend on hardware the CI machine may not have; they must answer, not crash.
foreach ($c in 'getVolume', 'getBrightness') {
  $r = Invoke-Helper $c
  Write-Host "info $c -> ok=$($r.ok) $($r.result | ConvertTo-Json -Compress) $($r.error)"
}

$p.StandardInput.Close()
if (-not $p.WaitForExit(10000)) { $p.Kill(); throw 'helper did not exit after stdin closed' }
Write-Host "helper exited with code $($p.ExitCode)"
