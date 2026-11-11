import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three";
import { createPlacementGate } from "../components/ar-tracking.ts";

function sample(time, changes = {}) {
  return {
    time,
    point: new Vector3(0, 0, -1),
    normal: new Vector3(0, 1, 0),
    viewer: new Vector3(0, 0, 0),
    emulated: false,
    ...changes,
  };
}

function stable(gate, start = 0) {
  let result;
  for (let i = 0; i < 12; i++) result = gate.update(sample(start + i * 80));
  return result;
}

test("first hit stays unready and a sustained candidate becomes ready", () => {
  const gate = createPlacementGate();
  assert.deepEqual(gate.update(sample(0)), {
    ready: false, reason: "stabilizing", progress: 0, distance: 1,
  });
  let result;
  for (let i = 1; i <= 11; i++) result = gate.update(sample(i * 80));
  assert.deepEqual(result, { ready: true, reason: "ready", progress: 1, distance: 1 });
  assert.equal(gate.update(sample(960)).ready, true);
});

test("both 800 milliseconds and 12 distinct samples are required", () => {
  const fast = createPlacementGate();
  for (let i = 0; i < 12; i++) assert.equal(fast.update(sample(i * 10)).ready, false);

  const sparse = createPlacementGate();
  let result;
  for (let i = 0; i <= 4; i++) result = sparse.update(sample(i * 200));
  assert.equal(result.ready, false);
  assert.equal(result.progress, 5 / 12);
  for (let i = 0; i < 20; i++) result = sparse.update(sample(800));
  assert.equal(result.progress, 5 / 12, "duplicate timestamps must not inflate the sample count");
  for (let i = 1; i <= 7; i++) result = sparse.update(sample(800 + i * 10));
  assert.equal(result.ready, true);

  const boundary = createPlacementGate();
  for (let i = 0; i < 11; i++) boundary.update(sample(i * 70));
  assert.equal(boundary.update(sample(800)).ready, true);
});

test("small positional and normal jitter is tolerated without moving the starting reference", () => {
  const gate = createPlacementGate();
  gate.update(sample(0));
  let result;
  for (let i = 1; i < 12; i++) {
    const angle = ((i % 2 ? 6 : -6) * Math.PI) / 180;
    result = gate.update(sample(i * 80, {
      point: new Vector3(i % 2 ? 0.02 : -0.02, 0, -1),
      normal: new Vector3(Math.sin(angle), Math.cos(angle), 0).multiplyScalar(2),
    }));
  }
  assert.equal(result.ready, true);
});

test("slow accumulated positional drift never passes merely because adjacent frames are close", () => {
  const gate = createPlacementGate();
  for (let i = 0; i < 30; i++) {
    const result = gate.update(sample(i * 80, { point: new Vector3(i * 0.004, 0, -1) }));
    assert.equal(result.ready, false);
    if (i === 7) assert.equal(result.progress, 0, "28mm drift must restart the window");
  }
});

test("a position jump or normal change over eight degrees restarts even a ready candidate", () => {
  const gate = createPlacementGate();
  assert.equal(stable(gate).ready, true);
  const atLimit = gate.update(sample(960, { point: new Vector3(0.025, 0, -1) }));
  assert.equal(atLimit.ready, true);
  const jumped = gate.update(sample(1040, { point: new Vector3(0.0251, 0, -1) }));
  assert.equal(jumped.reason, "stabilizing");
  assert.equal(jumped.progress, 0);

  const normalGate = createPlacementGate();
  assert.equal(stable(normalGate).ready, true);
  const tilted = (degrees) => new Vector3(Math.sin(degrees * Math.PI / 180), Math.cos(degrees * Math.PI / 180), 0);
  assert.equal(normalGate.update(sample(960, { normal: tilted(8) })).ready, true);
  assert.equal(normalGate.update(sample(1040, { normal: tilted(8.1) })).progress, 0);
});

test("slow normal drift is compared with the starting normal rather than the previous frame", () => {
  const gate = createPlacementGate();
  for (let i = 0; i < 24; i++) {
    const angle = (i * Math.PI) / 180;
    const result = gate.update(sample(i * 80, {
      normal: new Vector3(Math.sin(angle), Math.cos(angle), 0),
    }));
    assert.equal(result.ready, false);
    if (i === 9) assert.equal(result.progress, 0);
  }
});

test("missing hits, explicit reset, long gaps and backward time discard earlier readiness", () => {
  for (const interruption of ["missing", "reset", "gap", "backward"]) {
    const gate = createPlacementGate();
    assert.equal(stable(gate).ready, true);
    if (interruption === "missing") {
      assert.deepEqual(gate.update(null), { ready: false, reason: "searching", progress: 0, distance: null });
    } else if (interruption === "reset") gate.reset();
    const time = interruption === "gap" ? 1081 : interruption === "backward" ? 879 : 960;
    const result = gate.update(sample(time));
    assert.equal(result.reason, "stabilizing", interruption);
    assert.equal(result.progress, 0, interruption);
  }
  const boundary = createPlacementGate();
  stable(boundary);
  assert.equal(boundary.update(sample(1080)).ready, true, "exactly 200ms is allowed");
});

test("emulated tracking and out-of-range distances block and clear accumulated readiness", () => {
  for (const [changes, reason, distance] of [
    [{ emulated: true }, "emulated", 1],
    [{ point: new Vector3(0, 0, -0.249) }, "too-close", 0.249],
    [{ point: new Vector3(0, 0, -4.001) }, "too-far", 4.001],
  ]) {
    const gate = createPlacementGate();
    stable(gate);
    assert.deepEqual(gate.update(sample(960, changes)), { ready: false, reason, progress: 0, distance });
    assert.equal(gate.update(sample(1040)).progress, 0);
  }
  for (const distance of [0.25, 4]) {
    const gate = createPlacementGate();
    let result;
    for (let i = 0; i < 12; i++) result = gate.update(sample(i * 80, { point: new Vector3(0, 0, -distance) }));
    assert.equal(result.ready, true, `inclusive distance boundary: ${distance}`);
  }
});

test("nonfinite transforms, invalid normals and overflowing distances cannot retain readiness", () => {
  for (const changes of [
    { time: NaN }, { time: Infinity },
    { point: new Vector3(NaN, 0, -1) },
    { viewer: new Vector3(0, Infinity, 0) },
    { normal: new Vector3(0, 0, NaN) },
    { normal: new Vector3(0, 0, 0) },
    { normal: new Vector3(Number.MAX_VALUE, Number.MAX_VALUE, 0) },
    { point: new Vector3(Number.MAX_VALUE, 0, 0), viewer: new Vector3(-Number.MAX_VALUE, 0, 0) },
  ]) {
    const gate = createPlacementGate();
    stable(gate);
    assert.deepEqual(gate.update(sample(960, changes)), { ready: false, reason: "searching", progress: 0, distance: null });
    assert.equal(gate.update(sample(1040)).progress, 0);
  }
});

test("caller mutations cannot move the retained starting point or normal", () => {
  const gate = createPlacementGate();
  const reused = sample(0);
  gate.update(reused);
  reused.point.x = 0.1;
  reused.normal.set(1, 0, 0);
  reused.time = 80;
  assert.equal(gate.update(reused).progress, 0);
  for (let i = 1; i <= 11; i++) {
    reused.time = 80 + i * 80;
    const result = gate.update(reused);
    if (i === 11) assert.equal(result.ready, true);
  }
});
