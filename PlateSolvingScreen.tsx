import Astrometry from 'expo-astrometry';
import type {
  AstrometryCatalogStatus,
  AstrometrySolveResult,
  CatalogProgress,
} from 'expo-astrometry';
import * as DocumentPicker from 'expo-document-picker';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type SonyPhoto = {
  uri: string;
  width: number;
  height: number;
  fileName: string;
  mimeType: 'image/jpeg';
};

type CameraApi = {
  capturePreviewFrame(): Promise<SonyPhoto>;
};

type FocalLength = 50 | 90 | 180;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number) {
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} ko`;
  return `${(bytes / 1_000_000).toFixed(1)} Mo`;
}

function formatRa(degrees: number) {
  const hours = ((degrees / 15) % 24 + 24) % 24;
  const h = Math.floor(hours);
  const minutes = (hours - h) * 60;
  const m = Math.floor(minutes);
  const seconds = (minutes - m) * 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${seconds.toFixed(1)}s`;
}

function formatDec(degrees: number) {
  const sign = degrees < 0 ? '−' : '+';
  const absolute = Math.abs(degrees);
  const d = Math.floor(absolute);
  const minutes = (absolute - d) * 60;
  const m = Math.floor(minutes);
  const seconds = (minutes - m) * 60;
  return `${sign}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}′ ${seconds.toFixed(1)}″`;
}

