package expo.modules.astrometry

import android.database.Cursor
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

class ExpoAstrometryModule : Module() {
  private data class IndexSpec(
    val number: Int,
    val sizeBytes: Long,
    val md5: String,
  ) {
    val fileName = "index-$number.fits"
  }

  private val downloading = AtomicBoolean(false)
  private val cancelDownload = AtomicBoolean(false)

  override fun definition() = ModuleDefinition {
    Name("ExpoAstrometry")
    Events("onCatalogProgress")

    Function("getCatalogStatus") { focalLength: Int ->
      catalogStatus(focalLength)
    }

    AsyncFunction("downloadCatalog") { focalLength: Int ->
      downloadCatalog(focalLength)
    }

    Function("cancelCatalogDownload") {
      val active = downloading.get()
      if (active) cancelDownload.set(true)
      mapOf("ok" to true, "active" to active)
    }

    Function("deleteCatalog") {
      for (spec in INDEXES) {
        indexFile(spec).delete()
        partialFile(spec).delete()
      }
      catalogStatus(180)
    }

    AsyncFunction("importIndex") { uri: String ->
      importIndex(uri)
      catalogStatus(180)
    }

    AsyncFunction("solveImage") { uri: String, focalLength: Int ->
      solveImage(uri, focalLength)
    }
  }

  private fun context() = requireNotNull(appContext.reactContext)

  private fun indexDirectory(): File {
    val directory = context().getExternalFilesDir("astrometry-indexes")
      ?: File(context().filesDir, "astrometry-indexes")
    if (!directory.exists() && !directory.mkdirs()) {
      throw IllegalStateException("Impossible de créer ${directory.absolutePath}")
    }
    return directory
  }

  private fun requiredMinimum(focalLength: Int): Int = when (focalLength) {
    50 -> 4113
    90 -> 4111
    180 -> 4109
    else -> throw IllegalArgumentException("Focale non prise en charge : $focalLength mm")
  }

  private fun requiredIndexes(focalLength: Int): List<IndexSpec> {
    val minimum = requiredMinimum(focalLength)
    return INDEXES.filter { it.number >= minimum }
  }

  private fun indexFile(spec: IndexSpec) = File(indexDirectory(), spec.fileName)
  private fun partialFile(spec: IndexSpec) = File(indexDirectory(), "${spec.fileName}.part")

  private fun isValid(spec: IndexSpec): Boolean {
    val file = indexFile(spec)
    return file.isFile && file.length() == spec.sizeBytes
  }

  private fun catalogStatus(focalLength: Int): Map<String, Any?> {
    val required = requiredIndexes(focalLength).map { it.number }.toSet()
    val items = INDEXES.map { spec ->
      val file = indexFile(spec)
      mapOf(
        "number" to spec.number,
        "fileName" to spec.fileName,
        "sizeBytes" to spec.sizeBytes,
        "installed" to file.isFile,
        "valid" to isValid(spec),
        "required" to required.contains(spec.number),
      )
    }
    return mapOf(
      "directory" to indexDirectory().absolutePath,
      "focalLength" to focalLength,
      "ready" to requiredIndexes(focalLength).all(::isValid),
      "installedBytes" to INDEXES.filter(::isValid).sumOf { it.sizeBytes },
      "requiredBytes" to requiredIndexes(focalLength).sumOf { it.sizeBytes },
      "indexes" to items,
    )
  }

  private fun downloadCatalog(focalLength: Int): Map<String, Any?> {
    requiredMinimum(focalLength)
    if (!downloading.compareAndSet(false, true)) {
      throw IllegalStateException("Un téléchargement de catalogue est déjà en cours.")
    }
    cancelDownload.set(false)
    try {
      val missing = requiredIndexes(focalLength).filterNot(::isValid)
      val totalSize = missing.sumOf { it.sizeBytes }
      var previousBytes = 0L
      for (spec in missing) {
        if (cancelDownload.get()) throw InterruptedException("Téléchargement annulé.")
        downloadIndex(spec, previousBytes, totalSize)
        previousBytes += spec.sizeBytes
      }
      return catalogStatus(focalLength)
    } finally {
      cancelDownload.set(false)
      downloading.set(false)
    }
  }

