import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "../../src/nav/world.js";
import { plan } from "../../src/nav/planner.js";
import { ROBOT } from "../../src/nav/robot.js";

const open = makeWorld({ bounds: 1.5 });
const ball = (x, y) => makeWorld({ bounds: 1.5, obstacles: [{ x, y, r: 0.09 }] });

test("world clearance: walls, circles, segments, footprint", () => {
  const w = makeWorld({ bounds: 1.5, obstacles: [{ x: 0, y: 0, r: 0.1 }], segments: [{ x1: 1, y1: -1, x2: 1, y2: 1 }], margin: 0 });
  assert.ok(Math.abs(w.clearance([0.5, 0]) - (0.4 - ROBOT.radius)) < 1e-9);
  assert.ok(Math.abs(w.clearance([1.4, 0]) - (0.1 - ROBOT.radius)) < 1e-9);
  assert.ok(Math.abs(w.clearance([0.9, 0]) - (0.1 - ROBOT.radius)) < 1e-9);
  assert.ok(!w.isFree([0.15, 0]) && w.isFree([0.5, 0.5]));
});

test("open field: the plan ends on the goal pose and is free", () => {
  const res = plan([-0.6, 0, 0], [0.2, 0.1, 0], open);
  assert.ok(res.points, res.reason);
  const end = res.points.at(-1);
  assert.ok(Math.hypot(end[0] - 0.2, end[1] - 0.1) < 1e-6);
  assert.ok(res.points.every((p) => open.isFree(p)));
});

test("duck in front of the ball: goes around it", () => {
  const w = ball(0.5, 0);
  const res = plan([0.9, 0, Math.PI], [0.0, 0, 0], w); // goal 0.5 m behind the ball, facing +x
  assert.ok(res.points, res.reason);
  assert.ok(res.points.every((p) => w.isFree(p)), "path brushes the ball");
  assert.ok(res.length < 2.5, `length ${res.length}`);
});

test("start already touching the ball is allowed if the path moves away", () => {
  const w = ball(0.5, 0);
  assert.ok(!w.isFree([0.32, 0]));
  const res = plan([0.32, 0, Math.PI], [-0.2, 0.3, Math.PI / 2], w);
  assert.ok(res.points, res.reason);
});

test("a blocked goal is reported", () => {
  const res = plan([-0.6, 0, 0], [1.46, 0, 0], open);
  assert.equal(res.points, null);
  assert.match(res.reason, /blocked/);
});

test("planning is fast", () => {
  const w = ball(0.5, 0);
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) plan([0.9, 0.02 * i, Math.PI], [0, 0, 0], w);
  const ms = (performance.now() - t0) / 50;
  assert.ok(ms < 5, `${ms.toFixed(2)} ms per plan`);
});
