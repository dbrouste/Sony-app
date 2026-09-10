import * as Location from 'expo-location';
import { Accelerometer, Magnetometer } from 'expo-sensors';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type Vector3 = { x: number; y: number; z: number };

type OrientationSample = {
  azimuthDeg: number;
  altitudeDeg: number;
  angularErrorDeg: number;
  azimuthErrorDeg: number;
  altitudeErrorDeg: number;
  fieldStrengthUt: number;
};

type Props = {
  onClose: () => void;
};

const SENSOR_INTERVAL_MS = 50;
const UI_INTERVAL_MS = 80;
const FILTER_ALPHA = 0.16;
const TARGET_SCALE_PX_PER_DEGREE = 7;
const TARGET_MAX_OFFSET_PX = 142;

function radians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function degrees(value: number) {
  return (value * 180) / Math.PI;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalize(value: Vector3): Vector3 | null {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function dot(a: Vector3, b: Vector3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function subtract(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(value: Vector3, factor: number): Vector3 {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function blend(previous: Vector3 | null, next: Vector3): Vector3 {
  if (!previous) return next;
  return {
    x: previous.x + FILTER_ALPHA * (next.x - previous.x),
    y: previous.y + FILTER_ALPHA * (next.y - previous.y),
    z: previous.z + FILTER_ALPHA * (next.z - previous.z),
  };
}

function wrap180(value: number) {
  return ((value + 540) % 360) - 180;
}

function wrap360(value: number) {
  return ((value % 360) + 360) % 360;
}

function signed(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}°`;
}

function targetForLatitude(latitude: number) {
  const south = latitude < 0;
  const altitudeDeg = Math.abs(latitude);
  const azimuthDeg = south ? 180 : 0;
  const altitude = radians(altitudeDeg);
  const azimuth = radians(azimuthDeg);
  return {
    poleName: south ? 'Sud' : 'Nord',
    azimuthDeg,
    altitudeDeg,
    vector: {
      x: Math.cos(altitude) * Math.sin(azimuth),
      y: Math.cos(altitude) * Math.cos(azimuth),
      z: Math.sin(altitude),
    },
  };
}

export default function PolarAlignmentScreen({ onClose }: Props) {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [locationBusy, setLocationBusy] = useState(true);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [sensorError, setSensorError] = useState<string | null>(null);
  const [headingAccuracy, setHeadingAccuracy] = useState<number | null>(null);
  const [declinationDeg, setDeclinationDeg] = useState<number | null>(null);
  const [sample, setSample] = useState<OrientationSample | null>(null);

  const locationRef = useRef<Location.LocationObject | null>(null);
  const declinationRef = useRef(0);
  const accelerometerRef = useRef<Vector3 | null>(null);
  const magnetometerRef = useRef<Vector3 | null>(null);
  const filteredAccelerationRef = useRef<Vector3 | null>(null);
  const filteredMagneticRef = useRef<Vector3 | null>(null);
  const lastUiUpdateRef = useRef(0);

  const refreshLocation = useCallback(async () => {
    setLocationBusy(true);
    setLocationError(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        throw new Error('La permission de localisation est nécessaire pour déterminer le pôle.');
      }

      const cached = await Location.getLastKnownPositionAsync({
        maxAge: 6 * 60 * 60 * 1000,
        requiredAccuracy: 5000,
      });
      if (cached) {
        locationRef.current = cached;
        setLocation(cached);
      }

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      locationRef.current = current;
      setLocation(current);
    } catch (error) {
      setLocationError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocationBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshLocation();
  }, [refreshLocation]);

  useEffect(() => {
    let active = true;
    let headingSubscription: Location.LocationSubscription | null = null;

    async function startHeading() {
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (!active || !permission.granted) return;
        headingSubscription = await Location.watchHeadingAsync((heading) => {
          if (!active) return;
          setHeadingAccuracy(heading.accuracy);
          if (heading.trueHeading >= 0) {
            const correction = wrap180(heading.trueHeading - heading.magHeading);
            declinationRef.current = correction;
            setDeclinationDeg(correction);
          }
        });
      } catch (error) {
        if (active) setSensorError(error instanceof Error ? error.message : String(error));
      }
    }

    void startHeading();
    return () => {
      active = false;
      headingSubscription?.remove();
    };
  }, [location]);

  useEffect(() => {
    let active = true;
    let accelerationSubscription: { remove(): void } | null = null;
    let magneticSubscription: { remove(): void } | null = null;

    function calculateOrientation() {
      const currentLocation = locationRef.current;
      const acceleration = accelerometerRef.current;
      const magnetic = magnetometerRef.current;
      if (!currentLocation || !acceleration || !magnetic) return;

      filteredAccelerationRef.current = blend(filteredAccelerationRef.current, acceleration);
      filteredMagneticRef.current = blend(filteredMagneticRef.current, magnetic);

      const up = normalize(filteredAccelerationRef.current);
      const magneticVector = filteredMagneticRef.current;
      if (!up || !magneticVector) return;

      const horizontalMagnetic = subtract(magneticVector, scale(up, dot(magneticVector, up)));
      const magneticNorth = normalize(horizontalMagnetic);
      if (!magneticNorth) return;
      const magneticEast = normalize(cross(magneticNorth, up));
      if (!magneticEast) return;

      // +Z is the normal coming out of the screen, which faces the celestial pole.
      const eastMagnetic = magneticEast.z;
      const northMagnetic = magneticNorth.z;
      const upComponent = up.z;

      const declination = radians(declinationRef.current);
      const eastTrue = eastMagnetic * Math.cos(declination) + northMagnetic * Math.sin(declination);
      const northTrue = northMagnetic * Math.cos(declination) - eastMagnetic * Math.sin(declination);
      const phoneAxis = normalize({ x: eastTrue, y: northTrue, z: upComponent });
      if (!phoneAxis) return;

      const azimuthDeg = wrap360(degrees(Math.atan2(phoneAxis.x, phoneAxis.y)));
      const altitudeDeg = degrees(Math.asin(clamp(phoneAxis.z, -1, 1)));
      const target = targetForLatitude(currentLocation.coords.latitude);
      const angularErrorDeg = degrees(
        Math.acos(clamp(dot(phoneAxis, target.vector), -1, 1))
      );

      const now = Date.now();
      if (now - lastUiUpdateRef.current < UI_INTERVAL_MS) return;
      lastUiUpdateRef.current = now;
      setSample({
        azimuthDeg,
        altitudeDeg,
        angularErrorDeg,
        azimuthErrorDeg: wrap180(target.azimuthDeg - azimuthDeg),
        altitudeErrorDeg: target.altitudeDeg - altitudeDeg,
        fieldStrengthUt: Math.hypot(magnetic.x, magnetic.y, magnetic.z),
      });
    }

    async function startSensors() {
      const [hasAccelerometer, hasMagnetometer] = await Promise.all([
        Accelerometer.isAvailableAsync(),
        Magnetometer.isAvailableAsync(),
      ]);
      if (!active) return;
      if (!hasAccelerometer || !hasMagnetometer) {
        setSensorError('Ce téléphone ne fournit pas tous les capteurs nécessaires.');
        return;
      }

      Accelerometer.setUpdateInterval(SENSOR_INTERVAL_MS);
      Magnetometer.setUpdateInterval(SENSOR_INTERVAL_MS);
      accelerationSubscription = Accelerometer.addListener((value) => {
        accelerometerRef.current = value;
        calculateOrientation();
      });
      magneticSubscription = Magnetometer.addListener((value) => {
        magnetometerRef.current = value;
        calculateOrientation();
      });
    }

    void startSensors().catch((error) => {
      if (active) setSensorError(error instanceof Error ? error.message : String(error));
    });

    return () => {
      active = false;
      accelerationSubscription?.remove();
      magneticSubscription?.remove();
    };
  }, []);

  const target = location ? targetForLatitude(location.coords.latitude) : null;
  const horizontalOffset = sample
    ? clamp(
        sample.azimuthErrorDeg * TARGET_SCALE_PX_PER_DEGREE,
        -TARGET_MAX_OFFSET_PX,
        TARGET_MAX_OFFSET_PX
      )
    : 0;
  const verticalOffset = sample
    ? clamp(
        -sample.altitudeErrorDeg * TARGET_SCALE_PX_PER_DEGREE,
        -TARGET_MAX_OFFSET_PX,
        TARGET_MAX_OFFSET_PX
      )
    : 0;
  const quality = !sample
    ? 'waiting'
    : sample.angularErrorDeg <= 3
      ? 'good'
      : sample.angularErrorDeg <= 10
        ? 'close'
        : 'far';
  const magneticWarning = sample && (sample.fieldStrengthUt < 20 || sample.fieldStrengthUt > 100);

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar hidden />
      <View style={styles.targetColumn}>
        <Text style={styles.title}>Pré-alignement polaire</Text>
        <Text style={styles.subtitle}>
          Place le téléphone avec le plan de l’écran perpendiculaire à l’axe polaire et l’écran face au pôle.
        </Text>

        <View style={styles.targetArea}>
          <View style={styles.outerCircle} />
          <View style={styles.middleCircle} />
          <View style={styles.innerCircle} />
          <View style={styles.horizontalLine} />
          <View style={styles.verticalLine} />
          {sample ? (
            <View
              style={[
                styles.axisMarker,
                quality === 'good'
                  ? styles.axisMarkerGood
                  : quality === 'close'
                    ? styles.axisMarkerClose
                    : styles.axisMarkerFar,
                { transform: [{ translateX: horizontalOffset }, { translateY: verticalOffset }] },
              ]}
            />
          ) : (
            <ActivityIndicator color="#65b8ff" size="large" />
          )}
        </View>

        <Text style={styles.targetHint}>
          Déplace le point vers le centre. L’horizontale corrige l’azimut, la verticale l’altitude.
        </Text>
      </View>

      <View style={styles.controlColumn}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Direction cible</Text>
          <Text style={styles.value}>
            {target
              ? `Pôle ${target.poleName} · azimut ${target.azimuthDeg.toFixed(1)}° · altitude ${target.altitudeDeg.toFixed(1)}°`
              : 'En attente de la position…'}
          </Text>
          {location ? (
            <Text style={styles.detail}>
              GPS {location.coords.latitude.toFixed(4)}°, {location.coords.longitude.toFixed(4)}°
            </Text>
          ) : null}
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Orientation de l’écran</Text>
          <Text style={styles.value}>
            {sample
              ? `Azimut ${sample.azimuthDeg.toFixed(1)}° · altitude ${sample.altitudeDeg.toFixed(1)}°`
              : 'Acquisition des capteurs…'}
          </Text>
          {sample ? (
            <Text
              style={[
                styles.errorValue,
                quality === 'good'
                  ? styles.goodText
                  : quality === 'close'
                    ? styles.closeText
                    : styles.farText,
              ]}>
              Erreur totale {sample.angularErrorDeg.toFixed(1)}°
            </Text>
          ) : null}
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Corrections</Text>
          <Text style={styles.correction}>
            Azimut : {sample ? signed(sample.azimuthErrorDeg) : '—'}{' '}
            {sample
              ? sample.azimuthErrorDeg > 0.3
                ? 'vers l’Est'
                : sample.azimuthErrorDeg < -0.3
                  ? 'vers l’Ouest'
                  : 'OK'
              : ''}
          </Text>
          <Text style={styles.correction}>
            Altitude : {sample ? signed(sample.altitudeErrorDeg) : '—'}{' '}
            {sample
              ? sample.altitudeErrorDeg > 0.3
                ? 'monter'
                : sample.altitudeErrorDeg < -0.3
                  ? 'descendre'
                  : 'OK'
              : ''}
          </Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>État</Text>
          <Text style={styles.detail}>
            Nord vrai : {declinationDeg === null ? 'en attente' : `correction ${signed(declinationDeg)}`}
          </Text>
          <Text style={styles.detail}>
            Compas : {headingAccuracy === null ? 'en attente' : `niveau ${headingAccuracy}/3`}
          </Text>
          {sample ? (
            <Text style={styles.detail}>Champ magnétique : {sample.fieldStrengthUt.toFixed(0)} µT</Text>
          ) : null}
          {magneticWarning ? (
            <Text style={styles.warning}>Perturbation magnétique probable près de la monture.</Text>
          ) : null}
          <Text style={styles.notice}>
            Ce guidage est un pré-alignement. Termine toujours avec l’alignement par dérive.
          </Text>
        </View>

        {locationError ? <Text style={styles.error}>GPS : {locationError}</Text> : null}
        {sensorError ? <Text style={styles.error}>Capteurs : {sensorError}</Text> : null}

        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            disabled={locationBusy}
            onPress={() => void refreshLocation()}
            style={({ pressed }) => [styles.button, locationBusy && styles.disabled, pressed && styles.pressed]}>
            <Text style={styles.buttonText}>{locationBusy ? 'Localisation…' : 'Actualiser la position'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.button, styles.secondaryButton, pressed && styles.pressed]}>
            <Text style={styles.buttonText}>Retour au Live View</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: 'row', backgroundColor: '#080b10' },
  targetColumn: { flex: 1.45, alignItems: 'center', justifyContent: 'center', padding: 24 },
  controlColumn: {
    flex: 1,
    maxWidth: 560,
    padding: 20,
    gap: 10,
    borderLeftWidth: 1,
    borderLeftColor: '#202836',
    backgroundColor: '#0d121a',
  },
  title: { color: '#f3f6fa', fontSize: 28, fontWeight: '900' },
  subtitle: {
    maxWidth: 690,
    marginTop: 8,
    color: '#9fb6d2',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  targetArea: {
    width: 320,
    height: 320,
    marginVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outerCircle: {
    position: 'absolute', width: 300, height: 300, borderRadius: 150,
    borderWidth: 2, borderColor: '#344258',
  },
  middleCircle: {
    position: 'absolute', width: 150, height: 150, borderRadius: 75,
    borderWidth: 2, borderColor: '#735a28',
  },
  innerCircle: {
    position: 'absolute', width: 46, height: 46, borderRadius: 23,
    borderWidth: 2, borderColor: '#2e8b65',
  },
  horizontalLine: { position: 'absolute', width: 310, height: 1, backgroundColor: '#344258' },
  verticalLine: { position: 'absolute', width: 1, height: 310, backgroundColor: '#344258' },
  axisMarker: {
    position: 'absolute', width: 24, height: 24, borderRadius: 12,
    borderWidth: 3, backgroundColor: '#080b10',
  },
  axisMarkerGood: { borderColor: '#54e397' },
  axisMarkerClose: { borderColor: '#f4c95d' },
  axisMarkerFar: { borderColor: '#ff6b6b' },
  targetHint: { color: '#bdc7d5', fontSize: 13, textAlign: 'center' },
  panel: {
    gap: 5, padding: 11, borderRadius: 9, borderWidth: 1,
    borderColor: '#344258', backgroundColor: '#111722',
  },
  panelTitle: { color: '#f3f6fa', fontSize: 14, fontWeight: '800' },
  value: { color: '#d8e1ec', fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
  detail: { color: '#9fb6d2', fontFamily: 'monospace', fontSize: 10, lineHeight: 15 },
  errorValue: { fontFamily: 'monospace', fontSize: 18, fontWeight: '900' },
  goodText: { color: '#54e397' },
  closeText: { color: '#f4c95d' },
  farText: { color: '#ff6b6b' },
  correction: { color: '#f3f6fa', fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
  warning: { color: '#f4c95d', fontSize: 11, lineHeight: 16 },
  notice: { color: '#65b8ff', fontSize: 10, lineHeight: 15 },
  error: {
    padding: 9, borderRadius: 7, color: '#ffd8d8', backgroundColor: '#531f27',
    fontFamily: 'monospace', fontSize: 10,
  },
  buttons: { marginTop: 'auto', gap: 8 },
  button: {
    alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: 9, backgroundColor: '#2164d7',
  },
  secondaryButton: { backgroundColor: '#344258' },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.72 },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
});
