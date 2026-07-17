@echo off
REM ============================================================
REM  stockweb - new PC one-shot setup
REM
REM  BEFORE running, copy these 3 folders to the new PC (SAME paths):
REM    1) C:\MyProject\myweb              (web app, incl. this file)
REM    2) C:\Users\jack6\shioaji-server   (.env keys/CA + start script)
REM    3) C:\ekey                         (CA cert Sinopac.pfx)
REM  And install Python 3.x (current PC uses 3.14; a close version is fine).
REM  Note: if the new PC's Windows username is not "jack6", shioaji-server
REM  may live elsewhere, but keep C:\ekey at the same path (the .env CA
REM  path points to C:\ekey\551\U120120805\S\Sinopac.pfx).
REM ============================================================

echo [1/4] Installing shioaji ...
pip install shioaji || (echo pip not found - install Python 3.x first, then rerun. & pause & exit /b 1)

echo.
echo [2/4] Starting local Shioaji server (production; reads shioaji-server\.env) ...
start "shioaji-server" cmd /c "C:\Users\jack6\shioaji-server\start-server.cmd"

echo     Waiting for server ...
set /a _n=0
:waitloop
timeout /t 2 >nul
curl -s -m 3 http://localhost:8080/api/v1/health >nul 2>&1
if %errorlevel%==0 goto ready
set /a _n+=1
if %_n% lss 20 goto waitloop
echo     Timed out - check Python/keys/CA, then run start-server.cmd manually.
pause & exit /b 1
:ready
echo     Server ready.

echo.
echo [3/4] Deploying stockweb ...
cd /d C:\MyProject\myweb\stockweb
shioaji apps upload --name stockweb --dir . || (echo Deploy failed. & pause & exit /b 1)

echo.
echo [4/4] Opening the app (log in with Google account jack6349@gmail.com) ...
start "" "http://localhost:8080/apps/stockweb/"

echo.
echo Done. For auto-start on boot, replicate the current PC's Task Scheduler
echo entry (which calls shioaji-server\start-server.cmd or run-hidden.vbs).
pause
