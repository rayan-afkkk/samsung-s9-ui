# Compiles src/native/OneShellNative.cs with the C# compiler that ships with Windows 10/11
# (.NET Framework 4.x), so no Visual Studio or .NET SDK is needed.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }

$out = Join-Path $root 'build\native'
New-Item -ItemType Directory -Force -Path $out | Out-Null

& $csc /nologo /target:exe /platform:x64 /optimize+ `
  /out:"$out\OneShellNative.exe" `
  /r:System.Web.Extensions.dll /r:System.Management.dll /r:System.Drawing.dll `
  "$root\src\native\OneShellNative.cs"
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Write-Host "Built $out\OneShellNative.exe"
