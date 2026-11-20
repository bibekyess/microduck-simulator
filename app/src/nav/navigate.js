// makeNav(goalFn, opts): plan a path to goalFn(obs), walk its legs (pivot
// on the spot, or follow a curve with pure pursuit), replan when the goal
// moves, the duck strays or the way is blocked, and report how it ended.
// No timers, no env: step(obs) returns the next command or the result, so the same code runs in the browser
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
const LEG_END = 0.05; // m before the end of an intermediate straight where the next pivot takes over

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (rad) => Math.round((rad * 180) / Math.PI);

export function makeNav(goalFn, { world, posTol = 0.08, headingTol = 0.3 } = {}) {
  let goal = null, which = 0, path = null, legs = [], leg = 0, pursuit = null, replans = -1, length = 0, plannedAt = -Infinity, pivots = 0;
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
    if (!res.points) { path = pursuit = null; legs = []; return res.reason; }
    path = res.points;
    length = res.length;
    legs = res.legs;
    leg = -1;
    nextLeg();
    return null;
  };

  // Start the next leg. Only the final follow leg gets the virtual
  // extension past its end (so the pursuit settles onto the goal heading).
  const nextLeg = () => {
    leg++;
    pursuit = null;
    const l = legs[leg];
    if (!l || l.type !== "follow") return;
    const final = leg === legs.length - 1, tail = [];
    if (final) {
      const end = l.points.at(-1);
      for (let s = 0.02; s <= EXTEND; s += 0.02) tail.push([end[0] + s * Math.cos(end[2]), end[1] + s * Math.sin(end[2]), end[2]]);
    }
    pursuit = makePursuit([...l.points, ...tail], l.points.length - 1);
  };

  // Position relative to the goal pose: along its heading and to its left.
  const relative = (obs) => {
    const dx = obs.duck[0] - goal[0], dy = obs.duck[1] - goal[1];
    return { along: dx * Math.cos(goal[2]) + dy * Math.sin(goal[2]), lateral: -dx * Math.sin(goal[2]) + dy * Math.cos(goal[2]) };
  };

  const report = (obs, ok, why) => {
    const d = dist(obs.duck, goal), h = wrapPi(goal[2] - obs.duck[2]);
    const where = `${(d * 100).toFixed(0)} cm from the target pose, heading off by ${deg(h)}°`;
    return { done: { ok, text: `${why}: ${where}`, data: { replans, pivots, pathLength: length, distM: d, headingErr: h } } };
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
      // Pivot leg: turn on the spot, stop a little early (the turn runs on
      // through the policy's lag).
      let l = legs[leg];
      if (l?.type === "pivot") {
        const err = wrapPi(l.heading - obs.duck[2]);
        if (Math.abs(err) > ROBOT.pivotLead) return { cmd: [0, Math.sign(err) * ROBOT.pivotCmd] };
        pivots++;
        nextLeg();
        l = legs[leg];
        // Plan ended on a pivot (no room for a run-in): judge arrival now.
        if (!l) {
          const ok = dist(obs.duck, goal) < posTol && Math.abs(wrapPi(goal[2] - obs.duck[2])) < headingTol;
          return report(obs, ok, ok ? "arrived" : "pivoted at the end but missed the target pose");
        }
      }
      let { cmd, offPath, remaining, passed } = pursuit.step(obs.duck);
      // Intermediate straight: hand over to the next pivot near its end.
      if (leg < legs.length - 1) {
        if (remaining < LEG_END || passed) { nextLeg(); return { cmd: [0, 0] }; }
        if (offPath > OFF_PATH && now - plannedAt > REPLAN_GAP) {
          const reason = replan(obs, now);
          if (reason) return report(obs, false, reason);
          return { cmd: [0, 0] };
        }
        return { cmd };
      }
      // Arrival: at the pose, or a little past it (rolling on along its
      // heading straightens the duck out), facing the right way.
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
        cmd = pursuit ? pursuit.step(obs.duck).cmd : [0, 0];
      }
      return { cmd };
    },
  };
}
