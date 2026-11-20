// The agent's skills. Each one is:
//   label         short name for the UI
//   description   what the skill does (for an LLM)
//   params        JSON schema of its semantic args (named targets, feet,
//                 aims), resolved to poses in code
//   defaults      the args used when nobody passes any
//   options       the fixed presets offered to System One each step, as
//                 { label: "skill:preset", title, description, args }; the
//                 harness runs the skill with { ...defaults, ...args }
//   blocker       (obs, args) => null when the skill can be used right now,
//                 else a short reason it can't. Only usable options are
//                 offered, so Jev can't pick a kick while the ball is out
//                 of reach.
//   run           async (env, args) => { ok, text, data } for the step
//                 trace. Drives the duck until the skill's own finish
//                 condition (or its timeout), then stops it. Failures say
//                 how far it got, so a decider can diagnose them.
//
// Constraints from the policies (measured in the sim):
//   - the walking policy only steps above ~0.22 m/s, so the run-up walks at
//     WALK speed and steers while walking (navigate_to also pivots on the
//     spot, nav/robot.js); it stops dead (< 1 cm coast) when the command
//     drops to zero;
//   - the kick policies are blind and shoot along the duck's heading, and
//     only connect with the ball 7-11 cm ahead, 2.5-7.5 cm out to the
//     kicking foot's side (observe.js KICK_FWD / KICK_LAT).
// Hence the play: get behind the ball (planned path, nav/) -> walk up the
// shooting line offset to one foot's side (heading lines up on the way) ->
// kick with that foot.
import { observe, wrapPi, kickableFoot } from "./observe.js";
import { checkpoint } from "./run-control.js";
import { AIMS, stagingPoses, fieldWorld, lineCoords, behindBall, hasRunUpRoom, nudgeHeading, nudgeHeadings, nudgeStage, nudgeWorld, nearestWall, NUDGE_BACKS } from "./field.js";
import { plan } from "../nav/planner.js";
import { makeNav } from "../nav/navigate.js";
import { GOAL } from "../game/goal.js";
import { SPAWN_X, SPAWN_Y } from "../game/constants.js";

const TICK_MS = 20; // tool control rate (the policy itself runs at 50 Hz)
const WALK = 0.25; // m/s, the one walking speed (see above)
const TURN_GAIN = 2.5; // rad/s of turn per rad of heading error
const MAX_TURN = 1.0; // rad/s, walking policy limit

const FOOT_OFFSET = 0.05; // m sideways: puts the ball in front of one foot
const LOOKAHEAD = 0.15; // m, line-following lookahead
const KICK_STOP = 0.095; // m, ball distance ahead where the approach stops
const KICK_SETTLE_MS = 1000; // standing still before a kick

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
const done = (text, data = {}) => ({ ok: true, text, data });
const failed = (text, data = {}) => ({ ok: false, text, data });
const deg = (rad) => Math.round((rad * 180) / Math.PI);
const cm = (m) => (m * 100).toFixed(0);

