// The agent's tools. Each one is:
//   label         short name for the UI
//   description   what System One reads as the option's meaning
//   blocker       (obs) => null when the tool can be used right now, else
//                 a short reason it can't. Only usable tools are offered,
//                 so Jev can't pick a kick while the ball is out of reach.
//   run           async (env) => { ok, text } for the step trace. Drives
//                 the duck until the tool's own finish condition (or its
//                 timeout), then stops it.
//
// Constraints from the policies (measured in the sim):
//   - the walking policy only steps above ~0.22 m/s and cannot turn in
//     place, so every move walks at WALK speed and steers while walking;
//     it stops dead (< 1 cm coast) when the command drops to zero;
//   - the kick policies are blind and shoot along the duck's heading, and
//     only connect with the ball 7-11 cm ahead, 2.5-7.5 cm out to the
//     kicking foot's side (observe.js KICK_FWD / KICK_LAT).
// Hence the play: get behind the ball -> walk up the shooting line offset
// to one foot's side (heading lines up on the way) -> kick with that foot.
import { observe, wrapPi, kickableFoot } from "./observe.js";
import { checkpoint } from "./run-control.js";
import { GOAL } from "../game/goal.js";

const TICK_MS = 20; // tool control rate (the policy itself runs at 50 Hz)
const WALK = 0.25; // m/s, the one walking speed (see above)
const TURN_GAIN = 2.5; // rad/s of turn per rad of heading error
const MAX_TURN = 1.0; // rad/s, walking policy limit

const STAGE_BACK = 0.5; // m behind the ball where run-ups start
const FAR_BACK = 0.75; // m behind the ball, entry point of the line-up walk
const SIDE_CLEAR = 0.35; // m beside the ball when detouring around it
const FOOT_OFFSET = 0.05; // m sideways: puts the ball in front of one foot
const LOOKAHEAD = 0.15; // m, line-following lookahead
const KICK_STOP = 0.095; // m, ball distance ahead where the approach stops
const KICK_SETTLE_MS = 1000; // standing still before a kick

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
const done = (text) => ({ ok: true, text });
const failed = (text) => ({ ok: false, text });

// Run a control law until it reports done. step(obs) returns [vx, wz] to
// keep going, or null when finished. target(obs), if given, is the floor
// point shown as the agent's intent. Resolves true if it finished, false
// on timeout. A pause holds the duck still and doesn't count toward the
// timeout; a stop ends the loop by throwing (run-control.js).
async function drive(env, step, timeoutS, target) {
  let end = performance.now() + timeoutS * 1000;
  try {
    while (performance.now() < end) {
      end += await checkpoint(() => env.stop());
      // Ball mid-respawn (the game's escape watchdog): hold still.
      if (!env.getBallPos()) {
        env.stop();
        await sleep(TICK_MS);
        continue;
      }
      const obs = observe(env);
      if (target) env.showTarget(target(obs));
      const cmd = step(obs);
      if (!cmd) return true;
      env.setCommand(cmd[0], cmd[1]);
      await sleep(TICK_MS);
    }
    return false;
  } finally {
    env.stop();
    env.showTarget(null);
  }
}

// Walk toward a floor point, steering on the way.
function steerToward(obs, [tx, ty]) {
  const [x, y, yaw] = obs.duck;
  const err = wrapPi(Math.atan2(ty - y, tx - x) - yaw);
  return [WALK, clamp(err * TURN_GAIN, MAX_TURN)];
}

// The shooting line for one foot ("left" | "right" | null): through the
// ball, along ball -> goal, shifted sideways so the ball ends up in front
// of that foot. Returns the duck's position relative to it (s: metres
// along, negative = behind the ball; offset: metres to its left) and at(s),
// the floor point at line coordinate s.
function shootingLine(obs, foot) {
  const h = obs.shotHeading;
  const ux = Math.cos(h), uy = Math.sin(h); // along the line
  const nx = -uy, ny = ux; // to the line's left
  // Left foot: walk on the ball's right, so the ball passes on our left.
  // No foot: the centre line.
  const side = foot === "left" ? -FOOT_OFFSET : foot === "right" ? FOOT_OFFSET : 0;
  const ox = obs.ballPos[0] + nx * side, oy = obs.ballPos[1] + ny * side;
  const dx = obs.duck[0] - ox, dy = obs.duck[1] - oy;
  return {
    s: dx * ux + dy * uy,
    offset: dx * nx + dy * ny,
    at: (s) => [ox + ux * s, oy + uy * s],
  };
}

// Waypoints on the way behind the ball (all follow the ball if it moves):
// staging spot where run-ups start, the far entry point of the line-up
// walk, and a detour point beside the ball, on the duck's side, that keeps
// the duck from walking through the ball. sideSpot is null (skipped) once
// the duck is already behind the ball.
const stagingSpot = (obs) => shootingLine(obs, null).at(-STAGE_BACK);
const farSpot = (obs) => shootingLine(obs, null).at(-FAR_BACK);
function sideSpot(obs) {
  const line = shootingLine(obs, null);
  if (line.s < -0.3) return null;
  const h = obs.shotHeading, side = line.offset >= 0 ? 1 : -1;
  return [
    obs.ballPos[0] - Math.cos(h) * 0.15 - Math.sin(h) * side * SIDE_CLEAR,
    obs.ballPos[1] - Math.sin(h) * 0.15 + Math.cos(h) * side * SIDE_CLEAR,
  ];
}

