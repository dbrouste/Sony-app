const fs = require('fs');
const path = require('path');

const root = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo-sony-camera',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'sonycamera'
);

const scalarTarget = path.join(root, 'SonyScalarWebApiTransport.kt');
const controllerTarget = path.join(root, 'SonyCameraController.kt');

for (const target of [scalarTarget, controllerTarget]) {
  if (!fs.existsSync(target)) throw new Error(`Sony source not found: ${target}`);
}

let source = fs.readFileSync(scalarTarget, 'utf8');

function replaceBetween(label, startToken, endToken, replacement, alreadyPatchedMarker) {
  if (alreadyPatchedMarker && source.includes(alreadyPatchedMarker)) {
    console.log(`[postinstall] ${label}: already patched.`);
    return;
  }
  const start = source.indexOf(startToken);
  if (start < 0) throw new Error(`Unable to patch ${label}: start token was not found.`);
  const end = source.indexOf(endToken, start + startToken.length);
  if (end < 0) throw new Error(`Unable to patch ${label}: end token was not found.`);
  source = source.slice(0, start) + replacement + source.slice(end);
}

function replaceRegex(label, regex, replacement, alreadyPatchedMarker) {
  if (alreadyPatchedMarker && source.includes(alreadyPatchedMarker)) {
    console.log(`[postinstall] ${label}: already patched.`);
    return;
  }
  if (!regex.test(source)) throw new Error(`Unable to patch ${label}: expected source pattern was not found.`);
  source = source.replace(regex, replacement);
}

replaceBetween(
  'Scalar connection handshake',
  '  fun connect() {',
  '  private fun refreshAvailableApis() {',
  `  fun connect() {
    // A7R II legacy ScalarWebAPI initialization sequence proven by ESP32-Lidar:
    // getVersions -> startRecMode. Live View is started by startLiveView() immediately
    // afterwards when requested by the app. Do not gate these commands on the API list.
    trace("Scalar handshake: getVersions")
    call("getVersions")

    trace("Scalar handshake: startRecMode")
    call("startRecMode", timeoutMs = 10_000)
    Thread.sleep(500)

    refreshAvailableApis()
    if (availableApis.isEmpty()) throw SonyPtpException("Sony camera returned no available remote APIs.")
    trace("Scalar ready APIs=\${availableApis.size}")
    trace("Scalar API list=\${availableApis.sorted().joinToString(",")}")
  }

`,
  'Scalar handshake: getVersions'
);

replaceBetween(
  'ISO discovery',
  '  fun isoSpeedRates(): Map<String, Any?> {',
  '  fun configureCaptureSettings',
  `  fun isoSpeedRates(): Map<String, Any?> {
    val response = runCatching { call("getAvailableIsoSpeedRate") }
      .getOrElse { availableError ->
        trace("Scalar getAvailableIsoSpeedRate failed; trying getSupportedIsoSpeedRate: \${availableError.message ?: "unknown"}")
        call("getSupportedIsoSpeedRate")
      }
    val result = response.optJSONArray("result")
      ?: throw SonyPtpException("Sony returned no ISO settings.")

    val first = result.opt(0)
    val second = result.opt(1)
    val current = (first as? String)?.takeIf(String::isNotBlank)
    val values = when {
      second is JSONArray -> second
      first is JSONArray -> first
      else -> null
    }
    val available = if (values == null) emptyList() else {
      (0 until values.length()).mapNotNull { index ->
        values.optString(index).takeIf(String::isNotBlank)
      }
    }
    trace("Scalar ISO values current=\${current ?: "unknown"} available=\${available.joinToString(",")}")
    return mapOf("current" to current, "available" to available)
  }

`,
  'trying getSupportedIsoSpeedRate'
);

