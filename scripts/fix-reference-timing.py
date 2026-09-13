from pathlib import Path

path = Path('App.tsx')
text = path.read_text(encoding='utf-8')
old = """    const trackingSubscription = camera.addListener('onStarTracked', (sample) => {
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
"""
new = """    const trackingSubscription = camera.addListener('onStarTracked', (sample) => {
      setTrackingSample(sample);
      if (focusModeRef.current) updateFocusMeasurement(sample);
      const eventTimestamp = Number.isFinite(sample.timestamp) ? sample.timestamp : Date.now();
      if (sample.locked) {
        const point = { x: sample.x, y: sample.y, timestamp: eventTimestamp };
        const previousLockedAt = lastLockedAtRef.current;
        if (previousLockedAt !== null && eventTimestamp - previousLockedAt > 1500) {
          // A long tracking gap invalidates only the rolling display smoother. Keep the
          // drift/reference bin so a slow native cadence cannot reset acquisition forever.
          temporalSamplesRef.current = [];
        }
        lastLockedAtRef.current = eventTimestamp;

        // A one-second linear regression smooths the displayed target while predicting
        // the current position, avoiding the lag of a conventional moving average.
        temporalSamplesRef.current = [...temporalSamplesRef.current, point].filter(
          (entry) => entry.timestamp >= eventTimestamp - 1000
        );
        setFilteredTrackingPoint(predictTimedPoint(temporalSamplesRef.current, eventTimestamp));
"""
if old not in text:
    raise SystemExit('Expected tracking block not found')
text = text.replace(old, new, 1)
text = text.replace('          temporalBinStartedAtRef.current = sample.timestamp;', '          temporalBinStartedAtRef.current = eventTimestamp;', 1)
text = text.replace('        if (sample.timestamp - temporalBinStartedAtRef.current >= 1000) {', '        if (eventTimestamp - temporalBinStartedAtRef.current >= 1000) {', 1)
text = text.replace('        sample.timestamp - lastLockedAtRef.current > 1000', '        eventTimestamp - lastLockedAtRef.current > 1000', 1)
path.write_text(text, encoding='utf-8')
