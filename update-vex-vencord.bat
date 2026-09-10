@echo off
REM === Update Vex's Discord with your custom Vencord build ===
REM Run this after editing plugins in src\userplugins (the Vex equivalent of
REM "pnpm build" + "pnpm inject" that you use for the desktop Discord app).

cd /d C:\vencord-dev

echo [1/4] Building Vencord web extension (with your userplugins)...
call pnpm buildWeb
if errorlevel 1 ( echo BUILD FAILED & pause & exit /b 1 )

echo [2/4] Closing Vex...
taskkill /F /IM Vex.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo [3/4] Installing the new build into Vex's Discord panel...
REM Vex extracts the extension once at install time into extensions\vencord-<timestamp>
REM and never re-reads the zip, so overwrite the extracted folder in place.
set "EXT="
for /d %%D in ("%APPDATA%\vex\extensions\vencord-*") do set "EXT=%%D"
if not defined EXT ( echo No vencord-* extension folder found in %APPDATA%\vex\extensions & pause & exit /b 1 )
xcopy /E /I /Y "C:\vencord-dev\dist\chromium-unpacked" "%EXT%" >nul

echo [4/4] Relaunching Vex...
start "" "C:\Claude code free\vex\dist\win-unpacked\Vex.exe"

echo.
echo Done — your custom plugins are now in Vex's Discord.
timeout /t 3 /nobreak >nul
