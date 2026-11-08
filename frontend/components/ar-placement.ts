import { Matrix4, Quaternion, Vector3 } from "three";

const worldUp = new Vector3(0, 1, 0);
export const WALL_NORMAL_MAX_Y = 0.25;
export const SURFACE_NORMAL_MIN_Y = 0.85;
export const WALL_GAP_METRES = 0.004;
export const MAX_WALL_OFFSET_METRES = 0.5;
export const HIT_MAX_AGE_MS = 350;

export type PlacementPose = {
  position: Vector3;
  quaternion: Quaternion;
  right: Vector3;
  up: Vector3;
  normal: Vector3;
};

/** WebXR hit-test poses use their Y axis as the detected surface normal. */
export function placementFromHit(
  matrix: ArrayLike<number>,
  viewer: Vector3,
  wall: boolean,
  dimensions: { height: number; depth: number },
): PlacementPose | null {
  if (
    matrix.length !== 16 ||
    Array.from(matrix).some((v) => !Number.isFinite(v)) ||
    ![viewer.x, viewer.y, viewer.z, dimensions.height, dimensions.depth].every(Number.isFinite) ||
    dimensions.height <= 0 || dimensions.depth < 0
  ) return null;

  const normal = new Vector3(matrix[4], matrix[5], matrix[6]);
  if (normal.lengthSq() < 0.5) return null;
  normal.normalize();
  if (wall ? Math.abs(normal.y) > WALL_NORMAL_MAX_Y : normal.y < SURFACE_NORMAL_MIN_Y)
    return null;

  const point = new Vector3(matrix[12], matrix[13], matrix[14]);
  const toViewer = viewer.clone().sub(point);
  let up: Vector3, forward: Vector3;
  if (wall) {
    // Facing the user removes ambiguity when the runtime returns the opposite normal.
    if (normal.dot(toViewer) < 0) normal.negate();
    forward = normal.clone();
    // Keep the picture's top upright while remaining exactly parallel to the wall.
    up = worldUp.clone().addScaledVector(normal, -worldUp.dot(normal)).normalize();
  } else {
    up = normal.clone();
    forward = toViewer.addScaledVector(up, -toViewer.dot(up));
    if (forward.lengthSq() < 1e-8) {
      forward.set(0, 0, 1).addScaledVector(up, -up.z);
    }
    forward.normalize();
  }
  const right = new Vector3().crossVectors(up, forward).normalize();
  const quaternion = new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(right, up, forward),
  );
  const position = point.clone();
  if (wall) {
    // Art models have their origin at bottom centre. The hit marker marks the
    // picture centre; its back stays just in front of the detected wall plane.
    position.addScaledVector(up, -dimensions.height / 200);
    position.addScaledVector(normal, Math.max(dimensions.depth / 100, 0.008) / 2 + WALL_GAP_METRES);
  }
  return { position, quaternion, right, up, normal };
}

export function positionWithWallOffset(pose: PlacementPose, x: number, y: number) {
  const clamp = (v: number) => Math.max(-MAX_WALL_OFFSET_METRES, Math.min(MAX_WALL_OFFSET_METRES, v));
  return pose.position.clone().addScaledVector(pose.right, clamp(x)).addScaledVector(pose.up, clamp(y));
}

export function isFreshHit(hitTime: number, now: number, visible: boolean) {
  return visible && Number.isFinite(hitTime) && Number.isFinite(now) &&
    now >= hitTime && now - hitTime <= HIT_MAX_AGE_MS;
}
