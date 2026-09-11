import SonyCamera, { SonyCameraView } from 'expo-sony-camera';
import type { SonyCameraState, SonyStarTrackingSample } from 'expo-sony-camera';
import * as Updates from 'expo-updates';
import { useEffect, useMemo, useRef, useState } from 'react';
import PolarAlignmentScreen from './PolarAlignmentScreen';
import CaptureAssistantScreen from './CaptureAssistantScreen';
import PlateSolvingScreen from './PlateSolvingScreen';
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
type TimedPoint = Point & { timestamp: number };
type PreviewSize = { width: number; height: number };
type AlignmentPhase = 'idle' | 'reference' | 'ready' | 'measuring';
type DriftMeasurement = { timestamp: number; distancePixels: number };
type RobustLineFit = {
  start: Point;
  end: Point;
  centerPixels: Point;
  directionPixels: Point;
  imageSize: PreviewSize;
  inliers: boolean[];
  inlierCount: number;
  rmsPixels: number;
  angleDegrees: number;
  angleUncertaintyDegrees: number;
};
type DriftTrend = {
  slopePixelsPerMinute: number;
  currentDistancePixels: number;
  rmsPixels: number;
  inlierCount: number;
};
type FocusQuality = 'waiting' | 'green' | 'orange' | 'red';

const MAX_PREVIEW_ZOOM = 10;
const MIN_REFERENCE_POINTS = 12;
const FOCUS_MEDIAN_WINDOW = 7;
const FOCUS_MIN_SAMPLES = 5;
const APP_COMMIT = process.env.EXPO_PUBLIC_GIT_COMMIT_SHA ?? 'non renseigné';

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

/** Least-squares position at the latest timestamp; unlike a moving average it does not lag linear drift. */
function predictTimedPoint(samples: TimedPoint[], timestamp: number): Point {
  if (samples.length === 0) return { x: 0, y: 0 };
  if (samples.length === 1) return samples[0];
  const origin = samples[0].timestamp;
  const times = samples.map((sample) => (sample.timestamp - origin) / 1000);
  const targetTime = (timestamp - origin) / 1000;
  const meanTime = times.reduce((sum, value) => sum + value, 0) / times.length;
  const denominator = times.reduce((sum, value) => sum + (value - meanTime) ** 2, 0);
  const predict = (coordinate: 'x' | 'y') => {
    const mean = samples.reduce((sum, sample) => sum + sample[coordinate], 0) / samples.length;
    if (denominator < 1e-9) return mean;
    const slope = samples.reduce(
      (sum, sample, index) => sum + (times[index] - meanTime) * (sample[coordinate] - mean),
      0
    ) / denominator;
    return mean + slope * (targetTime - meanTime);
  };
  return { x: clamp(predict('x'), 0, 1), y: clamp(predict('y'), 0, 1) };
}

function medianTimedPoint(samples: TimedPoint[]): TimedPoint {
  return {
    x: median(samples.map((sample) => sample.x)),
    y: median(samples.map((sample) => sample.y)),
    timestamp: median(samples.map((sample) => sample.timestamp)),
  };
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
  return Math.abs(pointLineSignedDistance(point, center, direction));
}

function pointLineSignedDistance(point: Point, center: Point, direction: Point) {
  return (point.x - center.x) * -direction.y + (point.y - center.y) * direction.x;
}

function normalizedPointToPixels(point: Point, size: PreviewSize): Point {
  return { x: point.x * size.width, y: point.y * size.height };
}

function signedDistanceToFit(point: Point, line: RobustLineFit) {
  return pointLineSignedDistance(
    normalizedPointToPixels(point, line.imageSize),
    line.centerPixels,
    line.directionPixels
  );
}

function projectOntoFit(point: Point, line: RobustLineFit): Point {
  const pixels = normalizedPointToPixels(point, line.imageSize);
  const distance = pointLineSignedDistance(pixels, line.centerPixels, line.directionPixels);
  const normal = { x: -line.directionPixels.y, y: line.directionPixels.x };
  return {
    x: (pixels.x - distance * normal.x) / line.imageSize.width,
    y: (pixels.y - distance * normal.y) / line.imageSize.height,
  };
}

function leastSquaresDrift(samples: DriftMeasurement[], accepted: boolean[]) {
  const selected = samples.filter((_, index) => accepted[index]);
  if (selected.length < 2) return null;
  const origin = selected[0].timestamp;
  const times = selected.map((sample) => (sample.timestamp - origin) / 60000);
  const meanTime = times.reduce((sum, value) => sum + value, 0) / times.length;
  const meanDistance =
    selected.reduce((sum, sample) => sum + sample.distancePixels, 0) / selected.length;
  const denominator = times.reduce((sum, value) => sum + (value - meanTime) ** 2, 0);
  if (denominator < 1e-9) return null;
  const slope = selected.reduce(
    (sum, sample, index) =>
      sum + (times[index] - meanTime) * (sample.distancePixels - meanDistance),
    0
  ) / denominator;
  return {
    origin,
    slope,
    intercept: meanDistance - slope * meanTime,
  };
}

