@echo off
rem Double-click this to install the label print helper on this PC.
rem Needs install-windows.ps1 and print_bridge.py (in this folder or the one above).
rem To remove it again, run:  install-windows.bat -Uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
echo.
pause
