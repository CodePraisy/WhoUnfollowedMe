@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
rem Install packages only when the dependency list changes
if not exist "node_modules\.wum-deps-v3" (
  echo Installing packages. This only happens the first time...
  call npm install --no-fund
  if errorlevel 1 ( pause & exit /b 1 )
)
rem Electron 45+ downloads its program on first use, so fetch it here if it is missing
if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading Electron, about 100 MB. One time only...
  node "node_modules\electron\install.js"
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Electron did not download. Check your internet connection and run start.bat again.
    pause
    exit /b 1
  )
)
echo ok> "node_modules\.wum-deps-v3"
rem Close any copy of this app that is still running in the background
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '%~dp0*' } | Stop-Process -Force" 2>nul
rem Launch the app and close this window
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
