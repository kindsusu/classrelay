$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$candidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw 'The .NET Framework 4.x C# compiler (csc.exe) was not found.' }
$outputExe = Join-Path $out 'InputGuard.exe'
$sourceFile = Join-Path $root 'InputGuard.cs'
& $csc /nologo /target:winexe /platform:anycpu /optimize+ ("/out:" + $outputExe) /r:System.dll /r:System.Windows.Forms.dll $sourceFile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Built $out\InputGuard.exe"
