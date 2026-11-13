// plan(start, goal, world): the shortest collision-free forward-only path
// from one pose to another. Direct Dubins words first; when every word
// collides, Dubins via a ring of intermediate poses around each obstacle
// (tangent headings both ways), shortest free combination wins. Returns
// { points: [[x, y, heading], ...], length } or { points: null, reason }.
//
// A start that is already in collision (duck brushing the ball after a
// kick, or near a wall) is allowed as long as the path never gets closer
// than the start already is.
import { ROBOT } from "./robot.js";
import { dubinsPaths, sample } from "./dubins.js";

const STEP = 0.02; // m between samples
const VIA_POINTS = 8; // candidate poses around each obstacle
const VIA_GAP = 0.08; // m beyond the obstacle's keep-out where the ring sits
const GRID = 0.4; // m, spacing of the via grid
const GRID_HEADINGS = 8;
const RUN_IN = 0.3; // m of straight path before the goal pose, so the heading settles
const RUN_IN_COST = 0.4; // m a run-in may add over the shortest path before it's dropped

const detourLength = (a, v, b) => Math.hypot(v[0] - a[0], v[1] - a[1]) + Math.hypot(b[0] - v[0], b[1] - v[1]);

function free(points, world, floor) {
  return points.every((p) => world.clearance(p) >= floor);
}

// Shortest free Dubins path from a to b, as sampled points, or null.
function direct(a, b, world, radius, floor) {
  for (const path of dubinsPaths(a, b, radius)) {
    const points = sample(path, a, radius, STEP);
    if (free(points, world, floor)) return { points, length: path.length };
  }
  return null;
}

// Candidate intermediate poses: a ring around each obstacle (tangent
// headings both ways, for going around it) and a coarse grid over the free
// floor (8 headings, for turning around near walls). Nearest the straight
// line start -> goal first, so the search can stop early.
function viaPoses(world, start, goal) {
  const poses = [];
  for (const o of world.obstacles) {
    const ring = o.r + ROBOT.radius + VIA_GAP;
    for (let i = 0; i < VIA_POINTS; i++) {
      const a = (i / VIA_POINTS) * 2 * Math.PI;
      const p = [o.x + ring * Math.cos(a), o.y + ring * Math.sin(a)];
      if (world.isFree(p)) poses.push([...p, a + Math.PI / 2], [...p, a - Math.PI / 2]);
    }
  }
  for (let x = -world.bounds + GRID / 2; x < world.bounds; x += GRID) {
    for (let y = -world.bounds + GRID / 2; y < world.bounds; y += GRID) {
      if (!world.isFree([x, y])) continue;
      for (let i = 0; i < GRID_HEADINGS; i++) poses.push([x, y, (i / GRID_HEADINGS) * 2 * Math.PI]);
    }
  }
  const detour = (v) => Math.hypot(v[0] - start[0], v[1] - start[1]) + Math.hypot(goal[0] - v[0], goal[1] - v[1]);
  return poses.sort((a, b) => detour(a) - detour(b));
}

// Dubins (direct or via) from start to `pre`, then straight to goal.
function search(start, pre, goal, world, radius, floor) {
  const tail = [];
  const n = Math.round(Math.hypot(goal[0] - pre[0], goal[1] - pre[1]) / STEP);
  for (let i = 1; i <= n; i++) tail.push([pre[0] + ((goal[0] - pre[0]) * i) / n, pre[1] + ((goal[1] - pre[1]) * i) / n, goal[2]]);
  if (!free(tail, world, 0)) return null;
  const finish = (res) => res && { points: [...res.points, ...tail], length: res.length + n * STEP };
  const best = direct(start, pre, world, radius, floor);
  if (best) return finish(best);
  let via = null;
  for (const v of viaPoses(world, start, pre)) {
    if (via && detourLength(start, v, pre) >= via.length) break; // sorted: nothing shorter left
    const first = direct(start, v, world, radius, floor);
    if (!first || (via && first.length >= via.length)) continue;
    const second = direct(v, pre, world, radius, 0);
    if (!second || (via && first.length + second.length >= via.length)) continue;
    via = { points: [...first.points.slice(0, -1), ...second.points], length: first.length + second.length };
  }
  return finish(via);
}

export function plan(start, goal, world, { radius = ROBOT.planRadius, runIn = RUN_IN } = {}) {
  if (!world.isFree(goal)) return { points: null, reason: "the target pose is blocked" };
  const floor = Math.min(0, world.clearance(start) - 0.01);
  // The pursuit needs a straight run-in to settle the heading, so prefer
  // the longest one, unless it costs a loop (more than RUN_IN_COST extra).
  const found = [];
  for (const back of [runIn, runIn / 2, 0]) {
    const pre = [goal[0] - back * Math.cos(goal[2]), goal[1] - back * Math.sin(goal[2]), goal[2]];
    if (back > 0 && !world.isFree(pre)) continue;
    const res = search(start, pre, goal, world, radius, floor);
    if (res) found.push(res);
  }
  if (!found.length) return { points: null, reason: "no path: the duck cannot curve into the target pose from here (walls or the ball in the way)" };
  const shortest = Math.min(...found.map((r) => r.length));
  return found.find((r) => r.length <= shortest + RUN_IN_COST);
}
