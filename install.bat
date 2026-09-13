@echo off
rem ============================================================
rem  dsh-tools 一键安装入口
rem  用法：
rem    1) 双击本文件  -> 交互式选择工具安装
rem    2) 把 压缩包/文件夹 直接拖到本文件图标上 -> 解压后安装
rem  脚本由 PowerShell 执行，无需管理员权限。
rem ============================================================
chcp 65001 >nul
setlocal
set "PKG=%~dp0"

set "ARGS="
if not "%~1"=="" set "ARGS=%~1"

rem 如果拖进来的是 zip/folder，先解压到临时目录再安装
if not "%~1"=="" (
  set "DROP=%~1"
  if /i "%~x1"==".zip" goto :unzip
  if exist "%~1\" goto :folder
)

:run
echo.
echo ============================================
echo   dsh-tools 安装器  (包目录: %PKG%)
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%PKG%install.ps1"
goto :end

:folder
echo 拖入的是文件夹，将直接作为工具包安装: %DROP%
set "PKG=%DROP%\"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DROP%\install.ps1"
goto :end

:unzip
echo 解压压缩包到临时目录...
set "TMPDIR=%TEMP%\dsh-tools-extract"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
mkdir "%TMPDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%DROP%' -DestinationPath '%TMPDIR%' -Force"
if errorlevel 1 ( echo 解压失败，请直接双击 install.bat 或先把包解压好. & goto :end )
rem 找到 install.ps1（可能在子目录）
for /r "%TMPDIR%" %%f in (install.ps1) do (
  echo 找到 install.ps1: %%f
  powershell -NoProfile -ExecutionPolicy Bypass -File "%%f"
  goto :end
)
echo 压缩包内未找到 install.ps1，请确认拖入的是本工具包。

:end
echo.
pause
endlocal