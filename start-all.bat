@echo off
rem One-click start: SnowLuma -> DSH engine -> qq-bridge.
rem ASCII only: cmd mis-parses non-ASCII bytes after a codepage switch.
chcp 65001 >nul
cd /d "%~dp0"
title QQ Bot - start
node "%~dp0ops\stack-control.mjs" start
echo.
pause
