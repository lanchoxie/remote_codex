@echo off
setlocal

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\start-windows.ps1" %*

if errorlevel 1 (
  echo.
  echo Remote Codex failed to start. See the error above.
  pause
)
