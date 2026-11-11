import type { Vector3 } from "three";

export type TrackingSample = {
  time: number;
  point: Vector3;
  normal: Vector3;
  viewer: Vector3;
  emulated: boolean;
};

export type TrackingReason =
  | "searching"
  | "emulated"
  | "too-close"
  | "too-far"
  | "stabilizing"
  | "ready";

export type TrackingResult = {
  ready: boolean;
  reason: TrackingReason;
  progress: number;
  distance: number | null;
};

export type PlacementGate = {
  reset: () => void;
  update: (sample: TrackingSample | null) => TrackingResult;
};

// These thresholds are placement-readiness heuristics, not a measurement of
// physical centimetre accuracy. A stable hit may still belong to the wrong plane.
const MIN_DISTANCE = 0.25;
const MAX_DISTANCE = 4;
const STABLE_DURATION_MS = 800;
const STABLE_SAMPLES = 12;
const MAX_GAP_MS = 200;
const MAX_DRIFT_SQUARED = 0.025 ** 2;
const MIN_NORMAL_DOT = Math.cos((8 * Math.PI) / 180);

export function createPlacementGate(): PlacementGate {
  let reference: { time: number; point: Vector3; normal: Vector3 } | null = null;
  let lastTime = 0;
  let samples = 0;

  const reset = () => {
    reference = null;
    lastTime = 0;
    samples = 0;
  };

  const reject = (reason: TrackingReason, distance: number | null): TrackingResult => {
    reset();
    return { ready: false, reason, progress: 0, distance };
  };

  return {
    reset,
    update(sample) {
      if (!sample) return reject("searching", null);
      const { time, point, normal, viewer, emulated } = sample;
      if (
        ![time, point.x, point.y, point.z, normal.x, normal.y, normal.z,
          viewer.x, viewer.y, viewer.z].every(Number.isFinite)
      ) return reject("searching", null);

      const distance = point.distanceTo(viewer);
      const normalLength = normal.length();
      if (!Number.isFinite(distance) || !Number.isFinite(normalLength) || normalLength < 1e-8)
        return reject("searching", null);
      if (emulated) return reject("emulated", distance);
      if (distance < MIN_DISTANCE) return reject("too-close", distance);
      if (distance > MAX_DISTANCE) return reject("too-far", distance);

      const direction = normal.clone().divideScalar(normalLength);
      if (
        !reference || time < lastTime || time - lastTime > MAX_GAP_MS ||
        point.distanceToSquared(reference.point) > MAX_DRIFT_SQUARED + 1e-12 ||
        direction.dot(reference.normal) < MIN_NORMAL_DOT - 1e-12
      ) {
        // Keep a fixed starting reference throughout each candidate window.
        // Comparing only adjacent frames would incorrectly approve slow drift.
        reference = { time, point: point.clone(), normal: direction };
        samples = 1;
      } else if (time > lastTime) {
        // Reusing a frame must not satisfy the consecutive-sample requirement.
        samples += 1;
      }
      lastTime = time;

      const elapsed = time - reference.time;
      const ready = elapsed >= STABLE_DURATION_MS && samples >= STABLE_SAMPLES;
      const progress = Math.min(1, elapsed / STABLE_DURATION_MS, samples / STABLE_SAMPLES);
      return { ready, reason: ready ? "ready" : "stabilizing", progress, distance };
    },
  };
}
