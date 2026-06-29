@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\download-runtimes.ps1" %*
exit /b %ERRORLEVEL%
