@echo off
chcp 65001 >nul
title Excel 数据查询与图表分析
cd /d "%~dp0"
python server.py --open-browser
if errorlevel 1 pause
