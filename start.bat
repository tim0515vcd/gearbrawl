@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:8765"
py server.py
pause
