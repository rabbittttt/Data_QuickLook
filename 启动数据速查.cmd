@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 数据速查 · Data QuickLook
cd /d "%~dp0"

rem Explicit paths are resolved from this project, never from the caller's cwd.
set "quicklookPython=%DATA_QUICKLOOK_PYTHON%"
if defined quicklookPython (
    for %%I in ("%quicklookPython%") do set "quicklookPython=%%~fI"
) else (
    set "workspaceDir=%~dp0"
    goto find_workspace
)
goto python_selected

:find_workspace
for %%I in ("%workspaceDir%\.") do set "workspaceDir=%%~fI"
for %%I in ("%workspaceDir%") do if /I "%%~nxI"=="Project" goto workspace_found
for %%I in ("%workspaceDir%\..") do set "workspaceParent=%%~fI"
if /I "%workspaceParent%"=="%workspaceDir%" goto missing_workspace
set "workspaceDir=%workspaceParent%"
goto find_workspace

:workspace_found
set "quicklookPython=%workspaceDir%\.venv\Scripts\python.exe"

:python_selected
if not defined quicklookPython goto missing_python
if not exist "%quicklookPython%" goto missing_python
if exist "%quicklookPython%\" goto missing_python
for %%I in ("%quicklookPython%") do set "launcherPythonDir=%%~dpI"
set "PATH=%launcherPythonDir%;%PATH%"
for %%I in ("%launcherPythonDir%..") do set "launcherEnvironment=%%~fI"
set "VIRTUAL_ENV="
if exist "%launcherEnvironment%\pyvenv.cfg" set "VIRTUAL_ENV=%launcherEnvironment%"

echo Python: "%quicklookPython%"
"%quicklookPython%" -c "import importlib.util, sys; sys.exit(1 if sys.version_info < (3, 10) or any(importlib.util.find_spec(n) is None for n in ('pandas', 'openpyxl', 'streamlit', 'plotly')) else 0)" >nul 2>nul
if errorlevel 1 goto missing_dependencies

"%quicklookPython%" server.py --open-browser %*
set "launcherExitCode=%errorlevel%"
if not "%launcherExitCode%"=="0" pause
exit /b %launcherExitCode%

:missing_python
echo [ERROR] 找不到共享 Python。请在 Project 目录运行“初始化共享环境.cmd”，重建 Project\.venv。
if defined quicklookPython echo 所选的路径："%quicklookPython%"
echo 也可通过 DATA_QUICKLOOK_PYTHON 指定有效的 Python 文件路径。
pause
exit /b 1

:missing_workspace
echo [ERROR] 找不到名为 Project 的父目录。请将本项目放在 Project 目录下，或显式设置 DATA_QUICKLOOK_PYTHON。
pause
exit /b 1

:missing_dependencies
echo [ERROR] 所选 Python 需要 3.10 或更新版本，并安装本项目 requirements.txt 中的依赖。
echo 请执行："%quicklookPython%" -m pip install -r requirements.txt
pause
exit /b 1