function Button({
  title,
  onPress,
  disabled = false,
  danger = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        danger && styles.dangerButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export default function PlateSolvingScreen({
  camera,
  streaming,
  onClose,
}: {
  camera: CameraApi;
  streaming: boolean;
  onClose: () => void;
}) {
  const [focalLength, setFocalLength] = useState<FocalLength>(180);
  const [catalog, setCatalog] = useState<AstrometryCatalogStatus | null>(null);
  const [progress, setProgress] = useState<CatalogProgress | null>(null);
  const [busy, setBusy] = useState<'download' | 'import' | 'solve' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solution, setSolution] = useState<AstrometrySolveResult | null>(null);

  function refreshCatalog(nextFocal = focalLength) {
    try {
      setCatalog(Astrometry.getCatalogStatus(nextFocal));
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  }

  useEffect(() => {
    refreshCatalog();
    const subscription = Astrometry.addListener('onCatalogProgress', (next) => {
      setProgress(next);
    });
    return () => subscription.remove();
  }, []);

  const required = useMemo(
    () => catalog?.indexes.filter((index) => index.required) ?? [],
    [catalog]
  );
  const installedRequired = required.filter((index) => index.valid).length;
  const progressRatio = progress && progress.totalSizeBytes > 0
    ? Math.min(1, progress.totalBytes / progress.totalSizeBytes)
    : 0;

  function chooseFocal(next: FocalLength) {
    setFocalLength(next);
    setSolution(null);
    setMessage(null);
    setError(null);
    refreshCatalog(next);
  }

  async function download() {
    setBusy('download');
    setError(null);
    setMessage('Téléchargement des index… Ne te connecte pas encore au Wi-Fi du Sony.');
    setProgress(null);
    try {
      const next = await Astrometry.downloadCatalog(focalLength);
      setCatalog(next);
      setMessage(`Catalogue ${focalLength} mm prêt.`);
    } catch (nextError) {
      setError(errorMessage(nextError));
      refreshCatalog();
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function importFiles() {
    setError(null);
    const selection = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      multiple: true,
      copyToCacheDirectory: false,
    });
    if (selection.canceled) return;
    setBusy('import');
    try {
      for (const asset of selection.assets) {
        setMessage(`Import de ${asset.name}…`);
        await Astrometry.importIndex(asset.uri);
      }
      refreshCatalog();
      setMessage(`${selection.assets.length} fichier${selection.assets.length > 1 ? 's' : ''} importé${selection.assets.length > 1 ? 's' : ''}.`);
    } catch (nextError) {
      setError(errorMessage(nextError));
      refreshCatalog();
    } finally {
      setBusy(null);
    }
  }

  async function solve() {
    setBusy('solve');
    setError(null);
    setMessage('Capture de la meilleure frame Live View…');
    setSolution(null);
    try {
      const frame = await camera.capturePreviewFrame();
      setMessage(`Détection des étoiles dans ${frame.width} × ${frame.height}, puis résolution…`);
      const result = await Astrometry.solveImage(frame.uri, focalLength);
      setSolution(result);
      setMessage('Champ résolu hors ligne.');
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }

  function confirmDelete() {
    Alert.alert(
      'Supprimer les catalogues ?',
      'Les index devront être téléchargés ou importés à nouveau.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            Astrometry.deleteCatalog();
            refreshCatalog();
            setSolution(null);
            setMessage('Catalogues supprimés.');
          },
        },
      ]
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar hidden />
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Plate solving hors ligne</Text>
          <Text style={styles.subtitle}>Astrometry.net · Sony A7R II Live View</Text>
        </View>
        <Button title="Retour" onPress={onClose} disabled={busy !== null} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>1. Focale utilisée</Text>
          <View style={styles.row}>
            {([50, 90, 180] as FocalLength[]).map((value) => (
              <Pressable
                key={value}
                disabled={busy !== null}
                onPress={() => chooseFocal(value)}
                style={[styles.choice, focalLength === value && styles.choiceSelected]}>
                <Text style={[styles.choiceText, focalLength === value && styles.choiceTextSelected]}>
                  {value} mm
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>
            Capteur plein format 35,9 mm. La tolérance de recherche est de ±25 % autour de la focale choisie.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>2. Catalogue</Text>
          {catalog ? (
            <>
              <Text style={catalog.ready ? styles.success : styles.warning}>
                {catalog.ready
                  ? `PRÊT · ${installedRequired}/${required.length} index requis`
                  : `INCOMPLET · ${installedRequired}/${required.length} index requis`}
              </Text>
              <Text style={styles.details}>
                Pack {focalLength} mm : {formatBytes(catalog.requiredBytes)} · installé au total :{' '}
                {formatBytes(catalog.installedBytes)}
              </Text>
              <Text selectable style={styles.path}>{catalog.directory}</Text>
            </>
          ) : null}

          {busy === 'download' && progress ? (
            <View style={styles.progressBlock}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progressRatio * 100}%` }]} />
              </View>
              <Text style={styles.details}>
                {progress.fileName} · {formatBytes(progress.fileBytes)}/{formatBytes(progress.fileSizeBytes)} · total{' '}
                {(progressRatio * 100).toFixed(0)} %
              </Text>
            </View>
          ) : null}

          <View style={styles.rowWrap}>
            <Button
              title={catalog?.ready ? 'Vérifier / compléter' : `Télécharger le pack ${focalLength} mm`}
              onPress={() => void download()}
              disabled={busy !== null}
            />
            <Button title="Importer des .fits" onPress={() => void importFiles()} disabled={busy !== null} />
            {busy === 'download' ? (
              <Button title="Annuler" onPress={() => Astrometry.cancelCatalogDownload()} danger />
            ) : null}
            <Button title="Supprimer les index" onPress={confirmDelete} disabled={busy !== null} danger />
          </View>
          <Text style={styles.hint}>
            Le téléchargement nécessite Internet. Les fichiers restent installés lors des mises à jour de l’APK.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>3. Résoudre le Live View</Text>
          <Text style={styles.hint}>
            Lance le Live View avant d’ouvrir cet écran. L’image analysée est une frame JPEG de prévisualisation ; aucune photo n’est déclenchée.
          </Text>
          <Button
            title="Résoudre le champ"
            onPress={() => void solve()}
            disabled={busy !== null || !streaming || !catalog?.ready}
          />
          {!streaming ? <Text style={styles.warning}>Le Live View n’est pas actif.</Text> : null}
        </View>

        {busy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator color="#f4c95d" />
            <Text style={styles.message}>{message}</Text>
          </View>
        ) : message ? <Text style={styles.message}>{message}</Text> : null}

        {error ? <Text selectable style={styles.error}>Erreur : {error}</Text> : null}

        {solution ? (
          <View style={[styles.card, styles.solutionCard]}>
            <Text style={styles.solutionTitle}>Champ résolu</Text>
            <Text selectable style={styles.coordinates}>
              RA   {formatRa(solution.ra)}  ({solution.ra.toFixed(6)}°){'\n'}
              Dec  {formatDec(solution.dec)}  ({solution.dec.toFixed(6)}°)
            </Text>
            <Text style={styles.details}>
              Rotation {solution.rotation.toFixed(2)}° · échelle {solution.pixelScale.toFixed(2)}″/px
              {'\n'}{solution.starCount} étoiles · image {solution.imageWidth} × {solution.imageHeight}
              {'\n'}Confiance log-odds {solution.logOdds.toFixed(1)}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#080b10' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#202836',
  },
  title: { color: '#f3f6fa', fontSize: 25, fontWeight: '900' },
  subtitle: { color: '#65b8ff', fontSize: 13, marginTop: 3 },
  content: { padding: 20, gap: 14, maxWidth: 1000, width: '100%', alignSelf: 'center' },
  card: {
    padding: 16,
    gap: 11,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#344258',
    backgroundColor: '#111722',
  },
  cardTitle: { color: '#f3f6fa', fontSize: 17, fontWeight: '800' },
  row: { flexDirection: 'row', gap: 10 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  choice: {
    minWidth: 92,
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#4a5f78',
    backgroundColor: '#151d29',
  },
  choiceSelected: { borderColor: '#f4c95d', backgroundColor: '#3d3218' },
  choiceText: { color: '#bdc7d5', fontWeight: '800' },
  choiceTextSelected: { color: '#f4c95d' },
  hint: { color: '#9aa9bc', fontSize: 12, lineHeight: 18 },
  details: { color: '#bdc7d5', fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
  path: { color: '#7f91a8', fontFamily: 'monospace', fontSize: 10 },
  success: { color: '#54e397', fontWeight: '900' },
  warning: { color: '#f4c95d', fontWeight: '800' },
  button: {
    minHeight: 42,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#1f6fae',
  },
  dangerButton: { backgroundColor: '#7d3038' },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.72 },
  buttonText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  progressBlock: { gap: 7 },
  progressTrack: { height: 8, overflow: 'hidden', borderRadius: 4, backgroundColor: '#263143' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: '#54e397' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
  message: { color: '#d8e1ec', fontSize: 13 },
  error: {
    padding: 12,
    borderRadius: 8,
    color: '#ffd8d8',
    backgroundColor: '#531f27',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  solutionCard: { borderColor: '#2d8c68', backgroundColor: '#10241e' },
  solutionTitle: { color: '#54e397', fontSize: 21, fontWeight: '900' },
  coordinates: { color: '#f3f6fa', fontFamily: 'monospace', fontSize: 17, lineHeight: 27 },
});
