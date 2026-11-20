// plan(start, goal, world): the quickest collision-free path from one pose
// to another for a duck that walks forward on curves and can pivot on the
// spot. Three tiers, cheapest first:
//
//   1. Dubins: direct words, then via a ring of poses around each obstacle
//      and a coarse grid of poses (smooth, no stops).
//   2. Pivot first: turn on the spot to one of 16 headings, then a direct
//      Dubins path. Wins when the duck faces the wrong way, or is boxed in
//      so that no curve fits.
//   3. Grid fallback: A* over a fine grid of floor cells, smoothed to
//      straight lines, walked as pivot -> straight -> pivot -> ... Since
//      the duck can pivot, this finds a way whenever the start and goal are
//      in the same free region: corners and walls cannot trap it.
//
// Returns { legs, points, length, timeS, tier } or { points: null, reason }.
// legs: [{ type: "pivot", heading } | { type: "follow", points }], in
// order; the last leg is a follow ending on the goal pose (or a pivot to
// its heading when there is no room for a straight run-in). points: every
// follow leg's points, for drawing.
//
// A start that is already in collision (duck brushing the ball after a
// kick, or near a wall) is allowed as long as the path never gets closer
// than the start already is.
import { ROBOT, actualSpeed } from "./robot.js";
import { dubinsPaths, sample } from "./dubins.js";

const STEP = 0.02; // m between samples
const VIA_POINTS = 8; // candidate poses around each obstacle
const VIA_GAP = 0.08; // m beyond the obstacle's keep-out where the ring sits
const GRID = 0.4; // m, spacing of the via grid
const GRID_HEADINGS = 8;
const RUN_IN = 0.3; // m of straight path before the goal pose, so the heading settles
const RUN_IN_COST = 0.4; // m a run-in may add over the shortest path before it's dropped
const PIVOT_HEADINGS = 16; // headings a pivot-first plan tries
const PIVOT_MIN = 0.3; // rad: smaller turns are left to the curve
const PIVOT_GAIN = 1.0; // s a pivot-first plan must save over a pure curve to be chosen
const CELL = 0.04; // m, A* grid cell
const V_CURVE = actualSpeed(ROBOT.vCurve); // m/s, for time estimates

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const detourLength = (a, v, b) => Math.hypot(v[0] - a[0], v[1] - a[1]) + Math.hypot(b[0] - v[0], b[1] - v[1]);
const pivotTime = (from, to) => Math.abs(wrapPi(to - from)) / ROBOT.pivotRate + ROBOT.pivotOverhead;

function free(points, world, floor) {
  return points.every((p) => world.clearance(p) >= floor);
}

// Straight samples from a to b (excluding a), all with heading h.
function line(a, b, h = Math.atan2(b[1] - a[1], b[0] - a[0])) {
  const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / STEP)), pts = [];
  for (let i = 1; i <= n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, h]);
  return pts;
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

