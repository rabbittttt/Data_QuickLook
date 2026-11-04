@echo off
chcp 65001 >nul
title 数据速查 · Data QuickLook
cd /d "%~dp0"
python server.py --open-browser
if errorlevel 1 pause
