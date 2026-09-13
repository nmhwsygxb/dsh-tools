@echo off
rem ============================================================
rem  dsh-tools one-click installer launcher
rem  Usage:
rem    1) Double-click this file -> interactive tool selection
rem    2) Drag a zip/folder onto this file's icon -> auto install
rem  Runs via PowerShell; no admin rights needed.
rem ============================================================
chcp 65001 >nul
setlocal
set "PKG=%~dp0"

set "ARGS="
if not "%~1"=="" set "ARGS=%~1"

rem If a zip/folder was dropped, extract/use it first
if not "%~1"=="" (
  set "DROP=%~1"
  if /i "%~x1"==".zip" goto :unzip
  if exist "%~1\" goto :folder
)

:run
echo.
echo ============================================
echo   dsh-tools installer  (package dir: %PKG%)
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%PKG%install.ps1"
goto :end

:folder
echo Dropped folder, using it as package root: %DROP%
set "PKG=%DROP%\"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DROP%\install.ps1"
goto :end

:unzip
echo Extracting zip to temp dir...
set "TMPDIR=%TEMP%\dsh-tools-extract"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
mkdir "%TMPDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%DROP%' -DestinationPath '%TMPDIR%' -Force"
if errorlevel 1 ( echo Extract failed. Double-click install.bat directly or extract the package first. & goto :end )
rem Find install.ps1 (may be in a subdirectory)
for /r "%TMPDIR%" %%f in (install.ps1) do (
  echo Found install.ps1: %%f
  powershell -NoProfile -ExecutionPolicy Bypass -File "%%f"
  goto :end
)
echo install.ps1 not found in the archive; make sure you dropped the dsh-tools package.
:end
echo.
pause
endlocal
