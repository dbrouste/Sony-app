@echo off
setlocal

cd /d "%~dp0"

echo [local-build] Stopping Gradle daemon if present...
if exist "android\gradlew.bat" (
  pushd android
  call gradlew.bat --stop >nul 2>&1
  popd
)

echo [local-build] Pulling latest main...
git pull --ff-only
if errorlevel 1 goto :fail

echo [local-build] Installing dependencies...
call npm install
if errorlevel 1 goto :fail

echo [local-build] Generating Android project...
call npx expo prebuild --platform android --no-install
if errorlevel 1 goto :fail

echo [local-build] Preparing local Android build...
node scripts\prepare-local-android.js
if errorlevel 1 goto :fail

echo [local-build] Building release APK...
pushd android
call gradlew.bat assembleRelease
set BUILD_RESULT=%ERRORLEVEL%
popd
if not "%BUILD_RESULT%"=="0" goto :fail

echo.
echo ============================================================
echo BUILD SUCCESSFUL
echo APK:
echo %CD%\android\app\build\outputs\apk\release\app-release.apk
echo ============================================================
exit /b 0

:fail
echo.
echo [local-build] Build failed. See the error above.
exit /b 1
