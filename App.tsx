import SonyCamera, { SonyCameraView } from 'expo-sony-camera';
import type { SonyCameraState, SonyStarTrackingSample } from 'expo-sony-camera';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PanResponder,
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

type Point = { x: number; y: number };
type PreviewSize = { width: number; height: number };
type RobustLineFit = {
  start: Point;
  end: Point;
  inliers: boolean[];
  inlierCount: number;
};

const MAX_PREVIEW_ZOOM = 10;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function touchDistance(touches: readonly { pageX: number; pageY: number }[]) {
  if (touches.length < 2) return 0;
  return Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
}

function boundedPan(point: Point, scale: number, size: PreviewSize): Point {
  const maximumX = Math.max(0, (size.width * (scale - 1)) / 2);
  const maximumY = Math.max(0, (size.height * (scale - 1)) / 2);
  return {
    x: clamp(point.x, -maximumX, maximumX),
    y: clamp(point.y, -maximumY, maximumY),
  };
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function totalLeastSquares(points: Point[]) {
  if (points.length < 2) return null;
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 }
  );
  center.x /= points.length;
  center.y /= points.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  if (xx + yy < 1e-6) return null;
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  return {
    center,
    direction: { x: Math.cos(angle), y: Math.sin(angle) },
  };
}

function pointLineDistance(point: Point, center: Point, direction: Point) {
  return Math.abs(
    (point.x - center.x) * -direction.y + (point.y - center.y) * direction.x
  );
}

