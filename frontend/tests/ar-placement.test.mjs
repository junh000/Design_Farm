import assert from "node:assert/strict";
import test from "node:test";
import { Matrix4, Vector3 } from "three";
import {
  placementFromHit,
  positionWithWallOffset,
  isFreshHit,
  WALL_GAP_METRES,
  HIT_MAX_AGE_MS,
} from "../components/ar-placement.ts";

function hit(normal, point = new Vector3(0, 1.4, -1)) {
  const up = normal.clone().normalize();
  const seed = Math.abs(up.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
  const right = new Vector3().crossVectors(up, seed).normalize();
  const forward = new Vector3().crossVectors(right, up).normalize();
  return new Matrix4().makeBasis(right, up, forward).setPosition(point).elements;
}
const dimensions = { height: 50, depth: 3 };
const viewer = new Vector3(0, 1.5, 2);
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-6, `${value} != ${expected}`);

test("wall mode accepts vertical normals in either direction and rejects floor/ceiling/sloped surfaces", () => {
  for (const normal of [new Vector3(0, 0, 1), new Vector3(0, 0, -1), new Vector3(1, 0, 0)])
    assert.ok(placementFromHit(hit(normal), viewer, true, dimensions));
  for (const normal of [new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(0, 0.6, 0.8)])
    assert.equal(placementFromHit(hit(normal), viewer, true, dimensions), null);
});

test("painting front stays parallel to its wall rather than turning toward the camera", () => {
  const pose = placementFromHit(hit(new Vector3(0, 0, -1)), viewer, true, dimensions);
  assert.ok(pose);
  const sideView = placementFromHit(hit(new Vector3(0, 0, -1)), new Vector3(2, 2, 2), true, dimensions);
  near(pose.quaternion.angleTo(sideView.quaternion), 0);
  near(new Vector3(0, 0, 1).applyQuaternion(pose.quaternion).dot(pose.normal), 1);
  near(new Vector3(0, 1, 0).applyQuaternion(pose.quaternion).y, 1);
  assert.ok(pose.normal.dot(viewer.clone().sub(new Vector3(0, 1.4, -1))) > 0);
});

test("a registered 50cm tall painting is centred on the wall hit with its back outside the wall", () => {
  const point = new Vector3(0, 1.4, -1);
  const pose = placementFromHit(hit(new Vector3(0, 0, 1), point), viewer, true, dimensions);
  assert.ok(pose);
  const centre = pose.position.clone().addScaledVector(pose.up, dimensions.height / 200);
  const gap = centre.clone().sub(point).dot(pose.normal) - dimensions.depth / 200;
  near(gap, WALL_GAP_METRES);
  near(centre.y, point.y);
  near(pose.position.y, point.y - 0.25);
  near(pose.quaternion.length(), 1);
});

test("zero-depth photo panels account for their minimum display thickness", () => {
  const point = new Vector3(0, 1.4, -1);
  const pose = placementFromHit(hit(new Vector3(0, 0, 1), point), viewer, true, { height: 50, depth: 0 });
  assert.ok(pose);
  near(pose.position.clone().sub(point).dot(pose.normal), 0.004 + WALL_GAP_METRES);
});

test("wall adjustments follow the detected wall plane, preserve stand-off, and are bounded", () => {
  const pose = placementFromHit(hit(new Vector3(0.6, 0.1, 0.8)), viewer, true, dimensions);
  assert.ok(pose);
  const offset = positionWithWallOffset(pose, 0.2, 0.1).sub(pose.position);
  near(offset.dot(pose.normal), 0);
  near(offset.dot(pose.up), 0.1);
  near(offset.dot(pose.right), 0.2);
  const clamped = positionWithWallOffset(pose, 8, -8).sub(pose.position);
  near(clamped.dot(pose.right), 0.5);
  near(clamped.dot(pose.up), -0.5);
});

test("surface mode retains bottom-centre contact and rejects wall or underside hits", () => {
  const point = new Vector3(0.5, 0.72, -1);
  const pose = placementFromHit(hit(new Vector3(0, 1, 0), point), viewer, false, dimensions);
  assert.ok(pose);
  near(pose.position.distanceTo(point), 0);
  near(new Vector3(0, 1, 0).applyQuaternion(pose.quaternion).y, 1);
  assert.equal(placementFromHit(hit(new Vector3(0, 0, 1)), viewer, false, dimensions), null);
  assert.equal(placementFromHit(hit(new Vector3(0, -1, 0)), viewer, false, dimensions), null);
});

test("invalid transforms and dimensions cannot produce a placement", () => {
  const matrix = hit(new Vector3(0, 0, 1));
  matrix[12] = NaN;
  assert.equal(placementFromHit(matrix, viewer, true, dimensions), null);
  assert.equal(placementFromHit(new Array(16).fill(0), viewer, true, dimensions), null);
  assert.equal(placementFromHit([1, 2], viewer, true, dimensions), null);
  assert.equal(placementFromHit(hit(new Vector3(0, 0, 1)), viewer, true, { height: 0, depth: 1 }), null);
});

test("stale, hidden, or reset tracking cannot confirm a placement", () => {
  assert.equal(isFreshHit(1000, 1000, true), true);
  assert.equal(isFreshHit(1000, 1000 + HIT_MAX_AGE_MS, true), true);
  assert.equal(isFreshHit(1000, 1001 + HIT_MAX_AGE_MS, true), false);
  assert.equal(isFreshHit(1000, 1001, false), false);
  assert.equal(isFreshHit(-Infinity, 1000, true), false);
  assert.equal(isFreshHit(1001, 1000, true), false);
});
