import SonyCamera, { SonyCameraView } from 'expo-sony-camera';
import type { SonyCameraState } from 'expo-sony-camera';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type Operation = 'Connexion' | 'Démarrage du Live View' | 'Arrêt du Live View' | 'Déconnexion';

type DiagnosticRoute = {
  protocol?: string;
  transport?: string;
};

const connectedStates: SonyCameraState['state'][] = [
  'ready',
  'streaming',
  'capturing',
  'transferring',
  'recording',
];

const connectionStates: SonyCameraState['state'][] = [
  'discovering',
  'candidate_found',
  'joining_network',
  'connecting',
  'authenticating',
  'reconnecting',
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ActionButton({
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
        disabled && styles.disabledButton,
        pressed && !disabled && styles.pressedButton,
      ]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const camera = SonyCamera;
  const [cameraState, setCameraState] = useState<SonyCameraState | null>(() =>
    camera ? camera.getState() : null
  );
  const [operation, setOperation] = useState<Operation | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>(() =>
    camera ? camera.getDiagnostics().entries : []
  );
  const [diagnosticRoute, setDiagnosticRoute] = useState<DiagnosticRoute>(() => {
    if (!camera) return {};
    const snapshot = camera.getDiagnostics();
    return { protocol: snapshot.protocol, transport: snapshot.transport };
  });

  const stateName = cameraState?.state ?? 'unsupported';
  const connected = connectedStates.includes(stateName);
  const connecting = connectionStates.includes(stateName);
  const streaming = stateName === 'streaming';
  const busy = operation !== null;

  const statusColor = useMemo(() => {
    if (stateName === 'streaming') return '#54e397';
    if (stateName === 'ready') return '#65b8ff';
    if (stateName === 'error' || stateName === 'unsupported') return '#ff6b6b';
    return '#f4c95d';
  }, [stateName]);

  function refreshDiagnostics() {
    if (!camera) return;
    const snapshot = camera.getDiagnostics();
    setDiagnostics(snapshot.entries);
    setDiagnosticRoute({ protocol: snapshot.protocol, transport: snapshot.transport });
  }

  useEffect(() => {
    if (!camera) return;

    const initialState = camera.getState();
    setCameraState(initialState);
    refreshDiagnostics();

    const subscription = camera.addListener('onStateChanged', (nextState) => {
      setCameraState(nextState);
      refreshDiagnostics();
    });

    return () => subscription.remove();
  }, [camera]);

  async function run(name: Operation, task: () => Promise<SonyCameraState>) {
    if (!camera) return;
    setOperation(name);
    setLastError(null);

    try {
      const nextState = await task();
      setCameraState(nextState);
    } catch (error) {
      setLastError(errorMessage(error));
    } finally {
      refreshDiagnostics();
      setOperation(null);
    }
  }

  function connect() {
    // The ESP32 implementation talks directly to the A7R II ScalarWebAPI service at
    // 192.168.122.1:8080. Force the same Wi-Fi protocol instead of allowing automatic
    // selection of an attached USB/PTP camera.
    void run('Connexion', () =>
      camera!.connect({
        preferredProtocol: 'sony_scalar_webapi_v1',
        preferredTransport: 'scalar_http',
      })
    );
  }

  function startLiveView() {
    void run('Démarrage du Live View', () => camera!.startLiveView());
  }

  function stopLiveView() {
    void run('Arrêt du Live View', () => camera!.stopLiveView());
  }

  function disconnect() {
    void run('Déconnexion', () => camera!.disconnect());
  }

  if (!camera) {
    return (
      <SafeAreaView style={styles.centeredPage}>
        <StatusBar hidden />
        <Text style={styles.unavailableTitle}>Module Sony indisponible</Text>
        <Text style={styles.helpText}>
          Cette application doit être installée depuis l’APK natif. Elle ne peut pas fonctionner
          dans Expo Go ni dans un navigateur.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar hidden />

      <View style={styles.previewColumn}>
        <SonyCameraView active={streaming} style={StyleSheet.absoluteFill} />

        {!streaming ? (
          <View style={styles.previewPlaceholder} pointerEvents="none">
            <Text style={styles.previewTitle}>Live View Sony A7R II</Text>
            <Text style={styles.previewHint}>
              Lance Smart Remote Control sur le Sony, connecte Android au Wi-Fi du boîtier, puis
              appuie sur Connexion.
            </Text>
          </View>
        ) : null}

        <View style={styles.stateBadge}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.stateText}>{stateName}</Text>
        </View>
      </View>

      <View style={styles.controlColumn}>
        <ScrollView contentContainerStyle={styles.controls}>
          <Text style={styles.title}>Test A7R II</Text>
          <Text style={styles.subtitle}>ScalarWebAPI · Live View Wi-Fi</Text>

          <View style={styles.steps}>
            <Text style={styles.step}>1. Sony : ouvrir Smart Remote Control.</Text>
            <Text style={styles.step}>2. Android : rejoindre le Wi-Fi affiché par le Sony.</Text>
            <Text style={styles.step}>3. Appuyer sur Connexion, puis Démarrer Live View.</Text>
          </View>

          {operation ? (
            <View style={styles.operationRow}>
              <ActivityIndicator color="#f4c95d" />
              <Text style={styles.operationText}>{operation}…</Text>
            </View>
          ) : null}

          {cameraState?.message ? (
            <Text selectable style={styles.message}>
              {cameraState.message}
            </Text>
          ) : null}

          <Text selectable style={styles.route}>
            Modèle : {cameraState?.device?.model ?? 'non identifié'}{'\n'}
            Protocole : {diagnosticRoute.protocol ?? cameraState?.device?.protocol ?? 'en attente'}
            {'\n'}
            Transport : {diagnosticRoute.transport ?? cameraState?.device?.transport ?? 'en attente'}
          </Text>

          {lastError ? (
            <Text selectable style={styles.error}>
              Erreur : {lastError}
            </Text>
          ) : null}

          <View style={styles.buttonGrid}>
            <ActionButton
              title="Connexion Wi-Fi Sony"
              onPress={connect}
              disabled={busy || connected || connecting}
            />
            <ActionButton
              title="Démarrer Live View"
              onPress={startLiveView}
              disabled={busy || !connected || streaming}
            />
            <ActionButton
              title="Arrêter Live View"
              onPress={stopLiveView}
              disabled={busy || !streaming}
            />
            <ActionButton
              title="Déconnexion"
              onPress={disconnect}
              disabled={busy || !connected}
              danger
            />
          </View>

          <View style={styles.diagnosticsHeader}>
            <Text style={styles.diagnosticsTitle}>Diagnostics ({diagnostics.length})</Text>
            <Pressable onPress={refreshDiagnostics} style={styles.refreshButton}>
              <Text style={styles.refreshText}>Actualiser</Text>
            </Pressable>
          </View>

          <Text selectable style={styles.diagnostics}>
            {diagnostics.length > 0
              ? diagnostics.slice(-60).join('\n')
              : 'Aucun diagnostic. Lance la connexion.'}
          </Text>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#080b10',
  },
  centeredPage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#080b10',
  },
  unavailableTitle: {
    color: '#ff6b6b',
    fontSize: 26,
    fontWeight: '800',
    marginBottom: 14,
  },
  helpText: {
    maxWidth: 600,
    color: '#bdc7d5',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  previewColumn: {
    flex: 1.65,
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  previewPlaceholder: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  previewTitle: {
    color: '#e9eef6',
    fontSize: 26,
    fontWeight: '800',
  },
  previewHint: {
    maxWidth: 620,
    color: '#8492a5',
    fontSize: 15,
    lineHeight: 23,
    marginTop: 12,
    textAlign: 'center',
  },
  stateBadge: {
    position: 'absolute',
    top: 18,
    left: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(9, 14, 21, 0.82)',
  },
  statusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  stateText: {
    color: '#f3f6fa',
    fontFamily: 'monospace',
    fontSize: 13,
  },
  controlColumn: {
    flex: 1,
    maxWidth: 560,
    borderLeftColor: '#202836',
    borderLeftWidth: 1,
  },
  controls: {
    padding: 22,
    gap: 14,
  },
  title: {
    color: '#f3f6fa',
    fontSize: 28,
    fontWeight: '900',
  },
  subtitle: {
    color: '#65b8ff',
    fontSize: 14,
    marginTop: -8,
  },
  steps: {
    gap: 5,
    padding: 13,
    borderRadius: 10,
    backgroundColor: '#111722',
  },
  step: {
    color: '#bdc7d5',
    fontSize: 13,
    lineHeight: 19,
  },
  operationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  operationText: {
    color: '#f4c95d',
    fontSize: 13,
  },
  message: {
    color: '#d8e1ec',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  route: {
    padding: 10,
    borderRadius: 8,
    color: '#b9c8dc',
    backgroundColor: '#151d29',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
  },
  error: {
    padding: 10,
    borderRadius: 8,
    color: '#ffd8d8',
    backgroundColor: '#531f27',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  buttonGrid: {
    gap: 8,
  },
  button: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 9,
    backgroundColor: '#2164d7',
  },
  dangerButton: {
    backgroundColor: '#7b2a34',
  },
  disabledButton: {
    opacity: 0.32,
  },
  pressedButton: {
    opacity: 0.72,
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  diagnosticsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  diagnosticsTitle: {
    color: '#f3f6fa',
    fontSize: 15,
    fontWeight: '800',
  },
  refreshButton: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#202a39',
  },
  refreshText: {
    color: '#b9c8dc',
    fontSize: 12,
    fontWeight: '700',
  },
  diagnostics: {
    minHeight: 120,
    padding: 12,
    borderRadius: 8,
    color: '#9fb1c8',
    backgroundColor: '#0e141d',
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
  },
});
