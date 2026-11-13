// Regulated Pure Pursuit (Nav2's controller for car-like robots): chase a
// point one lookahead ahead on the path; the curvature that reaches it
// gives the turn rate, and speed drops on curves and near the end.
//
// makePursuit(points) keeps the progress index so the duck never chases a
// part of the path it has already passed.
// step(pose) -> { cmd: [vx, wz], offPath (m), remaining (m of path to the
// goal), passed (true once the closest point is the path's last one) }.
import { ROBOT, actualSpeed } from "./robot.js";

const LOOKAHEAD = ROBOT.planRadius; // m; longer than this cuts the tightest arcs
const FINAL_LOOKAHEAD = 0.12; // m on the last stretch, so the heading settles faster
const FINAL_ZONE = 0.35; // m of path before the goal that counts as the last stretch
const SLOW_ZONE = 0.25; // m before the end where speed drops to vMinCmd
const CURVE_K = 0.5 / ROBOT.planRadius; // curvature above which it counts as a curve

const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// points: the path plus any straight extension; goalIndex: where the real
// goal sits in it (default: the last point).
export function makePursuit(points, goalIndex = points.length - 1) {
  let idx = 0;
  const end = points[goalIndex];
  return {
    step(pose) {
      // Closest point, never moving backwards along the path.
      let offPath = Infinity;
      for (let i = idx; i < points.length; i++) {
        const d = dist(points[i], pose);
        if (d < offPath) { offPath = d; idx = i; }
      }
      const remaining = (goalIndex - idx) * dist(points[0], points[1]);
      const look = remaining < FINAL_ZONE ? FINAL_LOOKAHEAD : LOOKAHEAD;
      let target = points.at(-1);
      for (let i = idx; i < points.length; i++) {
        if (dist(points[i], pose) >= look) { target = points[i]; break; }
      }
      const alpha = wrapPi(Math.atan2(target[1] - pose[1], target[0] - pose[0]) - pose[2]);
      const d = Math.max(dist(target, pose), 1e-3);
      // Target behind us: pure pursuit's curvature collapses, so turn hard.
      const k = Math.abs(alpha) > Math.PI / 2 ? (Math.sign(alpha) * 2) / ROBOT.turnRadius : (2 * Math.sin(alpha)) / d;
      let vx = dist(end, pose) < SLOW_ZONE ? ROBOT.vMinCmd : ROBOT.vMaxCmd;
      if (Math.abs(k) > CURVE_K) vx = Math.min(vx, ROBOT.vCurve);
      // Commanded turn rate for the actual speed and curvature.
      const wz = clamp((actualSpeed(vx) * k) / ROBOT.turnPerCmd, ROBOT.wMax);
      return { cmd: [vx, wz], offPath, remaining, passed: idx === points.length - 1 };
    },
  };
}
