@echo off
cd /d "%~dp0"
title VideoRandom Analysis Server
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js is required on the analysis server PC.
    pause
    exit /b 1
)
if not exist node_modules (
    call npm ci
    if errorlevel 1 exit /b 1
)
set VIDEORANDOM_START_HOST=1
node server.js
pause