// Walk until within `radius` of target(obs); a null target is skipped.
function walkTo(env, target, radius) {
  return drive(env, (obs) => {
    const p = target(obs);
    return !p || Math.hypot(p[0] - obs.duck[0], p[1] - obs.duck[1]) < radius ? null : steerToward(obs, p);
  }, 15, target);
}

async function approachForKick(env, foot) {
  const ok = await drive(env, (obs) => {
    if (obs.ball.fwd <= KICK_STOP) return null;
    const line = shootingLine(obs, foot);
    return steerToward(obs, line.at(line.s + LOOKAHEAD));
  }, 9, (obs) => shootingLine(obs, foot).at(-KICK_STOP));
  if (!ok) return failed("timed out while walking up to the ball");
  const obs = observe(env);
  return kickableFoot(obs) === foot ? done(`stopped with the ball in front of the ${foot} foot, ready to kick`)
    : failed(`stopped, but the ball is not in front of the ${foot} foot (${(obs.ball.lat * 100).toFixed(0)} cm sideways)`);
}

async function kick(env, foot) {
  // The blind kick expects a settled stance, not feet mid-stride.
  await sleep(KICK_SETTLE_MS);
  await checkpoint(() => env.stop());
  const before = observe(env).ballPos;
  if (!env.kick(foot)) return failed("kick did not start");
  await sleep(600); // 0.5 s kick window + a beat
  // Let the ball roll out (or 4 s).
  const end = performance.now() + 4000;
  while (performance.now() < end && env.getBallSpeed() > 0.02) {
    await checkpoint();
    await sleep(100);
  }
  const obs = observe(env);
  const moved = Math.hypot(obs.ballPos[0] - before[0], obs.ballPos[1] - before[1]);
  if (obs.ballInGoal) return done(`GOAL! the ball travelled ${moved.toFixed(2)} m into the net`);
  if (moved < 0.05) return failed("missed: the foot did not reach the ball");
  const where = obs.ballPos[1] > GOAL.halfWidth ? "wide left of the goal"
    : obs.ballPos[1] < -GOAL.halfWidth ? "wide right of the goal" : "short of the goal";
  return failed(`the ball travelled ${moved.toFixed(2)} m and stopped ${where}`);
}

// A run-up needs the duck behind the ball, near the shooting line and
// roughly facing the goal, so the line-up walk converges before the ball.
function approachBlocker(obs) {
  const line = shootingLine(obs, null);
  if (line.s >= -0.2) return "not behind the ball";
  if (line.s <= -0.8) return "too far behind the ball";
  if (Math.abs(line.offset) >= 0.15) return "off the shooting line";
  if (Math.abs(obs.facingErr) >= 1.0) return "not facing the goal";
  return null;
}

// A kick needs the ball in that foot's sweet spot and the duck facing the goal.
function kickBlocker(obs, foot) {
  if (kickableFoot(obs) !== foot) return `ball not in front of the ${foot} foot`;
  if (Math.abs(obs.facingErr) >= 0.25) return "not facing the goal";
  return null;
}

export const TOOLS = {
  go_behind_ball: {
    label: "Go behind ball",
    description: "Walk to a spot about half a metre behind the ball, on the line from the goal through the ball, to get room for a run-up.",
    blocker: () => null,
    run: async (env) => {
      // The duck can't turn in place or walk around the ball on its own:
      // 1. if it isn't behind the ball yet, detour past the ball's side;
      // 2. walk to a point well behind the ball;
      // 3. walk up the shooting line to the staging spot, which leaves it
      //    on the line and facing the goal.
      if (!await walkTo(env, sideSpot, 0.15)) return failed("timed out walking around the ball");
      if (!await walkTo(env, farSpot, 0.15)) return failed("timed out walking behind the ball");
      const lined = await drive(env, (obs) => {
        const line = shootingLine(obs, null);
        const onLine = Math.abs(line.offset) < 0.08 && Math.abs(obs.facingErr) < 0.4;
        return line.s >= -STAGE_BACK && onLine ? null : steerToward(obs, line.at(line.s + LOOKAHEAD));
      }, 8, stagingSpot);
      return lined ? done("standing behind the ball facing the goal, ready for a run-up")
        : failed("timed out lining up behind the ball");
    },
  },
  approach_left_foot: {
    label: "Run-up · left foot",
    description: "Walk up to the ball along the shooting line so it ends up in front of the LEFT foot, facing the goal.",
    blocker: approachBlocker,
    run: (env) => approachForKick(env, "left"),
  },
  approach_right_foot: {
    label: "Run-up · right foot",
    description: "Walk up to the ball along the shooting line so it ends up in front of the RIGHT foot, facing the goal.",
    blocker: approachBlocker,
    run: (env) => approachForKick(env, "right"),
  },
  kick_left: {
    label: "Kick · left",
    description: "Kick with the LEFT foot.",
    blocker: (obs) => kickBlocker(obs, "left"),
    run: (env) => kick(env, "left"),
  },
  kick_right: {
    label: "Kick · right",
    description: "Kick with the RIGHT foot.",
    blocker: (obs) => kickBlocker(obs, "right"),
    run: (env) => kick(env, "right"),
  },
};
