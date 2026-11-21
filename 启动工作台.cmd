@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0.tools\node.exe" (
  echo Local runtime missing. See README.md.
  pause
  exit /b 1
)
"%~dp0.tools\node.exe" "%~dp0workbench\server.mjs" --open
set "workbench_exit=%errorlevel%"
if not "%workbench_exit%"=="0" pause
exit /b %workbench_exit%
