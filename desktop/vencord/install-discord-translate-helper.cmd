@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-discord-translate-helper.ps1" %*

echo.
echo Installer finished. Press any key to close this window.
pause >nul
