// Offline test bed: a unicycle with the measured command -> motion maps and
// a first-order lag stands in for the walking policy, a virtual clock
// stands in for the sim, and the real observe() + field + nav code runs
// against it on hundreds of random penalty layouts.
import test from "node:test";
import assert from "node:assert/strict";
import { observe } from "../../src/agent/observe.js";
import { behindBall, stagingPoses, fieldWorld } from "../../src/agent/field.js";
import { makeNav } from "../../src/nav/navigate.js";
import { ROBOT, actualSpeed } from "../../src/nav/robot.js";
import { ARENA_HALF, BALL_RADIUS } from "../../src/game/constants.js";

const DT = 0.02;
const TAU = ROBOT.lag; // s, first-order lag of the policy's response
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Returns { ok, text, timeS, pushed, data }.
export function simulate(duck, ball, { timeoutS = 45 } = {}) {
  let [x, y, yaw] = duck, v = 0, w = 0;
  const [bx, by] = ball;
  let pushed = 0;
  const env = { getDuckPose: () => [x, y, yaw], getBallPos: () => [bx, by] };
  const nav = makeNav(stagingPoses, { world: fieldWorld });
  for (let t = 0; t < timeoutS; t += DT) {
    const obs = observe(env);
    const out = nav.step(obs, t);
    if (out.done) return { ...out.done, timeS: t, pushed };
    const [vx, wz] = out.cmd;
    const vT = actualSpeed(vx);
    const wT = vT > 0 ? wz * ROBOT.turnPerCmd : 0;
    v += ((vT - v) * DT) / TAU;
    w += ((wT - w) * DT) / TAU;
    x += v * Math.cos(yaw) * DT;
    y += v * Math.sin(yaw) * DT;
    yaw = wrapPi(yaw + w * DT);
    if (Math.hypot(bx - x, by - y) < BALL_RADIUS + 0.06) pushed++;
  }
  return { ...nav.timedOut(observe(env)).done, timeS: timeoutS, pushed };
}

let seed = 12345;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const span = (lim) => (rnd() * 2 - 1) * lim;

// Random layout with room to line up behind the ball: the staging pose and
// a run-in behind it are free (corners and walls behind the ball are the
// nudge cases of Phase 4, not navigation).
function layout() {
  for (;;) {
    const ball = [span(ARENA_HALF - 0.3), span(ARENA_HALF - 0.3)];
    const duck = [span(ARENA_HALF - 0.2), span(ARENA_HALF - 0.2), span(Math.PI)];
    if (Math.hypot(duck[0] - ball[0], duck[1] - ball[1]) < 0.2) continue;
    const obs = observe({ getDuckPose: () => duck, getBallPos: () => ball });
    const world = fieldWorld(obs);
    if (world.isFree(behindBall(obs)) && world.isFree(behindBall(obs, 0.8))) return { duck, ball };
  }
}

test("benchmark layouts from the notes", () => {
  const cases = {
    "penalty spot": [[-0.6, 0, 0], [0.7, 0.1]],
    "goal line": [[-0.6, 0, 0], [1.12, 0.15]],
    "near post": [[0.85, 0.05, 0], [1.05, -0.22]],
    "duck in front": [[0.9, 0, Math.PI], [0.5, 0]],
    "beside, facing away": [[0.2, -0.1, -Math.PI / 2], [0.2, 0.3]],
    "goal-side, offset": [[0.5, -0.2, Math.PI / 2], [0.0, -0.4]],
    "after a kick, turned sideways": [[0.5, 0.0, 1.6], [1.0, 0.05]], // at the new staging pose, stance turned
    "beside the staging pose, turned away": [[0.45, 0.2, Math.PI / 2], [1.0, 0.05]],
  };
  const rows = [];
  for (const [name, [duck, ball]] of Object.entries(cases)) {
    const r = simulate(duck, ball);
    rows.push(`${name}: ${r.ok ? "OK" : "FAIL"} ${r.timeS.toFixed(1)} s, ${r.text}, replans ${r.data.replans}, ball contact ticks ${r.pushed}`);
    assert.ok(r.ok, `${name}: ${r.text}`);
    assert.equal(r.pushed, 0, `${name} touched the ball`);
  }
  console.log(rows.join("\n"));
});

test("wedged behind the ball: fails fast instead of pushing it", () => {
  // 15 cm behind the ball there is no forward-only path that doesn't get
  // closer to it; a back-up skill (Phase 4) is the answer, not wandering.
  const r = simulate([0.85, 0.0, 0.1], [1.0, 0.05]);
  assert.ok(!r.ok && r.timeS < 0.1 && r.pushed === 0, `${r.text} after ${r.timeS} s, contact ${r.pushed}`);
  assert.match(r.text, /no path/);
});

test("random layouts: success rate and time", () => {
  const N = 300;
  let ok = 0, pushed = 0, time = 0, replans = 0;
  const fails = [], allFails = [];
  for (let i = 0; i < N; i++) {
    const { duck, ball } = layout();
    const r = simulate(duck, ball);
    if (!r.ok) allFails.push(r.text.split(":")[0]);
    if (r.ok) { ok++; time += r.timeS; replans += r.data.replans; } else if (fails.length < 8) fails.push({ duck: duck.map((n) => +n.toFixed(2)), ball: ball.map((n) => +n.toFixed(2)), text: r.text });
    if (r.pushed) pushed++;
  }
  const kinds = {};
  for (const f of allFails) kinds[f] = (kinds[f] ?? 0) + 1;
  console.log(`random: ${ok}/${N} ok, ${pushed} touched the ball, mean ${(time / ok).toFixed(1)} s, mean replans ${(replans / ok).toFixed(2)}, failures ${JSON.stringify(kinds)}`);
  for (const f of fails) console.log("  fail", JSON.stringify(f));
  assert.ok(ok / N >= 0.95, `${ok}/${N}`);
  assert.ok(pushed === 0, `${pushed} layouts touched the ball`);
});