/** Robust signed drift versus time, expressed in source-JPEG pixels per minute. */
function fitDriftTrend(samples: DriftMeasurement[]): DriftTrend | null {
  if (samples.length < 5) return null;
  let inliers = samples.map(() => true);
  let line = leastSquaresDrift(samples, inliers);
  if (!line) return null;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const residuals = samples.map((sample) => {
      const time = (sample.timestamp - line!.origin) / 60000;
      return sample.distancePixels - (line!.intercept + line!.slope * time);
    });
    const residualMedian = median(residuals.filter((_, index) => inliers[index]));
    const mad = median(
      residuals
        .filter((_, index) => inliers[index])
        .map((residual) => Math.abs(residual - residualMedian))
    );
    const threshold = clamp(3 * 1.4826 * mad, 0.25, 5);
    const nextInliers = residuals.map(
      (residual) => Math.abs(residual - residualMedian) <= threshold
    );
    if (nextInliers.filter(Boolean).length < 4) break;
    inliers = nextInliers;
    line = leastSquaresDrift(samples, inliers);
    if (!line) return null;
  }

  const acceptedResiduals = samples
    .map((sample) => {
      const time = (sample.timestamp - line!.origin) / 60000;
      return sample.distancePixels - (line!.intercept + line!.slope * time);
    })
    .filter((_, index) => inliers[index]);
  const latestTime = (samples[samples.length - 1].timestamp - line.origin) / 60000;
  return {
    slopePixelsPerMinute: line.slope,
    currentDistancePixels: line.intercept + line.slope * latestTime,
    rmsPixels: Math.sqrt(
      acceptedResiduals.reduce((sum, residual) => sum + residual ** 2, 0) /
        acceptedResiduals.length
    ),
    inlierCount: inliers.filter(Boolean).length,
  };
}