  private fun downloadIndex(spec: IndexSpec, previousBytes: Long, totalSize: Long) {
    val destination = indexFile(spec)
    val partial = partialFile(spec)
    partial.delete()
    val connection = (URL("$INDEX_BASE_URL/${spec.fileName}").openConnection() as HttpURLConnection).apply {
      connectTimeout = 15_000
      readTimeout = 30_000
      instanceFollowRedirects = true
      requestMethod = "GET"
    }
    try {
      connection.connect()
      if (connection.responseCode !in 200..299) {
        throw IllegalStateException("HTTP ${connection.responseCode} pour ${spec.fileName}")
      }
      val digest = MessageDigest.getInstance("MD5")
      var copied = 0L
      var lastProgressAt = 0L
      connection.inputStream.use { input ->
        FileOutputStream(partial).use { output ->
          val buffer = ByteArray(128 * 1024)
          while (true) {
            if (cancelDownload.get()) throw InterruptedException("Téléchargement annulé.")
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
            copied += count
            val now = System.currentTimeMillis()
            if (now - lastProgressAt >= 250L) {
              sendProgress(spec, copied, previousBytes + copied, totalSize)
              lastProgressAt = now
            }
          }
          output.fd.sync()
        }
      }
      val md5 = digest.digest().joinToString("") { "%02x".format(Locale.US, it.toInt() and 0xff) }
      if (copied != spec.sizeBytes || !md5.equals(spec.md5, ignoreCase = true)) {
        partial.delete()
        throw IllegalStateException(
          "Contrôle d’intégrité invalide pour ${spec.fileName} ($copied octets, MD5 $md5)."
        )
      }
      if (destination.exists() && !destination.delete()) {
        throw IllegalStateException("Impossible de remplacer ${spec.fileName}.")
      }
      if (!partial.renameTo(destination)) {
        throw IllegalStateException("Impossible d’installer ${spec.fileName}.")
      }
      sendProgress(spec, spec.sizeBytes, previousBytes + spec.sizeBytes, totalSize)
    } catch (error: Throwable) {
      partial.delete()
      throw error
    } finally {
      connection.disconnect()
    }
  }

  private fun sendProgress(spec: IndexSpec, fileBytes: Long, totalBytes: Long, totalSize: Long) {
    sendEvent(
      "onCatalogProgress",
      mapOf(
        "fileName" to spec.fileName,
        "fileBytes" to fileBytes,
        "fileSizeBytes" to spec.sizeBytes,
        "totalBytes" to totalBytes,
        "totalSizeBytes" to totalSize,
      )
    )
  }

  private fun importIndex(uriString: String) {
    val uri = Uri.parse(uriString)
    val displayName = queryDisplayName(uri) ?: uri.lastPathSegment.orEmpty().substringAfterLast('/')
    val spec = INDEXES.firstOrNull { it.fileName == displayName }
      ?: throw IllegalArgumentException("Fichier non reconnu : $displayName")
    val partial = partialFile(spec)
    partial.delete()
    val digest = MessageDigest.getInstance("MD5")
    var copied = 0L
    try {
      val input = if (uri.scheme == "file") {
        File(requireNotNull(uri.path)).inputStream()
      } else {
        requireNotNull(context().contentResolver.openInputStream(uri)) {
          "Impossible d’ouvrir $displayName"
        }
      }
      input.use { source ->
        FileOutputStream(partial).use { output ->
          val buffer = ByteArray(128 * 1024)
          while (true) {
            val count = source.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
            copied += count
          }
          output.fd.sync()
        }
      }
      val md5 = digest.digest().joinToString("") { "%02x".format(Locale.US, it.toInt() and 0xff) }
      if (copied != spec.sizeBytes || !md5.equals(spec.md5, ignoreCase = true)) {
        throw IllegalStateException("$displayName est incomplet ou corrompu.")
      }
      val destination = indexFile(spec)
      if (destination.exists()) destination.delete()
      if (!partial.renameTo(destination)) throw IllegalStateException("Impossible d’installer $displayName.")
    } finally {
      partial.delete()
    }
  }