// Run a control law until it reports done. step(obs, elapsedS) returns
// [vx, wz] to keep going, or null when finished. target(obs), if given, is
// the floor point shown as the agent's intent. obs is observed with `aim`.
// Resolves true if it finished, false on timeout. A pause holds the duck
// still and doesn't count toward the timeout or the elapsed time; a stop
// ends the loop by throwing (run-control.js).
async function drive(env, step, timeoutS, target, aim = "goal") {
  const start = performance.now();
  let end = start + timeoutS * 1000, paused = 0;
  try {
    while (performance.now() < end) {
      const waited = await checkpoint(() => env.stop());
      end += waited;
      paused += waited;
      // Ball mid-respawn (the game's escape watchdog): hold still.
      if (!env.getBallPos()) {
        env.stop();
        await sleep(TICK_MS);
        continue;
      }
      const obs = observe(env, aim);
      if (target) env.showTarget(target(obs));
      const cmd = step(obs, (performance.now() - start - paused) / 1000);
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
// ball, along ball -> aim point, shifted sideways so the ball ends up in
// front of that foot. See field.js lineCoords for what it returns.
function shootingLine(obs, foot) {
  // Left foot: walk on the ball's right, so the ball passes on our left.
  // No foot: the centre line.
  return lineCoords(obs, foot === "left" ? -FOOT_OFFSET : foot === "right" ? FOOT_OFFSET : 0);
}

// Plan a path to goalFn(obs) (a pose, or poses best first) and follow it
// (nav/navigate.js), drawing the path on the floor. Resolves { ok, text,
// data } with how far it got.
async function navigate(env, goalFn, timeoutS, aim, world = fieldWorld) {
  const nav = makeNav(goalFn, { world });
  let result = null, shown = null;
  try {
    const finished = await drive(env, (obs, elapsedS) => {
      const out = nav.step(obs, elapsedS);
      if (nav.path !== shown) env.showPath((shown = nav.path));
      if (out.done) { result = out.done; return null; }
      return out.cmd;
    }, timeoutS, () => nav.goal && [nav.goal[0], nav.goal[1]], aim);
    if (!finished) result = nav.timedOut(observe(env, aim)).done;
  } finally {
    env.showPath(null);
  }
  return result;
}

async function approachForKick(env, foot, aim) {
  const ok = await drive(env, (obs) => {
    if (obs.ball.fwd <= KICK_STOP) return null;
    const line = shootingLine(obs, foot);
    return steerToward(obs, line.at(line.s + LOOKAHEAD));
  }, 9, (obs) => shootingLine(obs, foot).at(-KICK_STOP), aim);
  const obs = observe(env, aim), line = shootingLine(obs, foot);
  const data = { ballAheadM: obs.ball.fwd, offLineM: line.offset, headingErr: obs.facingErr };
  if (!ok) {
    return failed(`timed out while walking up to the ball: the ball is ${cm(obs.ball.fwd)} cm ahead (the run-up stops at ${cm(KICK_STOP)} cm), `
      + `the duck is ${cm(Math.abs(line.offset))} cm off the line, heading off by ${deg(obs.facingErr)}°`, data);
  }
  return kickableFoot(obs) === foot ? done(`stopped with the ball in front of the ${foot} foot, ready to kick`, data)
    : failed(`stopped, but the ball is not in front of the ${foot} foot (${cm(obs.ball.lat)} cm sideways)`, data);
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
  const data = { movedM: moved, ballPos: obs.ballPos };
  if (obs.ballInGoal) return done(`GOAL! the ball travelled ${moved.toFixed(2)} m into the net`, data);
  if (moved < 0.05) return failed("missed: the foot did not reach the ball", data);
  const where = obs.ballPos[1] > GOAL.halfWidth ? "wide left of the goal"
    : obs.ballPos[1] < -GOAL.halfWidth ? "wide right of the goal" : "short of the goal";
  return failed(`the ball travelled ${moved.toFixed(2)} m and stopped ${where}`, data);
}

// Nudge: kick the ball a short way off a wall, from its free side
// (field.js nudgeHeading), so the normal play has room afterwards. Built
// from the same pieces as the normal play: navigate (aimed along the
// nudge), run-up, kick. The direction is fixed at the start, as a floor
// point the shooting line runs to.
async function nudge(env, foot) {
  const obs0 = observe(env);
  const options = nudgeHeadings(obs0);
  if (!options.length) return failed("no side of the ball is free to kick it from");
  // Best direction whose staging pose the duck can actually reach.
  const best = options.find((o) => plan(obs0.duck, nudgeStage(obs0, o), nudgeWorld(obs0)).points);
  if (!best) return failed(`none of the ${options.length} sides the ball could be kicked from is reachable from here`);
  const [bx, by] = obs0.ballPos;
  const aim = [bx + 2 * Math.cos(best.heading), by + 2 * Math.sin(best.heading)];
  const backs = NUDGE_BACKS.filter((b) => b <= best.back + 1e-9);
  const reach = await navigate(env, (obs) => backs.map((b) => behindBall(obs, b)), 30, aim, nudgeWorld);
  if (!reach.ok) return failed(`could not line up for the nudge: ${reach.text}`, reach.data);
  const up = await approachForKick(env, foot, aim);
  if (!up.ok) return failed(`nudge run-up: ${up.text}`, up.data);
  const k = await kick(env, foot);
  if (k.ok) return k; // straight into the goal
  const obs = observe(env);
  const moved = k.data.movedM ?? 0;
  const { dist, wall } = nearestWall(obs.ballPos);
  const data = { movedM: moved, ballPos: obs.ballPos, headingDeg: deg(best.heading) };
  if (moved < 0.05) return failed("nudge missed: the foot did not reach the ball", data);
  return hasRunUpRoom(obs)
    ? done(`nudged the ball ${moved.toFixed(2)} m off the wall: it is now ${cm(dist)} cm from the ${wall} wall with room for a run-up toward the goal`, data)
    : failed(`nudged the ball ${moved.toFixed(2)} m, but it still has no room for a run-up toward the goal (${cm(dist)} cm from the ${wall} wall)`, data);
}

// A run-up needs the duck behind the ball, near the shooting line and
// roughly facing the goal, so the line-up walk converges before the ball.
// Judged on the harness's obs (aimed at the goal centre), close enough for
// the corner aims too.
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

// Named spots navigate_to can go to, as goals for navigate(). The spawn
// pose faces +x, straight at the goal.
const TARGETS = {
  behind_ball: stagingPoses,
  spawn: () => [SPAWN_X, SPAWN_Y, 0],
};

const AIM_PARAM = {
  type: "string",
  enum: Object.keys(AIMS),
  description: "Where the shot should go: the goal centre, or its left / right corner as seen facing the goal.",
};
const FOOT_PARAM = { type: "string", enum: ["left", "right"], description: "Which foot kicks." };
const badAim = (aim) => !AIMS[aim] && failed(`unknown aim "${aim}" (expected ${Object.keys(AIMS).join(", ")})`);

export const TOOLS = {
  navigate_to: {
    label: "Navigate",
    description: "Plan a path to a named spot on the field and walk there, steering around the ball and the goal, ending in that spot's pose.",
    params: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: Object.keys(TARGETS),
          description: "behind_ball: about half a metre behind the ball on the shooting line, facing the aim point, ready for a run-up. spawn: the duck's starting spot, facing the goal.",
        },
        aim: AIM_PARAM,
      },
    },
    defaults: { target: "behind_ball", aim: "goal" },
    options: [{
      label: "navigate_to:behind_ball",
      title: "Go behind ball",
      description: "Walk to a spot about half a metre behind the ball, on the line from the goal through the ball, to get room for a run-up.",
      args: { target: "behind_ball" },
    }],
    // No free staging pose (ball near a wall): nudge it off first.
    blocker: (obs, { target }) => {
      if (target !== "behind_ball" || hasRunUpRoom(obs)) return null;
      const { dist, wall } = nearestWall(obs.ballPos);
      return `no room behind the ball for a run-up (${cm(dist)} cm from the ${wall} wall): nudge it off first`;
    },
    run: async (env, { target, aim }) => {
      if (!TARGETS[target]) return failed(`unknown target "${target}" (expected ${Object.keys(TARGETS).join(", ")})`);
      const bad = badAim(aim);
      if (bad) return bad;
      const res = await navigate(env, TARGETS[target], 30, aim);
      // Say what the result means for the play, not just where the duck is:
      // System One picks the next tool from this text.
      if (!res.ok) return res;
      return target === "behind_ball"
        ? { ...res, text: `standing behind the ball facing the goal, ready for a run-up (${res.text})` }
        : { ...res, text: `back at the spawn spot facing the goal (${res.text})` };
    },
  },
  approach: {
    label: "Run-up",
    description: "Walk up to the ball along the shooting line so it ends up in front of the chosen foot, facing the aim point. Needs the duck behind the ball, near the line.",
    params: {
      type: "object",
      properties: { foot: FOOT_PARAM, aim: AIM_PARAM },
      required: ["foot"],
    },
    defaults: { aim: "goal" },
    options: ["left", "right"].map((foot) => ({
      label: `approach:${foot}`,
      title: `Run-up · ${foot} foot`,
      description: `Walk up to the ball along the shooting line so it ends up in front of the ${foot.toUpperCase()} foot, facing the goal.`,
      args: { foot },
    })),
    blocker: approachBlocker,
    run: async (env, { foot, aim }) => badAim(aim) || approachForKick(env, foot, aim),
  },
  kick: {
    label: "Kick",
    description: "Kick with the chosen foot; the ball travels along the duck's heading. Needs the ball in that foot's sweet spot.",
    params: {
      type: "object",
      properties: { foot: FOOT_PARAM },
      required: ["foot"],
    },
    defaults: {},
    options: ["left", "right"].map((foot) => ({
      label: `kick:${foot}`,
      title: `Kick · ${foot}`,
      description: `Kick with the ${foot.toUpperCase()} foot.`,
      args: { foot },
    })),
    blocker: (obs, { foot }) => kickBlocker(obs, foot),
    run: async (env, { foot }) => kick(env, foot),
  },
  nudge_ball: {
    label: "Nudge",
    description: "When the ball is too close to a wall for a run-up toward the goal: line up on its free side and kick it a short way into open floor, so the normal play can start. Picks the direction itself.",
    params: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["away_from_wall"], description: "away_from_wall: into the open floor, from whichever side of the ball is free." },
        foot: FOOT_PARAM,
      },
    },
    defaults: { direction: "away_from_wall", foot: "left" },
    options: [{
      label: "nudge_ball:away_from_wall",
      title: "Nudge off the wall",
      description: "The ball is too close to a wall to line up for the goal: kick it a short way into open floor first.",
      args: {},
    }],
    blocker: (obs) => (hasRunUpRoom(obs) ? "the ball has room for a normal run-up"
      : nudgeHeading(obs) ? null : "no side of the ball is free to kick it from"),
    run: async (env, { foot }) => nudge(env, foot),
  },
};