if (!source.includes('private var configuredIso: String? = null')) {
  const marker = '  private var liveInput: BufferedInputStream? = null\n';
  if (!source.includes(marker)) throw new Error('Unable to patch capture-setting cache: insertion point not found.');
  source = source.replace(
    marker,
    `${marker}  private var configuredIso: String? = null\n  private var configuredShutterSpeed: String? = null\n`
  );
}

replaceBetween(
  'direct ISO/shutter control',
  '  fun configureCaptureSettings(shutterSpeed: String, iso: String): Map<String, Any?> {',
  '  fun startBulbShooting',
  `  fun configureCaptureSettings(shutterSpeed: String, iso: String): Map<String, Any?> {
    call("setIsoSpeedRate", JSONArray().put(iso))
    call("setShutterSpeed", JSONArray().put(shutterSpeed))
    configuredIso = iso
    configuredShutterSpeed = shutterSpeed
    trace("Scalar capture settings applied ISO=$iso shutter=$shutterSpeed")
    runCatching { refreshAvailableApis() }
      .onFailure { trace("Scalar API refresh after capture settings failed: \${it.message ?: "unknown"}") }
    return runCatching { isoSpeedRates() }
      .getOrElse { mapOf("current" to iso, "available" to emptyList<String>()) }
  }

`,
  'configuredShutterSpeed = shutterSpeed'
);

replaceBetween(
  'BULB sequence reuse',
  '  fun startBulbShooting(iso: String) {',
  '  fun stopBulbShooting() {',
  `  fun startBulbShooting(iso: String) {
    // ISO/BULB are configured once before the sequence. Re-applying ISO after every
    // exposure makes the A7R II answer "Not Available Now" while it is finalising
    // the previous image.
    if (configuredIso != iso || configuredShutterSpeed != "BULB") {
      configureCaptureSettings("BULB", iso)
    }

    // After a BULB exposure the A7R II can remain busy while it finalises/writes the RAW.
    // Retry startBulbShooting for up to ~10 s instead of failing the whole timelapse.
    val deadline = System.currentTimeMillis() + 10_000L
    var attempt = 0
    while (true) {
      attempt += 1
      try {
        call("startBulbShooting")
        trace("Scalar BULB shutter opened attempt=$attempt")
        break
      } catch (error: SonyPtpException) {
        val busy = error.message?.contains("Not Available Now", ignoreCase = true) == true
        if (!busy || System.currentTimeMillis() >= deadline) throw error
        trace("Scalar startBulbShooting busy attempt=$attempt; waiting before retry")
        runCatching { call("getEvent", JSONArray().put(false), timeoutMs = 2_000) }
          .onFailure { trace("Scalar readiness getEvent failed during BULB retry: \${it.message ?: "unknown"}") }
        Thread.sleep(400)
      }
    }
  }

`,
  'Retry startBulbShooting for up to ~10 s'
);

replaceBetween(
  'BULB completion wait',
  '  fun stopBulbShooting() {',
  '  fun captureThirtySecondPhoto',
  `  fun stopBulbShooting() {
    call("stopBulbShooting", timeoutMs = 20_000)
    trace("Scalar BULB shutter closed")
    // Let the body finish writing/finalising the image before the next timelapse shot.
    runCatching { call("getEvent", JSONArray().put(false), timeoutMs = 5_000) }
      .onFailure { trace("Scalar post-BULB getEvent unavailable: \${it.message ?: "unknown"}") }
    Thread.sleep(500)
  }

`,
  'Let the body finish writing/finalising the image'
);

