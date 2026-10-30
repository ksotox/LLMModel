@echo off
rem Double-click (or use the desktop shortcut) to start the Pokedex and open it in your browser.
rem Keep the window open while you use the app; close it to stop the app.
title Pokedex collection
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)

rem First run after downloading: install the app's packages.
if not exist node_modules (
  echo Installing the app for the first time, this takes a minute...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

call npm start -- --open
if errorlevel 1 pause
