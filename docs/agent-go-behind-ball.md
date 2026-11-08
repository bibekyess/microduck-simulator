# Agent notes: making "Go behind ball" reliable

Status (2026-11-08): **open**. The penalty from the spot works reliably;
`go_behind_ball` (`app/src/agent/tools.js`) still fails when the duck starts
close to the ball, in front of it, or when the ball is against a wall. This
note records what was measured and tried, so the work can be picked up later.

## What the tool has to do

Bring the duck to ~0.5 m behind the ball, on the line from the ball to the
aim point in the net (`GOAL_AIM`), facing the goal, without touching the
ball. The run-up and kick tools take over from there.

## Constraints measured in the sim

These come from the walking policy (`BEST_alpha_walking.onnx`), not from the
harness, and drive every design decision:

| Fact | Value |
|---|---|
| Turn in place (vx = 0, wz = 1.0) | ~2° in 3 s: effectively impossible |
| Minimum forward command that steps | ~0.22 m/s (below: stands still) |
| Actual speed at vx = 0.25 | ~0.1 m/s, after ~0.5 s to start |
| Turn rate while walking at wz = 1.0 | ~0.6 rad/s, so turns are ~0.2 m wide |
| Coast after the command drops to zero | < 1 cm (stops dead) |
| Kick sweet spot | ball 7–11 cm ahead, 2.5–7.5 cm to the kicking foot's side |
| Kick | blind; needs ~1 s of standing still first; ball travels 0.7–1.15 m along the duck's heading (−9° to +18°) |

So the duck behaves like a car that can't reverse: it can only reach a
heading by walking a curve, and any loop it makes is ~0.4 m across.

## Current implementation (committed)

1. Fail fast if there is less than `MIN_ROOM` (0.55 m) of floor behind the
   ball before the walls: "no room to line up".
2. If the duck isn't behind the ball, walk to a detour point beside it.
3. Walk to a far point 0.75 m behind the ball (clamped to the room available).
4. Follow the shooting line (lookahead 0.3 m) to 0.5 m behind the ball;
   success needs offset < 8 cm and heading error < ~23°. If the duck gets
   within 0.3 m of the ball without lining up, give up instead of pushing it.

## Benchmark

Six layouts, `go_behind_ball` run directly (no System One), duck teleported
through `window.rl` (debug only):

| Layout (ball / duck) | Committed before | Current |
|---|---|---|
| Penalty spot: (0.7, 0.1) / spawn | ✅ 8 s | ✅ 8 s |
| Goal line: (1.12, 0.15) / spawn | ✅ 17 s | ✅ 13 s |
| Near post, duck beside: (1.05, −0.22) / (0.85, 0.05, 0°) | ❌ 22 s, ball pushed 0.46 m | ❌ 10 s, ball pushed 0.36 m |
| Duck in front: (0.5, 0) / (0.9, 0, 180°) | ❌ 19 s | ❌ 17 s, gives up, no push |
| Side wall: (0.3, 1.25) / spawn | ❌ 26 s | ❌ instant "no room" |
| Far corner: (−1.2, −1.2) / spawn | ❌ 28 s | ❌ instant "no room" |

Untested by the current version: duck beside the ball facing away
((0.2, 0.3) / (0.2, −0.1, −90°)) and duck goal-side, offset
((0.0, −0.4) / (0.5, −0.2, 90°)).

To rerun, open `http://localhost:5173/?boot=1` and paste into the console:

```js
window.__bench = { done: false, rows: [] };
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const env = window.__gameApi.agentEnv;
  const { TOOLS } = await import("/src/agent/tools.js");
  const { observe } = await import("/src/agent/observe.js");
  const { data, model, mujoco } = window.rl;
  const waitFor = async (f) => { for (let i = 0; i < 400 && !f(); i++) await sleep(50); };
  async function placeDuck(x, y, yaw) {
    const q = data.qpos;
    q[0] = x; q[1] = y; q[2] = 0.12;
    q[3] = Math.cos(yaw / 2); q[4] = 0; q[5] = 0; q[6] = Math.sin(yaw / 2);
    for (let i = 0; i < 6; i++) data.qvel[i] = 0;
    mujoco.mj_forward(model, data);
    await sleep(1500);
  }
  const cases = [
    { name: "goal line", ball: [1.12, 0.15], duck: [-0.6, 0, 0] },
    { name: "near post", ball: [1.05, -0.22], duck: [0.85, 0.05, 0] },
    { name: "duck in front", ball: [0.5, 0.0], duck: [0.9, 0.0, Math.PI] },
    { name: "beside, facing away", ball: [0.2, 0.3], duck: [0.2, -0.1, -Math.PI / 2] },
    { name: "goal-side, offset", ball: [0.0, -0.4], duck: [0.5, -0.2, Math.PI / 2] },
    { name: "penalty spot", ball: [0.7, 0.1], duck: [-0.6, 0, 0] },
  ];
  for (const c of cases) {
    env.resetDuck(); await sleep(200); await waitFor(env.isReady);
    await placeDuck(...c.duck);
    env.placeBall(...c.ball); await sleep(300); await waitFor(() => env.getBallPos()); await sleep(600);
    const b0 = env.getBallPos(), t0 = performance.now();
    const res = await TOOLS.go_behind_ball.run(env);
    const b1 = env.getBallPos() ?? b0, o = observe(env);
    window.__bench.rows.push(`${c.name}: ${res.ok ? "OK" : "FAIL"} ${((performance.now() - t0) / 1000).toFixed(1)}s, ` +
      `${res.text}, ball pushed ${Math.hypot(b1[0] - b0[0], b1[1] - b0[1]).toFixed(2)} m, ` +
      `facing err ${Math.round(o.facingErr * 57.3)}°`);
  }
  window.__bench.done = true;
})();
// later: window.__bench.rows
```

A full run takes ~4 minutes and results vary a little between runs.

## What was tried and discarded

1. **Orbit around the ball** (chase a point on a 0.45 m circle that rotates
   toward the ball's back side) in place of the detour point. The near-post
   case stopped pushing the ball but timed out.
2. **Turn away from the ball on big turns.** The first version flip-flopped
   every tick when the ball was dead behind the duck (its sideways offset
   hovers around 0 and keeps changing sign), so the duck never turned and
   walked straight away. Fixed by committing to a turn direction until the
   turn is done.
3. **Funnel onto the line**: aim at a point on the shooting line that sits
   further back the further the duck is off the line. Uncapped, a duck 1 m
   off the line targeted a point 2.1 m back (behind it) and looped. Capped at
   +0.3 m it still timed out in the three hard cases.

The combined orbit + funnel version scored 1/6 (only the easy case), worse
than the current one, so it was dropped.

## Ideas for next time

- **Offline test bed (most promising).** A simple model of the walking
  (speed, turn rate and start-up lag from the table above) running the real
  `tools.js` under Node with a virtual clock. Hundreds of layouts in seconds
  instead of 4 minutes for six, then confirm the best version in the browser.
- **Plan the path explicitly** instead of chasing waypoints: the duck is a
  car that can't reverse, so standard shortest-path curves for such vehicles
  (Dubins paths) with a ~0.2 m radius, keeping clear of the ball, fit well.
- **A "nudge the ball" skill** for wall and corner cases, which can't be
  solved by lining up: move the ball off the wall first, then line up.
- **Let System One see the reason.** Failures already come back as text
  ("no room to line up..."), so with more tools on offer the classifier could
  choose a recovery instead of retrying the same tool.
