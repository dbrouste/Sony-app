const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');
const sonyGradle = path.join(root, 'node_modules', 'expo-sony-camera', 'android', 'build.gradle');
const appGradle = path.join(androidDir, 'app', 'build.gradle');

function fail(message) {
  console.error(`\n[local-build] ERROR: ${message}`);
  process.exit(1);
}

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`${label} not found: ${filePath}`);
}

function normalizeSdkPath(value) {
  return value.replace(/[\\/]+$/, '');
}

function detectAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter(Boolean).map(normalizeSdkPath);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  fail(
    'Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT, or install the SDK in ' +
      path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk')
  );
}

function writeLocalProperties() {
  if (!fs.existsSync(androidDir)) fail('android/ does not exist. Run Expo prebuild first.');
  const sdk = detectAndroidSdk();
  const escaped = sdk.replace(/\\/g, '\\\\');
  fs.writeFileSync(path.join(androidDir, 'local.properties'), `sdk.dir=${escaped}\n`, 'utf8');
  console.log(`[local-build] Android SDK: ${sdk}`);
}

function patchSonyCameraAarDependency() {
  ensureFile(sonyGradle, 'expo-sony-camera build.gradle');
  let text = fs.readFileSync(sonyGradle, 'utf8');
  const aar = "files('libs/UVCAndroid-sony-bulk-patched.aar')";

  if (text.includes(`compileOnly ${aar}`)) {
    console.log('[local-build] expo-sony-camera AAR dependency already patched.');
    return;
  }

  if (!text.includes(`implementation ${aar}`)) {
    fail('Could not find the expected UVCAndroid local AAR dependency in expo-sony-camera.');
  }

  text = text.replace(`implementation ${aar}`, `compileOnly ${aar}`);
  fs.writeFileSync(sonyGradle, text, 'utf8');
  console.log('[local-build] Patched expo-sony-camera local AAR dependency to compileOnly.');
}

function patchAppAarDependency() {
  ensureFile(appGradle, 'android/app/build.gradle');
  let text = fs.readFileSync(appGradle, 'utf8');
  const dependency = "implementation files('../../node_modules/expo-sony-camera/android/libs/UVCAndroid-sony-bulk-patched.aar')";

  if (text.includes(dependency)) {
    console.log('[local-build] App UVCAndroid AAR dependency already present.');
    return;
  }

  const marker = /dependencies\s*\{/;
  if (!marker.test(text)) fail('Could not find dependencies { in android/app/build.gradle.');
  text = text.replace(marker, match => `${match}\n    ${dependency}`);
  fs.writeFileSync(appGradle, text, 'utf8');
  console.log('[local-build] Added UVCAndroid AAR dependency to the app.');
}

writeLocalProperties();
patchSonyCameraAarDependency();
patchAppAarDependency();
console.log('[local-build] Android project prepared successfully.');