  private fun queryDisplayName(uri: Uri): String? {
    if (uri.scheme != "content") return null
    var cursor: Cursor? = null
    return try {
      cursor = context().contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      if (cursor != null && cursor.moveToFirst()) cursor.getString(0) else null
    } finally {
      cursor?.close()
    }
  }

  private fun solveImage(uriString: String, focalLength: Int): Map<String, Any?> {
    val required = requiredIndexes(focalLength)
    val missing = required.filterNot(::isValid)
    if (missing.isNotEmpty()) {
      throw IllegalStateException("Catalogue incomplet : ${missing.joinToString { it.fileName }}")
    }
    val uri = Uri.parse(uriString)
    val bitmap = if (uri.scheme == "content") {
      requireNotNull(context().contentResolver.openInputStream(uri)) {
        "Impossible d'ouvrir l'image du Live View"
      }.use { BitmapFactory.decodeStream(it) }
    } else {
      val path = if (uri.scheme == "file") uri.path else uriString
      BitmapFactory.decodeFile(path)
    } ?: throw IllegalStateException("Impossible de décoder l’image Live View.")

    try {
      val downsample = AstrometryNative.computeDownsample(bitmap.width, bitmap.height)
      val stars = AstrometryNative.detectStars(bitmap, 8.0f, 1.0f, downsample)
        ?: throw IllegalStateException("Aucune étoile détectée dans le Live View.")
      if (stars.size < 10) {
        throw IllegalStateException("Seulement ${stars.size} étoiles détectées ; augmente l’ISO ou l’exposition du Live View.")
      }
      val expectedScale = ARCSECONDS_PER_RADIAN * SENSOR_WIDTH_MM / focalLength / bitmap.width
      val result = AstrometryNative.solveField(
        stars,
        bitmap.width,
        bitmap.height,
        required.map { indexFile(it).absolutePath }.toTypedArray(),
        expectedScale * 0.75,
        expectedScale * 1.25,
      )
      if (!result.solved) {
        throw IllegalStateException("Aucune solution astrométrique trouvée avec ${stars.size} étoiles.")
      }
      return mapOf(
        "solved" to true,
        "ra" to result.ra,
        "dec" to result.dec,
        "crpixX" to result.crpixX,
        "crpixY" to result.crpixY,
        "cd11" to result.cd[0],
        "cd12" to result.cd[1],
        "cd21" to result.cd[2],
        "cd22" to result.cd[3],
        "pixelScale" to result.pixelScale,
        "rotation" to result.rotation,
        "logOdds" to result.logOdds,
        "starCount" to stars.size,
        "imageWidth" to bitmap.width,
        "imageHeight" to bitmap.height,
      )
    } finally {
      bitmap.recycle()
    }
  }

  companion object {
    private const val INDEX_BASE_URL = "https://data.astrometry.net/4100"
    private const val ARCSECONDS_PER_RADIAN = 206264.80624709636
    private const val SENSOR_WIDTH_MM = 35.9

    private val INDEXES = listOf(
      IndexSpec(4109, 49_772_160L, "9a65a52ce04e3e75af950e5866f81b1b"),
      IndexSpec(4110, 24_871_680L, "d9aeb509b107d3bf8f79346329f1c0e3"),
      IndexSpec(4111, 10_206_720L, "cd7c149671d92a430bbe64c046ffcac3"),
      IndexSpec(4112, 5_296_320L, "76568e3703f492121a1affca7368f3c2"),
      IndexSpec(4113, 2_733_120L, "d36a7d5f06b0443f7951751733b1b088"),
      IndexSpec(4114, 1_382_400L, "0afbed8177b0e101dfc8925c5c077005"),
      IndexSpec(4115, 740_160L, "0db912aba86fa97159add4a65833ec10"),
      IndexSpec(4116, 408_960L, "b70cb06f819144de4c659524a735f4f3"),
      IndexSpec(4117, 247_680L, "ccf0ef3e8faac6feb0f5fb74d88a3152"),
      IndexSpec(4118, 187_200L, "a99b85c89f16e6d1ab6dbc19d9ac1d1a"),
      IndexSpec(4119, 144_000L, "25c404b35a08558a1404d3f6145abf1c"),
    )
  }
}
