const fs = require('fs');
const path = require('path');

const target = path.join(
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
  'sonycamera',
  'SonyScalarWebApiTransport.kt'
);

if (!fs.existsSync(target)) {
  throw new Error(`Sony Scalar source not found: ${target}`);
}

let source = fs.readFileSync(target, 'utf8');

function replaceRegex(label, regex, replacement) {
  if (!regex.test(source)) {
    throw new Error(`Unable to patch ${label}: expected source pattern was not found.`);
  }
  source = source.replace(regex, replacement);
}

replaceRegex(
  'Scalar connection handshake',
  /  fun connect\(\) \{[\s\S]*?\n  \}\n\n  private fun refreshAvailableApis\(\) \{/,
  `  fun connect() {
    // A7R II legacy ScalarWebAPI initialization sequence proven by ESP32-Lidar:
    // getVersions -> startRecMode -> startLiveview.  Do not gate these first two
    // commands on getAvailableApiList: this body can execute commands that it does
    // not advertise until Remote Shooting is active.
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

  private fun refreshAvailableApis() {`
);

replaceRegex(
  'ISO discovery',
  /  fun isoSpeedRates\(\): Map<String, Any\?> \{[\s\S]*?\n  \}\n\n  fun configureCaptureSettings/,
  `  fun isoSpeedRates(): Map<String, Any?> {
    // Legacy A7 bodies may omit these methods from getAvailableApiList even though
    // direct ScalarWebAPI calls work. Try the current/available query first, then
    // the supported-values query used by ESP32-Lidar.
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

  fun configureCaptureSettings`
);

replaceRegex(
  'direct ISO/shutter control',
  /  fun configureCaptureSettings\(shutterSpeed: String, iso: String\): Map<String, Any\?> \{[\s\S]*?\n  \}\n\n  fun startBulbShooting/,
  `  fun configureCaptureSettings(shutterSpeed: String, iso: String): Map<String, Any?> {
    // Match the proven ESP32-Lidar behavior: send these methods directly instead
    // of rejecting them because getAvailableApiList omitted them.
    call("setIsoSpeedRate", JSONArray().put(iso))
    call("setShutterSpeed", JSONArray().put(shutterSpeed))
    trace("Scalar capture settings applied ISO=$iso shutter=$shutterSpeed")
    runCatching { refreshAvailableApis() }
      .onFailure { trace("Scalar API refresh after capture settings failed: \${it.message ?: "unknown"}") }
    return runCatching { isoSpeedRates() }
      .getOrElse { mapOf("current" to iso, "available" to emptyList<String>()) }
  }

  fun startBulbShooting`
);

replaceRegex(
  'ISO discovery after Live View start',
  /(    val activeLiveViewUrl = response[\s\S]*?      \?: throw SonyPtpException\([\s\S]*?\n      \)\n)(    val connection = network\.open\(activeLiveViewUrl\)\.apply \{)/,
  `$1    // The A7R II exposes its shooting controls reliably after startLiveview.
    // Refresh capabilities and query ISO here so the JS UI can read the list later
    // without racing the Remote Shooting / Live View state transition.
    runCatching {
      refreshAvailableApis()
      isoSpeedRates()
    }.onFailure { error ->
      trace("Scalar ISO discovery after Live View start failed: \${error.message ?: "unknown"}")
    }
$2`
);

fs.writeFileSync(target, source, 'utf8');
console.log('[postinstall] Patched Sony ScalarWebAPI A7R II initialization and ISO control.');
