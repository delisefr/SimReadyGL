@echo off
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

echo Installing dependencies...
npm install

echo Starting SimReadyGL dev server...
npx vite --open
