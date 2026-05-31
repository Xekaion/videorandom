@echo off
title Video Roulette Loader
cd /d "%~dp0"

echo ===================================================
echo   Video Roulette - premium Random Video Picker
echo ===================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed on this system.
    echo Please install Node.js from https://nodejs.org/ first!
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist node_modules (
    echo [INFO] First-time setup: Installing required modules...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies. Please run 'npm install' manually.
        pause
        exit /b 1
    )
)

echo [INFO] Launching server...
node server.js

pause
