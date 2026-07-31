@echo off
cd /d "%~dp0"
echo ==========================================
echo    ZTERFUSION
echo    Starting local server with sounds...
echo ==========================================
echo.
start "" "http://localhost:8000"
where python >nul 2>nul
if %errorlevel%==0 (
    echo Server: http://localhost:8000
    echo Close this window to stop the server.
    python -m http.server 8000
) else (
    py -m http.server 8000
)
pause
