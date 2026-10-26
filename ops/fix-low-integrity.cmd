@echo off
setlocal
title Fix integrity labels (Low to Medium)

rem --- must be elevated: High Mandatory Level = S-1-16-12288 ---
whoami /groups | findstr /c:"S-1-16-12288" >nul 2>&1
if errorlevel 1 goto NOADMIN

echo ============================================================
echo  [1/2] SnowLuma folder
echo ============================================================
icacls "D:\QQbot\SnowLuma" /setintegritylevel (OI)(CI)Medium /T
echo.

echo ============================================================
echo  [2/2] Verify
echo ============================================================
echo node.exe:
icacls "D:\QQbot\SnowLuma\node.exe" | findstr /i "Mandatory"
echo.

icacls "D:\QQbot\SnowLuma\node.exe" | findstr /i "Medium" >nul 2>&1
if errorlevel 1 goto FAILED

echo ============================================================
echo  RESULT: OK - node.exe is now Medium integrity
echo ============================================================
echo.
echo  Next steps:
echo    1. close the currently running SnowLuma window
echo    2. double-click SnowLuma\launcher.bat
echo    3. log line 2 must say: process=Medium
echo.
pause
exit /b 0

:FAILED
echo ============================================================
echo  RESULT: FAILED - label is still Low
echo ============================================================
echo.
echo  This machine blocks relabeling even for Administrators.
echo  Use the copy method instead:
echo    1. in File Explorer, copy the whole folder
echo       D:\QQbot\SnowLuma
echo       to  D:\SnowLuma
echo    2. run D:\SnowLuma\launcher.bat
echo    3. tell the assistant, so config.json homeDir gets updated
echo.
pause
exit /b 1

:NOADMIN
echo.
echo [ERROR] Administrator rights required.
echo         Right-click this file, choose "Run as administrator".
echo.
pause
exit /b 1