/** Robust orthogonal fit: pair consensus followed by iterative MAD rejection. */
function fitRobustLine(points: Point[], size: PreviewSize): RobustLineFit | null {
  if (points.length < 6 || size.width <= 0 || size.height <= 0) return null;
  const pixels = points.map((point) => ({ x: point.x * size.width, y: point.y * size.height }));
  const consensusThreshold = 3;
  let bestInliers: boolean[] | null = null;
  let bestCount = 0;
  let bestResidual = Number.POSITIVE_INFINITY;

  // With at most 40 samples, testing every pair is inexpensive and deterministic.
  for (let first = 0; first < pixels.length - 1; first += 1) {
    for (let second = first + 1; second < pixels.length; second += 1) {
      const dx = pixels[second].x - pixels[first].x;
      const dy = pixels[second].y - pixels[first].y;
      const length = Math.hypot(dx, dy);
      if (length < 2) continue;
      const direction = { x: dx / length, y: dy / length };
      const distances = pixels.map((point) =>
        pointLineDistance(point, pixels[first], direction)
      );
      const inliers = distances.map((distance) => distance <= consensusThreshold);
      const count = inliers.filter(Boolean).length;
      const residual = distances.reduce(
        (sum, distance, index) => sum + (inliers[index] ? distance : 0),
        0
      );
      if (count > bestCount || (count === bestCount && residual < bestResidual)) {
        bestInliers = inliers;
        bestCount = count;
        bestResidual = residual;
      }
    }
  }
  if (!bestInliers || bestCount < 4) return null;

  let inliers = bestInliers;
  let line = totalLeastSquares(pixels.filter((_, index) => inliers[index]));
  if (!line) return null;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const distances = pixels.map((point) =>
      pointLineDistance(point, line!.center, line!.direction)
    );
    const acceptedDistances = distances.filter((_, index) => inliers[index]);
    const distanceMedian = median(acceptedDistances);
    const mad = median(acceptedDistances.map((distance) => Math.abs(distance - distanceMedian)));
    const rejectionThreshold = clamp(distanceMedian + 3 * 1.4826 * mad, 2, 8);
    const nextInliers = distances.map((distance) => distance <= rejectionThreshold);
    if (nextInliers.filter(Boolean).length < 4) break;
    inliers = nextInliers;
    line = totalLeastSquares(pixels.filter((_, index) => inliers[index]));
    if (!line) return null;
  }

  const accepted = pixels.filter((_, index) => inliers[index]);
  const projections = accepted.map(
    (point) =>
      (point.x - line!.center.x) * line!.direction.x +
      (point.y - line!.center.y) * line!.direction.y
  );
  let minimum = Math.min(...projections);
  let maximum = Math.max(...projections);
  if (maximum - minimum < 4) return null;
  const extension = Math.min(12, Math.max(4, (maximum - minimum) * 0.08));
  minimum -= extension;
  maximum += extension;
  const endpoint = (projection: number) => ({
    x: (line!.center.x + projection * line!.direction.x) / size.width,
    y: (line!.center.y + projection * line!.direction.y) / size.height,
  });
  return {
    start: endpoint(minimum),
    end: endpoint(maximum),
    inliers,
    inlierCount: inliers.filter(Boolean).length,
  };
}

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
  const [previewSize, setPreviewSize] = useState<PreviewSize>({ width: 0, height: 0 });
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState<Point>({ x: 0, y: 0 });
  const [selectedStar, setSelectedStar] = useState<Point | null>(null);
  const [trackingSample, setTrackingSample] = useState<SonyStarTrackingSample | null>(null);
  const [trackingTrail, setTrackingTrail] = useState<Point[]>([]);
  const previewSizeRef = useRef(previewSize);
  const previewZoomRef = useRef(previewZoom);
  const previewPanRef = useRef(previewPan);
  const gestureRef = useRef({
    startedAt: 0,
    initialTouchCount: 0,
    initialDistance: 0,
    initialZoom: 1,
    initialPan: { x: 0, y: 0 },
    moved: false,
  });

  const stateName = cameraState?.state ?? 'unsupported';
  const connected = connectedStates.includes(stateName);
  const connecting = connectionStates.includes(stateName);
  const streaming = stateName === 'streaming';
  const busy = operation !== null;

  function updatePreviewZoom(next: number) {
    const zoom = clamp(next, 1, MAX_PREVIEW_ZOOM);
    previewZoomRef.current = zoom;
    setPreviewZoom(zoom);
    const pan = boundedPan(previewPanRef.current, zoom, previewSizeRef.current);
    previewPanRef.current = pan;
    setPreviewPan(pan);
  }

  function updatePreviewPan(next: Point) {
    const pan = boundedPan(next, previewZoomRef.current, previewSizeRef.current);
    previewPanRef.current = pan;
    setPreviewPan(pan);
  }

  function resetPreviewNavigation() {
    previewZoomRef.current = 1;
    previewPanRef.current = { x: 0, y: 0 };
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
    setSelectedStar(null);
    setTrackingSample(null);
    setTrackingTrail([]);
    camera?.clearStarTracking?.();
  }

  function selectStarAt(screenX: number, screenY: number) {
    const size = previewSizeRef.current;
    if (size.width <= 0 || size.height <= 0) return;
    const zoom = previewZoomRef.current;
    const pan = previewPanRef.current;
    const imageX = (screenX - size.width / 2 - pan.x) / zoom + size.width / 2;
    const imageY = (screenY - size.height / 2 - pan.y) / zoom + size.height / 2;
    const point = {
      x: clamp(imageX / size.width, 0, 1),
      y: clamp(imageY / size.height, 0, 1),
    };
    setSelectedStar(point);
    setTrackingSample(null);
    setTrackingTrail([]);
    camera?.setStarTrackingPoint?.(point.x, point.y, size.width, size.height);
  }

  const previewResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => streaming,
        onMoveShouldSetPanResponder: () => streaming,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          gestureRef.current = {
            startedAt: Date.now(),
            initialTouchCount: touches.length,
            initialDistance: touchDistance(touches),
            initialZoom: previewZoomRef.current,
            initialPan: previewPanRef.current,
            moved: false,
          };
        },
        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches;
          const session = gestureRef.current;
          if (touches.length >= 2) {
            const distance = touchDistance(touches);
            // Android normally grants the responder to the first finger. Initialise the
            // pinch baseline when the second finger actually arrives, not only at grant.
            if (session.initialTouchCount < 2 || session.initialDistance <= 0) {
              session.initialTouchCount = 2;
              session.initialDistance = distance;
              session.initialZoom = previewZoomRef.current;
              session.initialPan = previewPanRef.current;
              session.moved = true;
              return;
            }
            const zoom = clamp(
              session.initialZoom * (distance / session.initialDistance),
              1,
              MAX_PREVIEW_ZOOM
            );
            if (Math.abs(zoom - session.initialZoom) > 0.015) session.moved = true;
            updatePreviewZoom(zoom);
          } else if (session.initialTouchCount === 1 && previewZoomRef.current > 1) {
            if (Math.hypot(gesture.dx, gesture.dy) > 5) session.moved = true;
            updatePreviewPan({
              x: session.initialPan.x + gesture.dx,
              y: session.initialPan.y + gesture.dy,
            });
          }
        },
        onPanResponderRelease: (event, gesture) => {
          const session = gestureRef.current;
          const wasTap =
            session.initialTouchCount === 1 &&
            !session.moved &&
            Math.hypot(gesture.dx, gesture.dy) < 6 &&
            Date.now() - session.startedAt < 500;
          if (wasTap) selectStarAt(event.nativeEvent.locationX, event.nativeEvent.locationY);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [streaming]
  );

  const selectedStarScreen = useMemo(() => {
    if (!selectedStar || previewSize.width <= 0 || previewSize.height <= 0) return null;
    return {
      x:
        (selectedStar.x * previewSize.width - previewSize.width / 2) * previewZoom +
        previewSize.width / 2 +
        previewPan.x,
      y:
        (selectedStar.y * previewSize.height - previewSize.height / 2) * previewZoom +
        previewSize.height / 2 +
        previewPan.y,
    };
  }, [previewPan, previewSize, previewZoom, selectedStar]);

  function pointToScreen(point: Point): Point {
    return {
      x:
        (point.x * previewSize.width - previewSize.width / 2) * previewZoom +
        previewSize.width / 2 +
        previewPan.x,
      y:
        (point.y * previewSize.height - previewSize.height / 2) * previewZoom +
        previewSize.height / 2 +
        previewPan.y,
    };
  }

  const trackedStarScreen = useMemo(
    () => (trackingSample ? pointToScreen({ x: trackingSample.x, y: trackingSample.y }) : null),
    [previewPan, previewSize, previewZoom, trackingSample]
  );

  const trailOnScreen = useMemo(
    () => trackingTrail.map(pointToScreen),
    [previewPan, previewSize, previewZoom, trackingTrail]
  );

  const robustDriftLine = useMemo(
    () => fitRobustLine(trackingTrail, previewSize),
    [previewSize, trackingTrail]
  );

  const driftLineOnScreen = useMemo(() => {
    if (!robustDriftLine) return null;
    const start = pointToScreen(robustDriftLine.start);
    const end = pointToScreen(robustDriftLine.end);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    return {
      left: (start.x + end.x) / 2 - length / 2,
      top: (start.y + end.y) / 2 - 1,
      width: length,
      angle: Math.atan2(end.y - start.y, end.x - start.x),
    };
  }, [previewPan, previewSize, previewZoom, robustDriftLine]);

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
    const trackingSubscription = camera.addListener('onStarTracked', (sample) => {
      setTrackingSample(sample);
      if (sample.locked) {
        setTrackingTrail((trail) => [...trail, { x: sample.x, y: sample.y }].slice(-40));
      }
    });

    return () => {
      subscription.remove();
      trackingSubscription.remove();
    };
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

      <View
        style={styles.previewColumn}
        onLayout={(event) => {
          const next = {
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          };
          previewSizeRef.current = next;
          setPreviewSize(next);
          updatePreviewPan(previewPanRef.current);
        }}>
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              transform: [{ translateX: previewPan.x }, { translateY: previewPan.y }],
            },
          ]}>
          <View style={[StyleSheet.absoluteFill, { transform: [{ scale: previewZoom }] }]}>
            <SonyCameraView active={streaming} style={StyleSheet.absoluteFill} />
          </View>
        </View>

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

        {streaming ? (
          <View style={styles.previewGestureLayer} {...previewResponder.panHandlers}>
            {!selectedStar ? (
              <View style={styles.selectionHint} pointerEvents="none">
                <Text style={styles.selectionHintText}>
                  Pincer pour zoomer · Glisser pour déplacer · Toucher une étoile
                </Text>
              </View>
            ) : null}

            {selectedStarScreen ? (
              <View
                pointerEvents="none"
                style={[
                  styles.referenceTarget,
                  {
                    left: selectedStarScreen.x - 8,
                    top: selectedStarScreen.y - 8,
                  },
                ]}>
                <View style={styles.referenceTargetHorizontal} />
                <View style={styles.referenceTargetVertical} />
              </View>
            ) : null}

            {driftLineOnScreen ? (
              <View
                pointerEvents="none"
                style={[
                  styles.driftLine,
                  {
                    left: driftLineOnScreen.left,
                    top: driftLineOnScreen.top,
                    width: driftLineOnScreen.width,
                    transform: [{ rotate: `${driftLineOnScreen.angle}rad` }],
                  },
                ]}
              />
            ) : null}

            {trailOnScreen.map((point, index) => (
              <View
                key={index}
                pointerEvents="none"
                style={[
                  styles.trailPoint,
                  robustDriftLine && !robustDriftLine.inliers[index]
                    ? styles.trailPointOutlier
                    : null,
                  {
                    left: point.x - 2,
                    top: point.y - 2,
                    opacity: (index + 1) / trailOnScreen.length,
                  },
                ]}
              />
            ))}

            {trackedStarScreen ? (
              <View
                pointerEvents="none"
                style={[
                  styles.starTarget,
                  {
                    left: trackedStarScreen.x - 18,
                    top: trackedStarScreen.y - 18,
                  },
                ]}>
                <View
                  style={[
                    styles.starTargetCircle,
                    !trackingSample?.locked && styles.starTargetCircleLost,
                  ]}
                />
                <View style={styles.starTargetHorizontal} />
                <View style={styles.starTargetVertical} />
              </View>
            ) : null}

            <View style={styles.zoomBadge} pointerEvents="none">
              <Text style={styles.zoomBadgeText}>×{previewZoom.toFixed(1)}</Text>
            </View>
          </View>
        ) : null}

        {streaming ? (
          <View style={styles.zoomControls}>
            <Pressable
              accessibilityLabel="Dézoomer"
              accessibilityRole="button"
              onPress={() => updatePreviewZoom(previewZoomRef.current - 1)}
              style={({ pressed }) => [styles.zoomControlButton, pressed && styles.pressedButton]}>
              <Text style={styles.zoomControlText}>−</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Zoomer"
              accessibilityRole="button"
              onPress={() => updatePreviewZoom(previewZoomRef.current + 1)}
              style={({ pressed }) => [styles.zoomControlButton, pressed && styles.pressedButton]}>
              <Text style={styles.zoomControlText}>+</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={styles.controlColumn}>
        <ScrollView contentContainerStyle={styles.controls}>
          <Text style={styles.title}>Test A7R II</Text>
          <Text style={styles.subtitle}>ScalarWebAPI · Live View Wi-Fi</Text>

          <View style={styles.steps}>
            <Text style={styles.step}>1. Sony : ouvrir Smart Remote Control.</Text>
            <Text style={styles.step}>2. Android : rejoindre le Wi-Fi affiché par le Sony.</Text>
            <Text style={styles.step}>3. Appuyer sur Connexion, puis Démarrer Live View.</Text>
            <Text style={styles.step}>4. Pincer l’image pour zoomer, puis toucher l’étoile.</Text>
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

          {streaming ? (
            <View style={styles.selectionPanel}>
              <Text style={styles.selectionTitle}>Sélection de l’étoile</Text>
              <Text style={styles.selectionStatus}>
                Zoom ×{previewZoom.toFixed(1)} ·{' '}
                {selectedStar
                  ? `position ${(selectedStar.x * 100).toFixed(1)} %, ${(selectedStar.y * 100).toFixed(1)} %`
                  : 'aucune étoile sélectionnée'}
              </Text>
              {trackingSample ? (
                <Text
                  style={[
                    styles.trackingStatus,
                    !trackingSample.locked && styles.trackingStatusLost,
                  ]}>
                  {trackingSample.locked ? 'ÉTOILE VERROUILLÉE' : 'ÉTOILE PERDUE'} · dx{' '}
                  {trackingSample.dxPixels.toFixed(2)} px · dy {trackingSample.dyPixels.toFixed(2)} px
                  {'\n'}Image {trackingSample.frameWidth}×{trackingSample.frameHeight} · contraste{' '}
                  {trackingSample.contrast.toFixed(1)} · bruit {trackingSample.noise.toFixed(1)}
                </Text>
              ) : selectedStar ? (
                <Text style={styles.trackingStatus}>Recherche de l’étoile…</Text>
              ) : null}
              {robustDriftLine ? (
                <Text style={styles.lineFitStatus}>
                  Droite robuste · {robustDriftLine.inlierCount}/{trackingTrail.length} points retenus
                </Text>
              ) : null}
              <ActionButton
                title="Réinitialiser zoom et sélection"
                onPress={resetPreviewNavigation}
                disabled={previewZoom === 1 && selectedStar === null}
              />
            </View>
          ) : null}

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
  previewGestureLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  selectionHint: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 22,
    alignItems: 'center',
  },
  selectionHintText: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 16,
    overflow: 'hidden',
    color: '#f3f6fa',
    backgroundColor: 'rgba(9, 14, 21, 0.82)',
    fontSize: 12,
    fontWeight: '700',
  },
  zoomBadge: {
    position: 'absolute',
    top: 18,
    right: 18,
    minWidth: 54,
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(9, 14, 21, 0.82)',
  },
  zoomBadgeText: {
    color: '#f4c95d',
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '800',
  },
  zoomControls: {
    position: 'absolute',
    right: 18,
    bottom: 18,
    zIndex: 5,
    flexDirection: 'row',
    gap: 8,
  },
  zoomControlButton: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 23,
    backgroundColor: 'rgba(9, 14, 21, 0.88)',
    borderWidth: 1,
    borderColor: '#4a5f78',
  },
  zoomControlText: {
    color: '#f4c95d',
    fontSize: 28,
    fontWeight: '500',
    lineHeight: 31,
  },
  starTarget: {
    position: 'absolute',
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starTargetCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#54e397',
  },
  starTargetCircleLost: {
    borderColor: '#ff6b6b',
  },
  starTargetHorizontal: {
    position: 'absolute',
    width: 36,
    height: 1,
    backgroundColor: '#54e397',
  },
  starTargetVertical: {
    position: 'absolute',
    width: 1,
    height: 36,
    backgroundColor: '#54e397',
  },
  referenceTarget: {
    position: 'absolute',
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  referenceTargetHorizontal: {
    position: 'absolute',
    width: 16,
    height: 1,
    backgroundColor: '#f4c95d',
  },
  referenceTargetVertical: {
    position: 'absolute',
    width: 1,
    height: 16,
    backgroundColor: '#f4c95d',
  },
  trailPoint: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#65b8ff',
  },
  trailPointOutlier: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ff8a65',
  },
  driftLine: {
    position: 'absolute',
    height: 2,
    borderRadius: 1,
    backgroundColor: '#5ee7ff',
    opacity: 0.9,
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
  selectionPanel: {
    gap: 9,
    padding: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#2f4e78',
    backgroundColor: '#101925',
  },
  selectionTitle: {
    color: '#f3f6fa',
    fontSize: 14,
    fontWeight: '800',
  },
  selectionStatus: {
    color: '#9fb6d2',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  trackingStatus: {
    color: '#54e397',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
  },
  trackingStatusLost: {
    color: '#ff8a8a',
  },
  lineFitStatus: {
    color: '#5ee7ff',
    fontFamily: 'monospace',
    fontSize: 10,
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
