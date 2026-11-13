import test from "node:test";
import assert from "node:assert/strict";
import { dubinsPaths, sample } from "../../src/nav/dubins.js";

const R = 0.2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

test("straight ahead is a straight line", () => {
  const [best] = dubinsPaths([0, 0, 0], [4 * R, 0, 0], R);
  close(best.length, 4 * R, 1e-9, "length");
  close(best.lengths[0], 0, 1e-9, "no initial turn");
});

test("a half-circle to the left", () => {
  const [best] = dubinsPaths([0, 0, 0], [0, 2 * R, Math.PI], R);
  close(best.length, Math.PI * R, 1e-9, "length");
  assert.equal(best.word[0], "L");
});

test("every word ends on the goal pose", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let checked = 0;
  for (let i = 0; i < 300; i++) {
    const start = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 * Math.PI];
    const goal = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 * Math.PI];
    for (const path of dubinsPaths(start, goal, R)) {
      const end = sample(path, start, R, 0.05).at(-1);
      close(end[0], goal[0], 1e-6, `${path.word} x`);
      close(end[1], goal[1], 1e-6, `${path.word} y`);
      close(wrap(end[2] - goal[2]), 0, 1e-6, `${path.word} heading`);
      checked++;
    }
  }
  assert.ok(checked > 600, `checked ${checked} paths`);
});

test("samples are spaced by the step and curve no tighter than the radius", () => {
  const [best] = dubinsPaths([0, 0, 0], [-0.3, 0.4, Math.PI / 2], R);
  const pts = sample(best, [0, 0, 0], R, 0.02);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    close(d, 0.02, 1e-3, `spacing at ${i}`);
    assert.ok(Math.abs(wrap(pts[i][2] - pts[i - 1][2])) <= 0.02 / R + 1e-9, `turn at ${i}`);
  }
});
