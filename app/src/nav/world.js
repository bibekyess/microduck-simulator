// World model: square arena walls, circular obstacles and wall segments
// (goal posts and nets). clearance(p) is the signed distance from a point
// to the nearest thing, minus the robot's footprint and a safety margin:
// negative = in collision.
import { ROBOT } from "./robot.js";

function segmentDistance([x, y], { x1, y1, x2, y2 }) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// bounds: half-size of the square arena (walls at +-bounds)
// obstacles: [{ x, y, r }]   segments: [{ x1, y1, x2, y2 }]
// margin: clearance kept beyond the robot's own radius
export function makeWorld({ bounds, obstacles = [], segments = [], margin = 0.03 }) {
  const keep = ROBOT.radius + margin;
  const clearance = (p) => {
    let c = bounds - Math.max(Math.abs(p[0]), Math.abs(p[1]));
    for (const o of obstacles) c = Math.min(c, Math.hypot(p[0] - o.x, p[1] - o.y) - o.r);
    for (const s of segments) c = Math.min(c, segmentDistance(p, s));
    return c - keep;
  };
  return { bounds, obstacles, segments, clearance, isFree: (p) => clearance(p) >= 0 };
}
