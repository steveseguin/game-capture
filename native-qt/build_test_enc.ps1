# Build encryption test
$vsPath = "C:\Program Files\Microsoft Visual Studio\2022\Community"
$vsDevCmd = "$vsPath\Common7\Tools\VsDevCmd.bat"

$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = "cmd.exe"
$pinfo.Arguments = "/c `"$vsDevCmd`" -arch=amd64 && cd /d C:\Users\Steve\code\versus-app\native-qt\build && cl /EHsc /I_deps\mbedtls-src\include /Fe:bin\test-encryption.exe ..\src\test_encryption.cpp lib\mbedtls.lib lib\mbedcrypto.lib lib\mbedx509.lib Advapi32.lib 2>&1"
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true
$pinfo.UseShellExecute = $false
$pinfo.CreateNoWindow = $true

$p = New-Object System.Diagnostics.Process
$p.StartInfo = $pinfo
$p.Start() | Out-Null

$stdout = $p.StandardOutput.ReadToEnd()
$stderr = $p.StandardError.ReadToEnd()
$p.WaitForExit()

Write-Host $stdout
if ($stderr) {
    Write-Host "STDERR: $stderr"
}
Write-Host "Exit code: $($p.ExitCode)"
