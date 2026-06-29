@echo off
setlocal
cd /d "%~dp0"
call "%~dp0download-runtimes.bat"
if errorlevel 1 exit /b %ERRORLEVEL%
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %*
exit /b %ERRORLEVEL%
