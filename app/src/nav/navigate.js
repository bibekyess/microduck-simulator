// makeNav(goalFn, opts): plan a path to goalFn(obs), follow it with pure
// pursuit, replan when the goal moves, the duck strays or the way is
// blocked, and report how it ended. No timers, no env: step(obs) returns
// the next command or the result, so the same code runs in the browser
// (tools.js drive loop) and in the offline test bed.
//
//   const nav = makeNav((obs) => pose | [pose, fallback...], { world: (obs) => makeWorld(...) });
//   nav.step(obs, nowS) -> { cmd: [vx, wz] } | { done: { ok, text, data } }
import { ROBOT } from "./robot.js";
import { plan } from "./planner.js";
import { makePursuit } from "./pure-pursuit.js";

const GOAL_MOVED = 0.05; // m the goal can drift before replanning
const GOAL_TURNED = 0.2; // rad the goal heading can drift before replanning
const OFF_PATH = 0.15; // m from the path before replanning
const REPLAN_GAP = 1.0; // s between deviation replans (a fresh path always starts with an arc the lagging duck misses)
const EXTEND = 1.5 * ROBOT.planRadius; // m of virtual path past the goal, for the pursuit
const OVERRUN = 0.12; // m past the goal pose the duck may roll while its heading settles
const ARRIVE_ZONE = 0.3; // m of path left before the goal within which arrival / overshoot is judged
const ALIGNED = Math.PI / 3; // rad of heading error below which the duck counts as on its final approach

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (rad) => Math.round((rad * 180) / Math.PI);

export function makeNav(goalFn, { world, posTol = 0.08, headingTol = 0.3 } = {}) {
  let goal = null, which = 0, path = null, pursuit = null, replans = -1, length = 0, plannedAt = -Infinity;
  const goals = (obs) => [].concat(goalFn(obs)); // goalFn may offer fallbacks, best first

  // Returns a failure reason, or null once a path is ready.
  const replan = (obs, now) => {
    plannedAt = now;
    replans++;
    const w = world(obs);
    let res = null;
    for (const [i, g] of goals(obs).entries()) {
      res = plan(obs.duck, g, w);
      goal = g;
      which = i;
      if (res.points) break;
    }
    if (!res.points) { path = pursuit = null; return res.reason; }
    const end = res.points.at(-1), tail = [];
    for (let s = 0.02; s <= EXTEND; s += 0.02) {
      tail.push([end[0] + s * Math.cos(end[2]), end[1] + s * Math.sin(end[2]), end[2]]);
    }
    path = res.points;
    length = res.length;
    pursuit = makePursuit([...res.points, ...tail], res.points.length - 1);
    return null;
  };

  // Position relative to the goal pose: along its heading and to its left.
  const relative = (obs) => {
    const dx = obs.duck[0] - goal[0], dy = obs.duck[1] - goal[1];
    return { along: dx * Math.cos(goal[2]) + dy * Math.sin(goal[2]), lateral: -dx * Math.sin(goal[2]) + dy * Math.cos(goal[2]) };
  };

  const report = (obs, ok, why) => {
    const d = dist(obs.duck, goal), h = wrapPi(goal[2] - obs.duck[2]);
    const where = `${(d * 100).toFixed(0)} cm from the target pose, heading off by ${deg(h)}°`;
    return { done: { ok, text: `${why}: ${where}`, data: { replans, pathLength: length, distM: d, headingErr: h } } };
  };

  return {
    get path() { return path; },
    get goal() { return goal; },
    // Called by the runner on timeout, so the text says how far it got.
    timedOut: (obs) => report(obs, false, "timed out"),
    step(obs, now) {
      const fresh = goals(obs)[which];
      if (!goal || dist(fresh, goal) > GOAL_MOVED || Math.abs(wrapPi(fresh[2] - goal[2])) > GOAL_TURNED) {
        const reason = replan(obs, now);
        if (reason) return report(obs, false, reason);
      }
      // Arrival: at the pose, or a little past it (rolling on along its
      // heading straightens the duck out), facing the right way.
      let { cmd, offPath, remaining, passed } = pursuit.step(obs.duck);
      const { along, lateral } = relative(obs);
      const headingErr = Math.abs(wrapPi(goal[2] - obs.duck[2]));
      // Judge arrival only once the duck is on the last stretch and roughly
      // pointing the goal's way: off to the side, or still turning in the
      // final arc, means keep following (the replan below handles a lost
      // path), not "missed".
      if (remaining < ARRIVE_ZONE && Math.abs(lateral) < 2 * posTol && headingErr < ALIGNED) {
        const atPose = Math.abs(lateral) < posTol && along > -posTol;
        if (atPose && headingErr < headingTol) return report(obs, true, "arrived");
        if (along > OVERRUN) return report(obs, false, atPose ? "overshot the target pose without facing the right way" : "missed the target pose");
      }
      if ((offPath > OFF_PATH || passed) && now - plannedAt > REPLAN_GAP) {
        const reason = replan(obs, now);
        if (reason) return report(obs, false, reason);
        cmd = pursuit.step(obs.duck).cmd;
      }
      return { cmd };
    },
  };
}
