@echo off
title ContextShield Gateway ^& Security Firewall
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist "dist\cli.js" (
    echo [INFO] Building ContextShield...
    call npm run build
)

node dist\cli.js menu
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Application exited with error code %errorlevel%.
    pause
)