replaceBetween(
  '30-second sequence reuse',
  '  fun captureThirtySecondPhoto(iso: String): Long {',
  '  fun focusAt(',
  `  fun captureThirtySecondPhoto(iso: String): Long {
    if (configuredIso != iso || configuredShutterSpeed != "30\\\"") {
      configureCaptureSettings("30\\\"", iso)
    }
    val startedAt = System.currentTimeMillis()
    try {
      call("actTakePicture", timeoutMs = 50_000)
    } catch (error: SonyPtpException) {
      val acceptedLongExposure = error.message?.contains("40403") == true &&
        error.message?.contains("Long shooting", ignoreCase = true) == true
      if (!acceptedLongExposure) throw error
      val remainingMs = 30_500L - (System.currentTimeMillis() - startedAt)
      if (remainingMs > 0L) Thread.sleep(remainingMs)
      trace("Scalar 40403 Long shooting treated as accepted 30-second exposure")
    }
    runCatching { call("getEvent", JSONArray().put(false), timeoutMs = 5_000) }
    Thread.sleep(500)
    trace("Scalar standard 30-second exposure completed")
    return System.currentTimeMillis() - startedAt
  }

`,
  'configuredShutterSpeed != "30\\\""'
);

replaceRegex(
  'ISO discovery after Live View start',
  /(    val activeLiveViewUrl = response[\s\S]*?      \?: throw SonyPtpException\([\s\S]*?\r?\n      \)\r?\n)(    val connection = network\.open\(activeLiveViewUrl\)\.apply \{)/,
  `$1    runCatching {
      refreshAvailableApis()
      isoSpeedRates()
    }.onFailure { error ->
      trace("Scalar ISO discovery after Live View start failed: \${error.message ?: "unknown"}")
    }
$2`,
  'Scalar ISO discovery after Live View start failed'
);

replaceBetween(
  'low-latency Live View',
  '  fun getLiveViewJpeg(): ByteArray {',
  '  fun capturePhoto(): ByteArray {',
  `  private fun readOneLiveViewJpeg(input: BufferedInputStream): ByteArray {
    val output = ByteArrayOutputStream(128 * 1024)
    var previous = -1
    var started = false
    while (output.size() <= 8 * 1024 * 1024) {
      val current = input.read()
      if (current < 0) throw SonyPtpException("Sony live-view stream ended.")
      if (!started) {
        if (previous == 0xFF && current == 0xD8) {
          output.write(0xFF)
          output.write(0xD8)
          started = true
        }
      } else {
        output.write(current)
        if (previous == 0xFF && current == 0xD9) return output.toByteArray()
      }
      previous = current
    }
    throw SonyPtpException("Sony live-view JPEG exceeded the safe frame limit.")
  }

  fun getLiveViewJpeg(): ByteArray {
    val input = liveInput ?: throw SonyPtpException("Sony live view is not open.")
    var latest = readOneLiveViewJpeg(input)
    var dropped = 0
    // If frames have accumulated in the TCP/BufferedInputStream queue, drain complete
    // JPEGs and return the newest one. Low latency matters more than displaying every frame.
    while (input.available() > 0 && dropped < 24) {
      latest = readOneLiveViewJpeg(input)
      dropped += 1
    }
    if (dropped > 0) trace("Scalar live-view catch-up dropped=$dropped")
    return latest
  }

`,
  'Low latency matters more than displaying every frame'
);

fs.writeFileSync(scalarTarget, source, 'utf8');

let controllerSource = fs.readFileSync(controllerTarget, 'utf8');
if (!controllerSource.includes('Scalar low-latency path: never add artificial pacing')) {
  const oldPacing = '        val remaining = 100L - (SystemClock.elapsedRealtime() - startedAt)\n        if (remaining > 0) SystemClock.sleep(remaining)';
  if (!controllerSource.includes(oldPacing)) throw new Error('Unable to patch Scalar Live View pacing: source pattern not found.');
  controllerSource = controllerSource.replace(
    oldPacing,
    `        // Scalar low-latency path: never add artificial pacing; the camera stream is already paced.\n        val remaining = if (scalarTransport != null) 0L else 100L - (SystemClock.elapsedRealtime() - startedAt)\n        if (remaining > 0) SystemClock.sleep(remaining)`
  );
}
fs.writeFileSync(controllerTarget, controllerSource, 'utf8');

console.log('[postinstall] Patched Sony timelapse sequencing and low-latency Live View.');
