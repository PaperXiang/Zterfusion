@echo off
cd /d "%~dp0"
echo ==========================================
echo    ZTERFUSION
echo    Starting client and Socket.IO server...
echo ==========================================
echo.
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)
echo Server: http://localhost:8999
echo Close this window to stop the server.
start "" http://localhost:8999
call npm run dev
pause