/** Robust orthogonal fit: pair consensus followed by iterative MAD rejection. */
function fitRobustLine(points: Point[], size: PreviewSize): RobustLineFit | null {
  if (points.length < 6 || size.width <= 0 || size.height <= 0) return null;
  const pixels = points.map((point) => ({ x: point.x * size.width, y: point.y * size.height }));
  const consensusThreshold = 3;
  let bestInliers: boolean[] | null = null;
  let bestCount = 0;
  let bestResidual = Number.POSITIVE_INFINITY;

  const candidatePairs: [number, number][] = [];
  if (pixels.length <= 40) {
    for (let first = 0; first < pixels.length - 1; first += 1) {
      for (let second = first + 1; second < pixels.length; second += 1) {
        candidatePairs.push([first, second]);
      }
    }
  } else {
    // Bound the work for long drift sessions while retaining deterministic coverage.
    let seed = pixels.length * 2654435761;
    for (let trial = 0; trial < 256; trial += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const first = seed % pixels.length;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      let second = seed % pixels.length;
      if (second === first) second = (second + 1) % pixels.length;
      candidatePairs.push([Math.min(first, second), Math.max(first, second)]);
    }
  }

  for (const [first, second] of candidatePairs) {
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
  const acceptedDistances = accepted.map((point) =>
    pointLineDistance(point, line!.center, line!.direction)
  );
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
  const rmsPixels = Math.sqrt(
    acceptedDistances.reduce((sum, distance) => sum + distance ** 2, 0) /
      acceptedDistances.length
  );
  const longitudinalEnergy = projections.reduce(
    (sum, projection) => sum + projection ** 2,
    0
  );
  return {
    start: endpoint(minimum),
    end: endpoint(maximum),
    centerPixels: line.center,
    directionPixels: line.direction,
    imageSize: size,
    inliers,
    inlierCount: inliers.filter(Boolean).length,
    rmsPixels,
    angleDegrees: (Math.atan2(line.direction.y, line.direction.x) * 180) / Math.PI,
    angleUncertaintyDegrees:
      longitudinalEnergy > 1e-6
        ? (Math.atan(rmsPixels / Math.sqrt(longitudinalEnergy)) * 180) / Math.PI
        : 90,
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
  const [activeScreen, setActiveScreen] = useState<'camera' | 'polar' | 'capture' | 'plate'>('camera');
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
  const [filteredTrackingPoint, setFilteredTrackingPoint] = useState<Point | null>(null);
  const [trackingTrail, setTrackingTrail] = useState<TimedPoint[]>([]);
  const [alignmentPhase, setAlignmentPhase] = useState<AlignmentPhase>('idle');
  const [referenceLine, setReferenceLine] = useState<RobustLineFit | null>(null);
  const [driftMeasurements, setDriftMeasurements] = useState<DriftMeasurement[]>([]);
  const [autoSelecting, setAutoSelecting] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [focusCurrentHfr, setFocusCurrentHfr] = useState<number | null>(null);
  const [focusBestHfr, setFocusBestHfr] = useState<number | null>(null);
  const [focusQuality, setFocusQuality] = useState<FocusQuality>('waiting');
  const [focusWindowCount, setFocusWindowCount] = useState(0);
  const [focusWarning, setFocusWarning] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const previewSizeRef = useRef(previewSize);
  const previewZoomRef = useRef(previewZoom);
  const previewPanRef = useRef(previewPan);
  const temporalSamplesRef = useRef<TimedPoint[]>([]);
  const temporalBinRef = useRef<TimedPoint[]>([]);
  const temporalBinStartedAtRef = useRef<number | null>(null);
  const lastLockedAtRef = useRef<number | null>(null);
  const alignmentPhaseRef = useRef<AlignmentPhase>('idle');
  const referenceLineRef = useRef<RobustLineFit | null>(null);
  const focusModeRef = useRef(false);
  const focusHfrSamplesRef = useRef<number[]>([]);
  const focusBestHfrRef = useRef<number | null>(null);
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

  function clearTemporalTracking(clearTrail: boolean) {
    temporalSamplesRef.current = [];
    temporalBinRef.current = [];
    temporalBinStartedAtRef.current = null;
    lastLockedAtRef.current = null;
    setFilteredTrackingPoint(null);
    if (clearTrail) setTrackingTrail([]);
  }

  function updateAlignmentPhase(next: AlignmentPhase) {
    alignmentPhaseRef.current = next;
    setAlignmentPhase(next);
  }

  function clearAlignment(clearTrail = true) {
    updateAlignmentPhase('idle');
    referenceLineRef.current = null;
    setReferenceLine(null);
    setDriftMeasurements([]);
    if (clearTrail) setTrackingTrail([]);
  }

  function resetFocusMeasurements() {
    focusHfrSamplesRef.current = [];
    focusBestHfrRef.current = null;
    setFocusCurrentHfr(null);
    setFocusBestHfr(null);
    setFocusQuality('waiting');
    setFocusWindowCount(0);
    setFocusWarning(null);
  }

  function updateFocusMeasurement(sample: SonyStarTrackingSample) {
    const stars = sample.stars ?? [];
    const saturatedCount = stars.filter((star) => star.saturated).length;
    const weakCount = stars.filter((star) => !star.locked && !star.saturated).length;
    const usableHfr = stars
      .filter((star) => star.locked && star.used && !star.saturated && Number.isFinite(star.hfd) && star.hfd > 0)
      .map((star) => star.hfd / 2);

    if (saturatedCount > 0) {
      setFocusWarning(`${saturatedCount} étoile${saturatedCount > 1 ? 's' : ''} saturée${saturatedCount > 1 ? 's' : ''}`);
    } else if (usableHfr.length === 0) {
      setFocusWarning('Étoiles trop faibles ou perdues');
    } else if (weakCount > 0) {
      setFocusWarning(`${weakCount} étoile${weakCount > 1 ? 's' : ''} trop faible${weakCount > 1 ? 's' : ''} ou perdue${weakCount > 1 ? 's' : ''}`);
    } else {
      setFocusWarning(null);
    }

    if (usableHfr.length === 0) return;
    const frameHfr = median(usableHfr);
    focusHfrSamplesRef.current = [...focusHfrSamplesRef.current, frameHfr].slice(-FOCUS_MEDIAN_WINDOW);
    setFocusWindowCount(focusHfrSamplesRef.current.length);
    if (focusHfrSamplesRef.current.length < FOCUS_MIN_SAMPLES) return;

    const currentHfr = median(focusHfrSamplesRef.current);
    const previousBest = focusBestHfrRef.current;
    const bestHfr = previousBest === null || currentHfr < previousBest ? currentHfr : previousBest;
    focusBestHfrRef.current = bestHfr;
    setFocusCurrentHfr(currentHfr);
    setFocusBestHfr(bestHfr);
    const degradation = bestHfr > 0 ? (currentHfr - bestHfr) / bestHfr : 0;
    setFocusQuality(degradation < 0.05 ? 'green' : degradation <= 0.15 ? 'orange' : 'red');
  }

  function startFocusMode() {
    focusModeRef.current = true;
    setFocusMode(true);
    resetFocusMeasurements();
    clearAlignment(false);
    autoSelectStar();
  }

  function stopFocusMode() {
    focusModeRef.current = false;
    setFocusMode(false);
    resetFocusMeasurements();
  }

  function resetPreviewNavigation() {
    previewZoomRef.current = 1;
    previewPanRef.current = { x: 0, y: 0 };
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
    setSelectedStar(null);
    setTrackingSample(null);
    setAutoSelecting(false);
    focusModeRef.current = false;
    setFocusMode(false);
    resetFocusMeasurements();
    clearTemporalTracking(true);
    clearAlignment(false);
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
    setAutoSelecting(false);
    clearTemporalTracking(true);
    clearAlignment(false);
    camera?.setStarTrackingPoint?.(point.x, point.y, size.width, size.height);
  }

  function autoSelectStar() {
    const size = previewSizeRef.current;
    if (!camera?.autoSelectStar || size.width <= 0 || size.height <= 0) {
      setLastError('La sélection automatique nécessite le nouveau module Android.');
      return;
    }
    previewZoomRef.current = 1;
    previewPanRef.current = { x: 0, y: 0 };
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
    setSelectedStar(null);
    setTrackingSample(null);
    clearTemporalTracking(true);
    clearAlignment(false);
    setLastError(null);
    setAutoSelecting(true);
    camera.autoSelectStar(size.width, size.height);
  }

  function beginReferenceAcquisition() {
    if (!selectedStar || !trackingSample?.locked) {
      setLastError('Sélectionne et verrouille une étoile avant de lancer la référence.');
      return;
    }
    clearTemporalTracking(true);
    referenceLineRef.current = null;
    setReferenceLine(null);
    setDriftMeasurements([]);
    setLastError(null);
    updateAlignmentPhase('reference');
  }

  function freezeReference(line: RobustLineFit | null) {
    if (!line || trackingTrail.length < MIN_REFERENCE_POINTS) {
      setLastError(`Laisse la monture arrêtée au moins ${MIN_REFERENCE_POINTS} secondes.`);
      return;
    }
    referenceLineRef.current = line;
    setReferenceLine(line);
    temporalBinRef.current = [];
    temporalBinStartedAtRef.current = null;
    setDriftMeasurements([]);
    setLastError(null);
    updateAlignmentPhase('ready');
  }

  function beginDriftMeasurement() {
    if (!referenceLineRef.current) return;
    temporalBinRef.current = [];
    temporalBinStartedAtRef.current = null;
    setDriftMeasurements([]);
    setLastError(null);
    updateAlignmentPhase('measuring');
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
    () =>
      filteredTrackingPoint
        ? pointToScreen(filteredTrackingPoint)
        : trackingSample
          ? pointToScreen({ x: trackingSample.x, y: trackingSample.y })
          : null,
    [filteredTrackingPoint, previewPan, previewSize, previewZoom, trackingSample]
  );

  const trackedStarsOnScreen = useMemo(
    () =>
      (trackingSample?.stars ?? []).map((star) => ({
        ...star,
        point: pointToScreen(star),
      })),
    [previewPan, previewSize, previewZoom, trackingSample]
  );

  const trailOnScreen = useMemo(() => {
    const displayStep = Math.max(1, Math.ceil(trackingTrail.length / 120));
    return trackingTrail
      .map((point, sourceIndex) => ({ point: pointToScreen(point), sourceIndex }))
      .filter(
        (_, index) => index % displayStep === 0 || index === trackingTrail.length - 1
      );
  }, [previewPan, previewSize, previewZoom, trackingTrail]);

  const analysisSize = useMemo<PreviewSize>(
    () =>
      trackingSample
        ? { width: trackingSample.frameWidth, height: trackingSample.frameHeight }
        : previewSize,
    [previewSize, trackingSample]
  );

  const robustDriftLine = useMemo(
    () => fitRobustLine(trackingTrail, analysisSize),
    [analysisSize, trackingTrail]
  );

  const displayedDriftLine = referenceLine ?? robustDriftLine;

  const driftLineOnScreen = useMemo(() => {
    if (!displayedDriftLine) return null;
    const start = pointToScreen(displayedDriftLine.start);
    const end = pointToScreen(displayedDriftLine.end);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    return {
      left: (start.x + end.x) / 2 - length / 2,
      top: (start.y + end.y) / 2 - 1,
      width: length,
      angle: Math.atan2(end.y - start.y, end.x - start.x),
    };
  }, [displayedDriftLine, previewPan, previewSize, previewZoom]);

  const driftTrend = useMemo(
    () => fitDriftTrend(driftMeasurements),
    [driftMeasurements]
  );

  const driftOffsetOnScreen = useMemo(() => {
    if (alignmentPhase !== 'measuring' || !referenceLine || !filteredTrackingPoint) return null;
    const star = pointToScreen(filteredTrackingPoint);
    const projection = pointToScreen(projectOntoFit(filteredTrackingPoint, referenceLine));
    const length = Math.hypot(star.x - projection.x, star.y - projection.y);
    return {
      left: (star.x + projection.x) / 2 - length / 2,
      top: (star.y + projection.y) / 2 - 1,
      width: length,
      angle: Math.atan2(star.y - projection.y, star.x - projection.x),
    };
  }, [alignmentPhase, filteredTrackingPoint, previewPan, previewSize, previewZoom, referenceLine]);

  const referenceDurationSeconds =
    trackingTrail.length >= 2
      ? (trackingTrail[trackingTrail.length - 1].timestamp - trackingTrail[0].timestamp) / 1000
      : 0;
  const measurementDurationSeconds =
    driftMeasurements.length >= 2
      ? (driftMeasurements[driftMeasurements.length - 1].timestamp -
          driftMeasurements[0].timestamp) /
        1000
      : 0;

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
      if (focusModeRef.current) updateFocusMeasurement(sample);
      if (sample.locked) {
        const point = { x: sample.x, y: sample.y, timestamp: sample.timestamp };
        const previousLockedAt = lastLockedAtRef.current;
        if (previousLockedAt !== null && sample.timestamp - previousLockedAt > 1500) {
          temporalSamplesRef.current = [];
          temporalBinRef.current = [];
          temporalBinStartedAtRef.current = null;
        }
        lastLockedAtRef.current = sample.timestamp;

        // A one-second linear regression smooths the displayed target while predicting
        // the current position, avoiding the lag of a conventional moving average.
        temporalSamplesRef.current = [...temporalSamplesRef.current, point].filter(
          (entry) => entry.timestamp >= sample.timestamp - 1000
        );
        setFilteredTrackingPoint(predictTimedPoint(temporalSamplesRef.current, sample.timestamp));

        // Independent one-second bins feed the drift fit, avoiding the overweighting
        // caused by highly correlated rolling-average samples.
        if (temporalBinStartedAtRef.current === null) {
          temporalBinStartedAtRef.current = sample.timestamp;
        }
        temporalBinRef.current.push(point);
        if (sample.timestamp - temporalBinStartedAtRef.current >= 1000) {
          const completedBin = temporalBinRef.current;
          if (completedBin.length >= 3) {
            const consolidated = medianTimedPoint(completedBin);
            if (alignmentPhaseRef.current === 'reference') {
              setTrackingTrail((trail) => [...trail, consolidated].slice(-120));
            } else if (
              alignmentPhaseRef.current === 'measuring' &&
              referenceLineRef.current
            ) {
              const measurement = {
                timestamp: consolidated.timestamp,
                distancePixels: signedDistanceToFit(consolidated, referenceLineRef.current),
              };
              setDriftMeasurements((samples) => [...samples, measurement].slice(-300));
            }
          }
          temporalBinRef.current = [];
          temporalBinStartedAtRef.current = null;
        }
      } else if (
        lastLockedAtRef.current !== null &&
        sample.timestamp - lastLockedAtRef.current > 1000
      ) {
        temporalSamplesRef.current = [];
        temporalBinRef.current = [];
        temporalBinStartedAtRef.current = null;
        setFilteredTrackingPoint(null);
      }
    });
    const autoSelectionSubscription = camera.addListener('onStarAutoSelected', (result) => {
      setAutoSelecting(false);
      if (result.found) {
        clearTemporalTracking(true);
        setSelectedStar({ x: result.x, y: result.y });
        setLastError(null);
      } else {
        setSelectedStar(null);
        setLastError(
          `Sélection automatique : ${result.reason ?? 'aucune étoile convenable'} (${result.candidateCount} candidats).`
        );
      }
    });

    return () => {
      subscription.remove();
      trackingSubscription.remove();
      autoSelectionSubscription.remove();
    };
  }, [camera]);

  useEffect(() => {
    if (!autoSelecting) return;
    const timeout = setTimeout(() => {
      camera?.clearStarTracking?.();
      setAutoSelecting(false);
      setLastError('La sélection automatique n’a pas répondu après 8 secondes.');
    }, 8000);
    return () => clearTimeout(timeout);
  }, [autoSelecting, camera]);

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

  async function checkForAppUpdate() {
    if (!Updates.isEnabled) {
      setUpdateMessage('EAS Update est désactivé dans cette installation.');
      return;
    }
    setCheckingUpdate(true);
    setUpdateMessage('Recherche d’une mise à jour…');
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setUpdateMessage('Cette application utilise déjà la dernière mise à jour compatible.');
        return;
      }
      setUpdateMessage('Téléchargement de la mise à jour…');
      await Updates.fetchUpdateAsync();
      setUpdateMessage('Mise à jour téléchargée · redémarrage…');
      await Updates.reloadAsync();
    } catch (error) {
      setUpdateMessage(
        `Échec de la mise à jour : ${errorMessage(error)}. Utilise un Wi-Fi avec Internet, pas celui du Sony.`
      );
    } finally {
      setCheckingUpdate(false);
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

  if (activeScreen === 'polar') {
    return <PolarAlignmentScreen onClose={() => setActiveScreen('camera')} />;
  }

  if (activeScreen === 'capture' && camera) {
    return <CaptureAssistantScreen camera={camera} onClose={() => setActiveScreen('camera')} />;
  }

  if (activeScreen === 'plate' && camera) {
    return (
      <PlateSolvingScreen
        camera={camera}
        streaming={streaming}
        onClose={() => setActiveScreen('camera')}
      />
    );
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
                  referenceLine ? styles.frozenDriftLine : null,
                  {
                    left: driftLineOnScreen.left,
                    top: driftLineOnScreen.top,
                    width: driftLineOnScreen.width,
                    transform: [{ rotate: `${driftLineOnScreen.angle}rad` }],
                  },
                ]}
              />
            ) : null}

            {driftOffsetOnScreen && driftOffsetOnScreen.width > 0.5 ? (
              <View
                pointerEvents="none"
                style={[
                  styles.driftOffsetLine,
                  {
                    left: driftOffsetOnScreen.left,
                    top: driftOffsetOnScreen.top,
                    width: driftOffsetOnScreen.width,
                    transform: [{ rotate: `${driftOffsetOnScreen.angle}rad` }],
                  },
                ]}
              />
            ) : null}

            {trailOnScreen.map(({ point, sourceIndex }, index) => (
              <View
                key={sourceIndex}
                pointerEvents="none"
                style={[
                  styles.trailPoint,
                  robustDriftLine && !robustDriftLine.inliers[sourceIndex]
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

            {trackedStarsOnScreen.map((star) => (
              <View
                key={star.id}
                pointerEvents="none"
                style={[
                  styles.multiStarTarget,
                  !star.locked
                    ? styles.multiStarTargetLost
                    : !star.used
                      ? styles.multiStarTargetRejected
                      : null,
                  {
                    left: star.point.x - 6,
                    top: star.point.y - 6,
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

          <View style={styles.versionPanel}>
            <Text style={styles.versionText}>
              Commit {APP_COMMIT} · OTA {Updates.updateId?.slice(0, 8) ?? 'intégrée'} · canal{' '}
              {Updates.channel ?? 'inconnu'}
            </Text>
            <ActionButton
              title={checkingUpdate ? 'Vérification…' : 'Vérifier et installer la mise à jour'}
              onPress={() => void checkForAppUpdate()}
              disabled={checkingUpdate}
            />
            {updateMessage ? <Text style={styles.updateMessage}>{updateMessage}</Text> : null}
          </View>

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
                  {(trackingSample.starCount ?? 1) > 1
                    ? `${trackingSample.lockedStarCount ?? 0}/${trackingSample.starCount} ÉTOILES VERROUILLÉES`
                    : trackingSample.locked
                      ? 'ÉTOILE VERROUILLÉE'
                      : 'ÉTOILE PERDUE'}{' '}
                  · dx{' '}
                  {trackingSample.dxPixels.toFixed(2)} px · dy {trackingSample.dyPixels.toFixed(2)} px
                  {'\n'}Image {trackingSample.frameWidth}×{trackingSample.frameHeight} · contraste{' '}
                  {trackingSample.contrast.toFixed(1)} · bruit {trackingSample.noise.toFixed(1)} · fond{' '}
                  {trackingSample.background.toFixed(1)}
                  {'\n'}SNR relatif {trackingSample.snr.toFixed(1)} · HFD{' '}
                  {trackingSample.hfd.toFixed(2)} px · masse {trackingSample.mass.toFixed(0)}
                  {(trackingSample.starCount ?? 1) > 1
                    ? `\nConsensus ${trackingSample.inlierStarCount ?? 0}/${trackingSample.starCount} étoiles · traitement ${(trackingSample.processingMs ?? 0).toFixed(0)} ms`
                    : ''}
                  {trackingSample.saturated ? '\nÉTOILE SATURÉE — choisir une étoile moins brillante' : ''}
                </Text>
              ) : selectedStar ? (
                <Text style={styles.trackingStatus}>Recherche de l’étoile…</Text>
              ) : null}
              <Text style={styles.lineFitStatus}>
                Filtre temporel 1 s · trace consolidée à 1 point/s
              </Text>
              <ActionButton
                title={
                  autoSelecting
                    ? 'Recherche automatique…'
                    : 'Sélection automatique (1 à 12 étoiles)'
                }
                onPress={autoSelectStar}
                disabled={autoSelecting}
              />
              <ActionButton
                title="Réinitialiser zoom et sélection"
                onPress={resetPreviewNavigation}
                disabled={autoSelecting || (previewZoom === 1 && selectedStar === null)}
              />

              {!focusMode ? (
                <ActionButton
                  title="Démarrer le mode Focus"
                  onPress={startFocusMode}
                  disabled={autoSelecting}
                />
              ) : (
                <View style={styles.focusPanel}>
                  <Text style={styles.selectionTitle}>Mode Focus · médiane de 12 étoiles max.</Text>
                  <View
                    style={[
                      styles.focusIndicator,
                      focusQuality === 'green'
                        ? styles.focusIndicatorGreen
                        : focusQuality === 'orange'
                          ? styles.focusIndicatorOrange
                          : focusQuality === 'red'
                            ? styles.focusIndicatorRed
                            : styles.focusIndicatorWaiting,
                    ]}>
                    <Text style={styles.focusValue}>
                      HFR actuel {focusCurrentHfr === null ? '—' : `${focusCurrentHfr.toFixed(2)} px`}
                    </Text>
                    <Text style={styles.focusBestValue}>
                      Meilleur HFR {focusBestHfr === null ? '—' : `${focusBestHfr.toFixed(2)} px`}
                    </Text>
                  </View>
                  <Text style={styles.focusDetails}>
                    Médiane glissante {focusWindowCount}/{FOCUS_MEDIAN_WINDOW} images · seuils vert &lt; 5 %, orange 5–15 %, rouge &gt; 15 %
                  </Text>
                  {focusWarning ? <Text style={styles.focusWarning}>ALERTE · {focusWarning}</Text> : null}
                  <ActionButton title="Réinitialiser le meilleur HFR" onPress={resetFocusMeasurements} />
                  <ActionButton title="Quitter le mode Focus" onPress={stopFocusMode} danger />
                </View>
              )}

              {!focusMode ? <View style={styles.alignmentPanel}>
                <Text style={styles.selectionTitle}>Alignement par dérive</Text>

                {alignmentPhase === 'idle' ? (
                  <>
                    <Text style={styles.alignmentInstruction}>
                      Arrête l’AstroTrac, puis lance l’acquisition de la trace de référence.
                    </Text>
                    <ActionButton
                      title="1. Acquérir la référence"
                      onPress={beginReferenceAcquisition}
                      disabled={!trackingSample?.locked || autoSelecting}
                    />
                  </>
                ) : null}

                {alignmentPhase === 'reference' ? (
                  <>
                    <Text style={styles.referenceStatus}>
                      MONTURE ARRÊTÉE · référence {referenceDurationSeconds.toFixed(0)} s ·{' '}
                      {trackingTrail.length} points
                    </Text>
                    {robustDriftLine ? (
                      <Text style={styles.lineFitStatus}>
                        Droite mobile · {robustDriftLine.inlierCount}/{trackingTrail.length} points · RMS{' '}
                        {robustDriftLine.rmsPixels.toFixed(2)} px
                        {'\n'}Angle {robustDriftLine.angleDegrees.toFixed(2)}° ±{' '}
                        {robustDriftLine.angleUncertaintyDegrees.toFixed(2)}°
                      </Text>
                    ) : (
                      <Text style={styles.alignmentInstruction}>
                        Acquisition en cours… vise au moins {MIN_REFERENCE_POINTS} secondes.
                      </Text>
                    )}
                    <ActionButton
                      title="Figer la référence"
                      onPress={() => freezeReference(robustDriftLine)}
                      disabled={!robustDriftLine || trackingTrail.length < MIN_REFERENCE_POINTS}
                    />
                    <ActionButton
                      title="Annuler la référence"
                      onPress={() => {
                        clearTemporalTracking(true);
                        clearAlignment(false);
                      }}
                    />
                  </>
                ) : null}

                {alignmentPhase === 'ready' && referenceLine ? (
                  <>
                    <Text style={styles.referenceStatus}>
                      RÉFÉRENCE FIGÉE · {referenceLine.inlierCount}/{trackingTrail.length} points · RMS{' '}
                      {referenceLine.rmsPixels.toFixed(2)} px
                      {'\n'}Angle {referenceLine.angleDegrees.toFixed(2)}° ±{' '}
                      {referenceLine.angleUncertaintyDegrees.toFixed(2)}°
                    </Text>
                    <Text style={styles.alignmentInstruction}>
                      Démarre maintenant le suivi sidéral de l’AstroTrac, puis lance la mesure.
                    </Text>
                    <ActionButton title="2. Démarrer la mesure" onPress={beginDriftMeasurement} />
                    <ActionButton
                      title="Recommencer la référence"
                      onPress={beginReferenceAcquisition}
                    />
                  </>
                ) : null}

                {alignmentPhase === 'measuring' && referenceLine ? (
                  <>
                    <Text style={styles.measurementStatus}>
                      SUIVI SIDÉRAL · mesure {measurementDurationSeconds.toFixed(0)} s ·{' '}
                      {driftMeasurements.length} points
                    </Text>
                    {driftTrend ? (
                      <Text style={styles.driftResult}>
                        Vitesse de dérive {driftTrend.slopePixelsPerMinute >= 0 ? '+' : ''}
                        {driftTrend.slopePixelsPerMinute.toFixed(2)} px/min
                        {'\n'}Écart signé {driftTrend.currentDistancePixels >= 0 ? '+' : ''}
                        {driftTrend.currentDistancePixels.toFixed(2)} px · RMS{' '}
                        {driftTrend.rmsPixels.toFixed(2)} px
                        {'\n'}Tendance robuste · {driftTrend.inlierCount}/{driftMeasurements.length} points
                      </Text>
                    ) : (
                      <Text style={styles.alignmentInstruction}>
                        Stabilisation de la mesure… encore{' '}
                        {Math.max(0, 5 - driftMeasurements.length)} s environ.
                      </Text>
                    )}
                    <Text style={styles.alignmentInstruction}>
                      Le segment orange montre l’écart perpendiculaire à la référence figée.
                    </Text>
                    <ActionButton
                      title="Terminer et recommencer"
                      onPress={() => {
                        clearTemporalTracking(true);
                        clearAlignment(false);
                      }}
                    />
                  </>
                ) : null}
              </View> : null}
            </View>
          ) : null}

          {lastError ? (
            <Text selectable style={styles.error}>
              Erreur : {lastError}
            </Text>
          ) : null}

          <View style={styles.buttonGrid}>
            <ActionButton
              title="Pré-alignement polaire au téléphone"
              onPress={() => setActiveScreen('polar')}
              disabled={busy}
            />
            <ActionButton
              title="Assistant prise de vue"
              onPress={() => setActiveScreen('capture')}
              disabled={busy || !connected}
            />
            <ActionButton
              title="Plate solving hors ligne"
              onPress={() => setActiveScreen('plate')}
              disabled={busy || !connected}
            />
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
  multiStarTarget: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#54e397',
    backgroundColor: 'rgba(84, 227, 151, 0.15)',
  },
  multiStarTargetLost: {
    borderColor: '#ff6b6b',
    backgroundColor: 'rgba(255, 107, 107, 0.12)',
  },
  multiStarTargetRejected: {
    borderColor: '#f4c95d',
    backgroundColor: 'rgba(244, 201, 93, 0.12)',
  },
  driftLine: {
    position: 'absolute',
    height: 2,
    borderRadius: 1,
    backgroundColor: '#5ee7ff',
    opacity: 0.9,
  },
  frozenDriftLine: {
    height: 3,
    backgroundColor: '#5ee7ff',
    opacity: 1,
  },
  driftOffsetLine: {
    position: 'absolute',
    height: 2,
    borderRadius: 1,
    backgroundColor: '#f4a64d',
    opacity: 1,
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
  versionPanel: {
    gap: 8,
    padding: 11,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#344258',
    backgroundColor: '#111722',
  },
  versionText: {
    color: '#9fb6d2',
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 15,
  },
  updateMessage: {
    color: '#f4c95d',
    fontSize: 10,
    lineHeight: 15,
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
  focusPanel: {
    gap: 9,
    marginTop: 3,
    padding: 11,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#4a5f78',
    backgroundColor: '#111722',
  },
  focusIndicator: {
    padding: 14,
    borderRadius: 9,
    borderWidth: 2,
  },
  focusIndicatorWaiting: {
    borderColor: '#4a5f78',
    backgroundColor: '#182231',
  },
  focusIndicatorGreen: {
    borderColor: '#54e397',
    backgroundColor: '#15372b',
  },
  focusIndicatorOrange: {
    borderColor: '#f4a64d',
    backgroundColor: '#3d2b17',
  },
  focusIndicatorRed: {
    borderColor: '#ff6b6b',
    backgroundColor: '#421f26',
  },
  focusValue: {
    color: '#f3f6fa',
    fontFamily: 'monospace',
    fontSize: 20,
    fontWeight: '900',
  },
  focusBestValue: {
    marginTop: 4,
    color: '#d8e1ec',
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '700',
  },
  focusDetails: {
    color: '#9fb6d2',
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 15,
  },
  focusWarning: {
    padding: 9,
    borderRadius: 7,
    color: '#ffd8d8',
    backgroundColor: '#531f27',
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '800',
  },
  alignmentPanel: {
    gap: 9,
    marginTop: 3,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: '#2f4e78',
  },
  alignmentInstruction: {
    color: '#b9c8dc',
    fontSize: 11,
    lineHeight: 16,
  },
  referenceStatus: {
    color: '#5ee7ff',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  measurementStatus: {
    color: '#f4c95d',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  driftResult: {
    padding: 10,
    borderRadius: 8,
    color: '#f4c95d',
    backgroundColor: '#252014',
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
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
