import assert from "node:assert/strict";
import test from "node:test";
import {
  BoxGeometry,
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from "three";
import { fitToDimensions, disposeObject } from "../components/art-models.ts";

test("an off-centre source model fits registered metre dimensions and rests on its footprint", () => {
  const source = new Group();
  source.position.set(3, 5, -7);
  const mesh = new Mesh(new BoxGeometry(2, 3, 4), new MeshBasicMaterial());
  mesh.position.set(8, -4, 3);
  source.add(mesh);
  const fitted = fitToDimensions(source, 0.26, 0.38, 0.22);
  const bounds = new Box3().setFromObject(fitted);
  const size = bounds.getSize(new Vector3());
  for (const [actual, expected] of [
    [size.x, 0.26],
    [size.y, 0.38],
    [size.z, 0.22],
    [bounds.min.y, 0],
    [bounds.min.x, -0.13],
    [bounds.min.z, -0.11],
  ])
    assert.ok(Math.abs(actual - expected) < 1e-6);
  fitted.scale.multiplyScalar(1.5);
  assert.ok(
    Math.abs(new Box3().setFromObject(fitted).getSize(new Vector3()).y - 0.57) <
      1e-6,
  );
  disposeObject(fitted);
});

test("empty and flat imported models fail with a usable error", () => {
  assert.throws(() => fitToDimensions(new Group(), 1, 1, 1), /모형/);
});
