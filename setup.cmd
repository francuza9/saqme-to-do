@echo off
rem Saqme To Do setup: double-click it, or run it with options, e.g.  setup.cmd -Cloud   (see scripts\setup.ps1)
rem the full path: cmd.exe would run a powershell.exe lying next to this file (Downloads) first
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
set code=%errorlevel%
if "%~1"=="" pause
exit /b %code%
