import type {
  SonyBulbCaptureResult,
  SonyCameraState,
  SonyIsoSpeedRates,
} from 'expo-sony-camera';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const MIN_EXPOSURE_SECONDS = 5;
const MAX_EXPOSURE_SECONDS = 300;
const EXPOSURE_STEP_SECONDS = 5;
const INTERVAL_SECONDS = 1;
const FALLBACK_ISO = ['100', '200', '400', '640', '800', '1600', '3200', '6400', '12800'];

type CaptureMode = 'idle' | 'single' | 'timelapse' | 'stopping';
type ExposureType = 'standard30' | 'bulb';

type CameraClient = {
  getState(): SonyCameraState;
  startLiveView(): Promise<SonyCameraState>;
  stopLiveView(): Promise<SonyCameraState>;
  getIsoSpeedRates(): Promise<SonyIsoSpeedRates>;
  configureCaptureSettings?(shutterSpeed: '30"' | 'BULB', iso: string): Promise<SonyIsoSpeedRates>;
  captureBulb(exposureSeconds: number, iso: string): Promise<SonyBulbCaptureResult>;
  captureThirtySecond(iso: string): Promise<SonyBulbCaptureResult>;
  cancelBulbCapture(): { ok: boolean; active: boolean };
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes} min ${remainder.toString().padStart(2, '0')} s` : `${remainder} s`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ExposureSlider({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const widthRef = useRef(1);
  const setFromPosition = (position: number) => {
    if (disabled) return;
    const ratio = clamp(position / widthRef.current, 0, 1);
    const steps = Math.round(
      (ratio * (MAX_EXPOSURE_SECONDS - MIN_EXPOSURE_SECONDS)) / EXPOSURE_STEP_SECONDS
    );
    onChange(MIN_EXPOSURE_SECONDS + steps * EXPOSURE_STEP_SECONDS);
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => setFromPosition(event.nativeEvent.locationX),
        onPanResponderMove: (event) => setFromPosition(event.nativeEvent.locationX),
      }),
    [disabled, onChange]
  );
  const progress =
    ((value - MIN_EXPOSURE_SECONDS) / (MAX_EXPOSURE_SECONDS - MIN_EXPOSURE_SECONDS)) * 100;

  return (
    <View
      accessible
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      accessibilityRole="adjustable"
      accessibilityValue={{ min: MIN_EXPOSURE_SECONDS, max: MAX_EXPOSURE_SECONDS, now: value }}
      onAccessibilityAction={(event) => {
        if (disabled) return;
        const direction = event.nativeEvent.actionName === 'increment' ? 1 : -1;
        onChange(clamp(value + direction * EXPOSURE_STEP_SECONDS, MIN_EXPOSURE_SECONDS, MAX_EXPOSURE_SECONDS));
      }}
      onLayout={(event) => {
        widthRef.current = Math.max(1, event.nativeEvent.layout.width);
      }}
      style={[styles.slider, disabled && styles.disabled]}
      {...responder.panHandlers}>
      <View style={[styles.sliderFill, { width: `${progress}%` }]} />
      <View style={[styles.sliderThumb, { left: `${progress}%` }]} />
    </View>
  );
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
        pressed && !disabled && styles.buttonPressed,
      ]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export default function CaptureAssistantScreen({
  camera,
  onClose,
}: {
  camera: CameraClient;
  onClose: () => void;
}) {
  const [exposureSeconds, setExposureSeconds] = useState(60);
  const [exposureType, setExposureType] = useState<ExposureType>('standard30');
  const [isoValues, setIsoValues] = useState(FALLBACK_ISO);
  const [selectedIso, setSelectedIso] = useState('800');
  const [settingsPending, setSettingsPending] = useState(false);
  const [mode, setMode] = useState<CaptureMode>('idle');
  const [photoCount, setPhotoCount] = useState(0);
  const [exposureEndsAt, setExposureEndsAt] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [status, setStatus] = useState('Prêt pour une prise de vue.');
  const [lastError, setLastError] = useState<string | null>(null);
  const stopRequestedRef = useRef(false);
  const resumeLiveViewRef = useRef(false);
  const active = mode !== 'idle';

  useEffect(() => {
    let mounted = true;
    void camera
      .getIsoSpeedRates()
      .then((settings) => {
        if (!mounted) return;
        const values = settings.available
          .filter((value) => value !== 'AUTO' && /^\d+$/.test(value))
          .sort((left, right) => Number(left) - Number(right));
        if (values.length > 0) setIsoValues(values);
        if (settings.current && settings.current !== 'AUTO' && values.includes(settings.current)) {
          setSelectedIso(settings.current);
        }
        setStatus('Réglages ISO chargés depuis le boîtier.');
      })
      .catch((error) => {
        if (mounted) setStatus(`Valeurs ISO standards affichées · lecture Sony impossible : ${errorMessage(error)}`);
      });
    return () => {
      mounted = false;
      stopRequestedRef.current = true;
      camera.cancelBulbCapture();
    };
  }, [camera]);

  async function applyCameraSettings(nextType: ExposureType, nextIso: string) {
    setSettingsPending(true);
    setLastError(null);
    setStatus('Mise à jour des réglages sur le boîtier…');
    try {
      if (typeof camera.configureCaptureSettings !== 'function') {
        throw new Error('APK natif trop ancien. Installe la version 0.2.2 recompilée.');
      }
      const settings = await camera.configureCaptureSettings(
        nextType === 'standard30' ? '30"' : 'BULB',
        nextIso
      );
      const values = settings.available
        .filter((value) => value !== 'AUTO' && /^\d+$/.test(value))
        .sort((left, right) => Number(left) - Number(right));
      if (values.length > 0) setIsoValues(values);
      setExposureType(nextType);
      setSelectedIso(settings.current && settings.current !== 'AUTO' ? settings.current : nextIso);
      setStatus(`Boîtier réglé sur ${nextType === 'standard30' ? '30 s' : 'BULB'} · ISO ${nextIso}.`);
    } catch (error) {
      setLastError(errorMessage(error));
      setStatus('Le boîtier a refusé la mise à jour des réglages.');
    } finally {
      setSettingsPending(false);
    }
  }

  useEffect(() => {
    if (exposureEndsAt === null) {
      setRemainingSeconds(0);
      return;
    }
    const update = () => setRemainingSeconds(Math.max(0, Math.ceil((exposureEndsAt - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [exposureEndsAt]);

  async function prepareSequence() {
    stopRequestedRef.current = false;
    setLastError(null);
    const wasStreaming = camera.getState().state === 'streaming';
    resumeLiveViewRef.current = wasStreaming;
    if (wasStreaming) {
      setStatus('Arrêt du Live View…');
      await camera.stopLiveView();
    }
  }

  async function restoreLiveView() {
    if (!resumeLiveViewRef.current) return;
    setStatus('Redémarrage du Live View…');
    try {
      await camera.startLiveView();
    } catch (error) {
      setLastError(`La séquence est terminée, mais le Live View n’a pas redémarré : ${errorMessage(error)}`);
    } finally {
      resumeLiveViewRef.current = false;
    }
  }

  async function exposeOnce() {
    const duration = exposureType === 'standard30' ? 30 : exposureSeconds;
    setExposureEndsAt(Date.now() + duration * 1_000);
    setStatus(
      exposureType === 'standard30'
        ? `Pose standard 30 s · RAW 14 bits · ISO ${selectedIso}`
        : `Pose BULB · RAW 12 bits · ISO ${selectedIso}`
    );
    try {
      return exposureType === 'standard30'
        ? await camera.captureThirtySecond(selectedIso)
        : await camera.captureBulb(exposureSeconds, selectedIso);
    } finally {
      setExposureEndsAt(null);
    }
  }

  async function runSingle() {
    setMode('single');
    try {
      await prepareSequence();
      if (stopRequestedRef.current) {
        setStatus('Prise de vue annulée.');
        return;
      }
      const result = await exposeOnce();
      if (!result.stoppedEarly) {
        setPhotoCount((count) => count + 1);
        setStatus(`Photo terminée · ${(result.actualDurationMs / 1_000).toFixed(1)} s`);
      } else {
        setStatus('Pose interrompue.');
      }
    } catch (error) {
      setLastError(errorMessage(error));
      setStatus('Échec de la prise de vue.');
    } finally {
      await restoreLiveView();
      setMode('idle');
    }
  }

  async function waitBetweenPhotos() {
    setStatus(`Pause ${INTERVAL_SECONDS} s avant la prochaine photo…`);
    const deadline = Date.now() + INTERVAL_SECONDS * 1_000;
    while (!stopRequestedRef.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function runTimelapse() {
    setMode('timelapse');
    setPhotoCount(0);
    try {
      await prepareSequence();
      while (!stopRequestedRef.current) {
        const result = await exposeOnce();
        if (!result.stoppedEarly) setPhotoCount((count) => count + 1);
        if (result.stoppedEarly || stopRequestedRef.current) break;
        await waitBetweenPhotos();
      }
      setStatus('Timelapse arrêté.');
    } catch (error) {
      setLastError(errorMessage(error));
      setStatus('Timelapse interrompu par une erreur.');
    } finally {
      await restoreLiveView();
      setMode('idle');
    }
  }

  function stopCapture() {
    stopRequestedRef.current = true;
    setMode('stopping');
    if (exposureType === 'bulb') {
      setStatus('Arrêt demandé · fermeture de l’obturateur…');
      camera.cancelBulbCapture();
    } else {
      setStatus('Arrêt demandé · attente de la fin de la pose de 30 s…');
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Prise de vue</Text>
            <Text style={styles.subtitle}>Sony A7R II · RAW 14 bits ou BULB</Text>
          </View>
          <Button title="Retour" onPress={onClose} disabled={active || settingsPending} />
        </View>

        <View style={styles.panel}>
          <Text style={styles.label}>Mode d’exposition</Text>
          <View style={styles.modeRow}>
            <Pressable
              accessibilityRole="button"
              disabled={active || settingsPending}
              onPress={() => void applyCameraSettings('standard30', selectedIso)}
              style={({ pressed }) => [
                styles.modeButton,
                exposureType === 'standard30' && styles.modeButtonSelected,
                (active || settingsPending) && styles.disabled,
                pressed && !active && !settingsPending && styles.buttonPressed,
              ]}>
              <Text style={styles.modeTitle}>30 s standard</Text>
              <Text style={styles.modeDetail}>RAW 14 bits</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={active || settingsPending}
              onPress={() => void applyCameraSettings('bulb', selectedIso)}
              style={({ pressed }) => [
                styles.modeButton,
                exposureType === 'bulb' && styles.modeButtonSelected,
                (active || settingsPending) && styles.disabled,
                pressed && !active && !settingsPending && styles.buttonPressed,
              ]}>
              <Text style={styles.modeTitle}>BULB</Text>
              <Text style={styles.modeDetail}>5–300 s · RAW 12 bits</Text>
            </Pressable>
          </View>
        </View>

        {exposureType === 'bulb' ? (
          <View style={styles.panel}>
            <Text style={styles.label}>Temps de pose BULB</Text>
            <Text style={styles.exposureValue}>{formatDuration(exposureSeconds)}</Text>
            <ExposureSlider value={exposureSeconds} onChange={setExposureSeconds} disabled={active || settingsPending} />
            <View style={styles.rangeRow}>
              <Text style={styles.hint}>5 s</Text>
              <Text style={styles.hint}>Pas de 5 s</Text>
              <Text style={styles.hint}>5 min</Text>
            </View>
          </View>
        ) : (
          <View style={styles.standardPanel}>
            <Text style={styles.standardValue}>30 secondes</Text>
            <Text style={styles.standardText}>
              Pose temporisée par le boîtier afin de conserver la lecture RAW 14 bits de l’A7R II.
            </Text>
          </View>
        )}

        <View style={styles.panel}>
          <Text style={styles.label}>ISO</Text>
          <View style={styles.isoGrid}>
            {isoValues.map((iso) => (
              <Pressable
                key={iso}
                accessibilityRole="button"
                disabled={active || settingsPending}
                onPress={() => void applyCameraSettings(exposureType, iso)}
                style={({ pressed }) => [
                  styles.isoButton,
                  selectedIso === iso && styles.isoButtonSelected,
                  (active || settingsPending) && styles.disabled,
                  pressed && !active && !settingsPending && styles.buttonPressed,
                ]}>
                <Text style={[styles.isoText, selectedIso === iso && styles.isoTextSelected]}>{iso}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.statusPanel}>
          {active || settingsPending ? <ActivityIndicator color="#f4c95d" size="large" /> : null}
          <Text style={styles.status}>{status}</Text>
          {exposureEndsAt !== null ? (
            <Text style={styles.countdown}>{formatDuration(remainingSeconds)} restantes</Text>
          ) : null}
          <Text style={styles.counter}>Photos terminées : {photoCount}</Text>
          {lastError ? <Text selectable style={styles.error}>Erreur : {lastError}</Text> : null}
        </View>

        <View style={styles.actions}>
          {active ? (
            <Button
              title={
                mode === 'stopping'
                  ? 'Arrêt en cours…'
                  : exposureType === 'standard30'
                    ? 'Arrêter après cette pose'
                    : 'Arrêter'
              }
              onPress={stopCapture}
              disabled={mode === 'stopping'}
              danger
            />
          ) : (
            <>
              <Button title="Prendre une photo" onPress={() => void runSingle()} disabled={settingsPending} />
              <Button title="Démarrer le timelapse" onPress={() => void runTimelapse()} disabled={settingsPending} />
            </>
          )}
        </View>

        <Text style={styles.footer}>
          Le timelapse attend 1 seconde après la fin de chaque pose. L’écran reste actif pendant la pose. Utilise le mode 30 s standard pour le RAW 14 bits et BULB pour les poses longues en 12 bits. La réduction de bruit longue pose doit être désactivée.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#080b10' },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 24, gap: 18 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16 },
  title: { color: '#f3f6fa', fontSize: 30, fontWeight: '900' },
  subtitle: { color: '#8492a5', fontSize: 15, marginTop: 3 },
  panel: { padding: 20, borderRadius: 16, backgroundColor: '#111722', borderWidth: 1, borderColor: '#202b3a' },
  label: { color: '#bdc7d5', fontSize: 16, fontWeight: '700' },
  exposureValue: { color: '#f4c95d', fontSize: 36, fontWeight: '900', marginVertical: 14, textAlign: 'center' },
  modeRow: { flexDirection: 'row', gap: 12, marginTop: 14 },
  modeButton: { flex: 1, minHeight: 78, alignItems: 'center', justifyContent: 'center', padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#40516a', backgroundColor: '#151e2b' },
  modeButtonSelected: { borderColor: '#f4c95d', backgroundColor: '#4c4020' },
  modeTitle: { color: '#f3f6fa', fontSize: 16, fontWeight: '800' },
  modeDetail: { color: '#aab7c8', fontSize: 12, marginTop: 4, textAlign: 'center' },
  standardPanel: { alignItems: 'center', padding: 20, borderRadius: 16, backgroundColor: '#14221d', borderWidth: 1, borderColor: '#356b54' },
  standardValue: { color: '#54e397', fontSize: 30, fontWeight: '900' },
  standardText: { color: '#b9d5c8', fontSize: 14, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  slider: { height: 42, justifyContent: 'center', marginHorizontal: 10 },
  sliderFill: { position: 'absolute', left: 0, height: 7, borderRadius: 4, backgroundColor: '#f4c95d' },
  sliderThumb: { position: 'absolute', width: 28, height: 28, marginLeft: -14, borderRadius: 14, backgroundColor: '#f4c95d', borderWidth: 3, borderColor: '#fff4c7' },
  rangeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  hint: { color: '#718096', fontSize: 12 },
  isoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 14 },
  isoButton: { minWidth: 76, paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: '#40516a', backgroundColor: '#151e2b' },
  isoButtonSelected: { borderColor: '#f4c95d', backgroundColor: '#4c4020' },
  isoText: { color: '#bdc7d5', fontSize: 15, fontWeight: '700' },
  isoTextSelected: { color: '#fff4c7' },
  statusPanel: { alignItems: 'center', gap: 9, padding: 20, borderRadius: 16, backgroundColor: '#0e141e' },
  status: { color: '#d9e1ec', fontSize: 16, textAlign: 'center' },
  countdown: { color: '#f4c95d', fontSize: 28, fontWeight: '900' },
  counter: { color: '#8da0b8', fontFamily: 'monospace', fontSize: 14 },
  error: { color: '#ff8787', lineHeight: 20, textAlign: 'center' },
  actions: { gap: 12 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 11, backgroundColor: '#304b70', borderWidth: 1, borderColor: '#4f6f99' },
  dangerButton: { backgroundColor: '#722f37', borderColor: '#a44b55' },
  buttonText: { color: '#f3f6fa', fontSize: 15, fontWeight: '800', textAlign: 'center' },
  buttonPressed: { opacity: 0.72 },
  disabled: { opacity: 0.4 },
  footer: { color: '#718096', fontSize: 13, lineHeight: 20, textAlign: 'center', marginBottom: 24 },
});
