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

rem expo-sony-camera is modified by patch-package. A previous local build or
rem interrupted npm install can leave a partially patched copy in node_modules,
rem which makes patch-package fail on the next install. Always restore a clean
rem package copy before npm runs its postinstall hook.
if exist "node_modules\expo-sony-camera" (
  echo [local-build] Resetting expo-sony-camera before patch-package...
  rmdir /s /q "node_modules\expo-sony-camera"
  if exist "node_modules\expo-sony-camera" (
    echo [local-build] Could not remove expo-sony-camera. A Java/Gradle process may still be locking files.
    goto :fail
  )
)

echo [local-build] Installing dependencies...
rem Keep NODE_ENV unset here so npm installs devDependencies such as patch-package.
set NODE_ENV=
call npm install
if errorlevel 1 goto :fail

rem Expo/Gradle release tasks expect production mode, but only after dependencies
rem (including devDependencies used by postinstall) have been installed.
set NODE_ENV=production

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
