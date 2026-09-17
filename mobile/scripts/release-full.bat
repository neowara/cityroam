@echo off
REM Double-click launcher for release-full.ps1 — copy a shortcut to this file
REM onto your Desktop (right-click -> Send to -> Desktop (create shortcut)).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release-full.ps1"
pause
