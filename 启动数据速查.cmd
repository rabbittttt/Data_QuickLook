@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 数据速查 · Data QuickLook
cd /d "%~dp0"

rem Explicit paths are resolved from this project, never from the caller's cwd.
set "quicklookPython=%DATA_QUICKLOOK_PYTHON%"
if defined quicklookPython (
    for %%I in ("%quicklookPython%") do set "quicklookPython=%%~fI"
) else if exist ".venv\" (
    set "quicklookPython=%~dp0.venv\Scripts\python.exe"
) else (
    for %%I in (python.exe) do set "quicklookPython=%%~$PATH:I"
)
if not defined quicklookPython goto missing_python
if not exist "%quicklookPython%" goto missing_python
if exist "%quicklookPython%\" goto missing_python

echo Python: "%quicklookPython%"
"%quicklookPython%" -c "import importlib.util, sys; sys.exit(1 if sys.version_info < (3, 10) or any(importlib.util.find_spec(n) is None for n in ('pandas', 'openpyxl', 'streamlit', 'plotly')) else 0)" >nul 2>nul
if errorlevel 1 goto missing_dependencies

"%quicklookPython%" server.py --open-browser
set "launcherExitCode=%errorlevel%"
if not "%launcherExitCode%"=="0" pause
exit /b %launcherExitCode%

:missing_python
echo [ERROR] 找不到 Python。请安装 Python 3.10 或更新版本，并按 README.md 在本项目创建 .venv。
if defined quicklookPython echo 所选的路径："%quicklookPython%"
echo 也可通过 DATA_QUICKLOOK_PYTHON 指定有效的 Python 文件路径。
pause
exit /b 1

:missing_dependencies
echo [ERROR] 所选 Python 需要 3.10 或更新版本，并安装本项目 requirements.txt 中的依赖。
echo 请执行："%quicklookPython%" -m pip install -r requirements.txt
pause
exit /b 1
