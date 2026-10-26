@echo off
rem One-click stop: qq-bridge -> DSH engine -> SnowLuma.
rem ASCII only: cmd mis-parses non-ASCII bytes after a codepage switch.
chcp 65001 >nul
cd /d "%~dp0"
title QQ Bot - stop
node "%~dp0ops\stack-control.mjs" stop
echo.
pause