// Dubins (direct, or via when allowed) from start to `pre`, then the
// straight `tail` to the goal.
function curveTo(start, pre, tail, world, radius, floor, viaToo) {
  const finish = (res) => res && { points: [...res.points, ...tail], length: res.length + tail.length * STEP };
  const best = direct(start, pre, world, radius, floor);
  if (best || !viaToo) return finish(best);
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

// Pre-poses `back` metres before the goal on its heading, with the
// straight tail from there to the goal; only those with a free run-in.
function preposes(goal, world, runIn) {
  const out = [];
  for (const back of [runIn, runIn / 2, 0]) {
    const pre = [goal[0] - back * Math.cos(goal[2]), goal[1] - back * Math.sin(goal[2]), goal[2]];
    if (back > 0 && !world.isFree(pre)) continue;
    const tail = back > 0 ? line(pre, goal, goal[2]) : [];
    if (!free(tail, world, 0)) continue;
    out.push({ back, pre, tail });
  }
  return out;
}

// Among plans to different pre-poses, prefer the longest run-in unless it
// costs a loop (more than RUN_IN_COST extra).
function preferRunIn(found) {
  if (!found.length) return null;
  const shortest = Math.min(...found.map((r) => r.length));
  return found.find((r) => r.length <= shortest + RUN_IN_COST);
}

// Tier 1: curves only.
function curvePlan(start, pres, world, radius, floor) {
  const found = [];
  for (const { pre, tail } of pres) {
    const res = curveTo(start, pre, tail, world, radius, floor, true);
    if (res) found.push(res);
  }
  const res = preferRunIn(found);
  return res && { legs: [{ type: "follow", points: res.points }], length: res.length, timeS: res.length / V_CURVE };
}

// Tier 2: pivot on the spot, then a direct curve.
function pivotPlan(start, pres, world, radius, floor) {
  const headings = [];
  for (let i = 0; i < PIVOT_HEADINGS; i++) headings.push((i / PIVOT_HEADINGS) * 2 * Math.PI - Math.PI);
  for (const { pre } of pres) headings.push(Math.atan2(pre[1] - start[1], pre[0] - start[0]));
  let best = null;
  for (const h of headings) {
    if (Math.abs(wrapPi(h - start[2])) < PIVOT_MIN) continue;
    const turned = [start[0], start[1], h];
    const found = [];
    for (const { pre, tail } of pres) {
      const res = curveTo(turned, pre, tail, world, radius, floor, false);
      if (res) found.push(res);
    }
    const res = preferRunIn(found);
    if (!res) continue;
    const timeS = pivotTime(start[2], h) + res.length / V_CURVE;
    if (!best || timeS < best.timeS) {
      best = { legs: [{ type: "pivot", heading: h }, { type: "follow", points: res.points }], length: res.length, timeS };
    }
  }
  return best;
}

// Tier 3: A* over CELL-sized floor cells (8-connected), line-of-sight
// smoothing, then pivot -> straight legs. Cells must keep the clearance
// floor; the start cell is exempt (the duck is already there).
function gridPlan(start, pres, goal, world, floor) {
  const n = Math.ceil((2 * world.bounds) / CELL);
  const toCell = (v) => Math.max(0, Math.min(n - 1, Math.floor((v + world.bounds) / CELL)));
  const center = (i) => -world.bounds + (i + 0.5) * CELL;
  const ok = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) ok[i * n + j] = world.clearance([center(i), center(j)]) >= floor ? 1 : 0;
  const s = toCell(start[0]) * n + toCell(start[1]);
  ok[s] = 1;
  const segFree = (a, b) => free(line(a, b), world, floor);

  for (const { pre, tail, back } of pres) {
    const g = toCell(pre[0]) * n + toCell(pre[1]);
    if (!ok[g]) continue;
    // A* with an octile heuristic and a binary heap.
    const cost = new Float64Array(n * n).fill(Infinity), from = new Int32Array(n * n).fill(-1);
    const h = (k) => { const dx = Math.abs(((k / n) | 0) - ((g / n) | 0)), dy = Math.abs((k % n) - (g % n)); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    const heap = [[h(s), s]];
    const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    cost[s] = 0;
    let found = false;
    while (heap.length) {
      const [, k] = pop();
      if (k === g) { found = true; break; }
      const ki = (k / n) | 0, kj = k % n;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const i = ki + di, j = kj + dj;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const m = i * n + j;
        if (!ok[m] || (di && dj && (!ok[ki * n + j] || !ok[i * n + kj]))) continue;
        const c = cost[k] + (di && dj ? 1.414 : 1);
        if (c < cost[m]) { cost[m] = c; from[m] = k; push([c + h(m), m]); }
      }
    }
    if (!found) continue;
    // Cell chain -> floor points (exact start and pre at the ends), then
    // keep only the corners line of sight needs.
    const chain = [];
    for (let k = from[g]; k !== -1 && k !== s; k = from[k]) chain.unshift([center((k / n) | 0), center(k % n)]);
    const raw = [[start[0], start[1]], ...chain, [pre[0], pre[1]]];
    const corners = [raw[0]];
    for (let i = 0; i < raw.length - 1;) {
      let j = raw.length - 1;
      while (j > i + 1 && !segFree(raw[i], raw[j])) j--;
      corners.push(raw[j]);
      i = j;
    }
    const legs = [];
    let heading = start[2], length = 0, timeS = 0;
    for (let i = 0; i < corners.length - 1; i++) {
      const a = corners[i], b = corners[i + 1];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d < 1e-6) continue;
      const hdg = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (Math.abs(wrapPi(hdg - heading)) >= PIVOT_MIN / 2) { legs.push({ type: "pivot", heading: hdg }); timeS += pivotTime(heading, hdg); }
      legs.push({ type: "follow", points: [[a[0], a[1], hdg], ...line(a, b, hdg)] });
      heading = hdg;
      length += d;
      timeS += d / actualSpeed(ROBOT.vMaxCmd);
    }
    // Face the goal, then the run-in (if there is room for one).
    if (Math.abs(wrapPi(goal[2] - heading)) >= PIVOT_MIN / 2 || !tail.length) {
      legs.push({ type: "pivot", heading: goal[2] });
      timeS += pivotTime(heading, goal[2]);
    }
    if (tail.length) {
      legs.push({ type: "follow", points: [[pre[0], pre[1], goal[2]], ...tail] });
      length += back;
      timeS += back / V_CURVE;
    }
    return { legs, length, timeS };
  }
  return null;
}

export function plan(start, goal, world, { radius = ROBOT.planRadius, runIn = RUN_IN } = {}) {
  if (!world.isFree(goal)) return { points: null, reason: "the target pose is blocked" };
  const floor = Math.min(0, world.clearance(start) - 0.01);
  const pres = preposes(goal, world, runIn);
  const curve = curvePlan(start, pres, world, radius, floor);
  const pivot = pivotPlan(start, pres, world, radius, floor);
  let res = curve && (!pivot || curve.timeS <= pivot.timeS + PIVOT_GAIN) ? { ...curve, tier: "curve" } : pivot && { ...pivot, tier: "pivot" };
  if (!res) { const grid = gridPlan(start, pres, goal, world, floor); res = grid && { ...grid, tier: "grid" }; }
  if (!res) return { points: null, reason: "no path: the target pose cannot be reached from here (walls or the ball cut it off)" };
  return { ...res, points: res.legs.flatMap((l) => (l.type === "follow" ? l.points : [])) };
}
