// Dubins paths: the shortest path between two poses for a vehicle that
// only drives forward with a bounded turn radius. Six words (LSL, RSR,
// LSR, RSL, RLR, LRL); each is a triple of segment lengths in units of the
// turn radius. Formulas after Shkel & Lumelsky / A. Walker's dubins-curves.
//
// Pose: [x, y, heading]. A path is { word, lengths: [t, p, q], length } and
// sample(path, start, radius, step) turns it into [x, y, heading] points.

const TWO_PI = 2 * Math.PI;
const mod2pi = (a) => a - TWO_PI * Math.floor(a / TWO_PI);

const WORDS = {
  LSL: (d, a, b) => {
    const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b));
    if (p2 < 0) return null;
    const tmp = Math.atan2(Math.cos(b) - Math.cos(a), d + Math.sin(a) - Math.sin(b));
    return [mod2pi(tmp - a), Math.sqrt(p2), mod2pi(b - tmp)];
  },
  RSR: (d, a, b) => {
    const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a));
    if (p2 < 0) return null;
    const tmp = Math.atan2(Math.cos(a) - Math.cos(b), d - Math.sin(a) + Math.sin(b));
    return [mod2pi(a - tmp), Math.sqrt(p2), mod2pi(tmp - b)];
  },
  LSR: (d, a, b) => {
    const p2 = -2 + d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) + Math.sin(b));
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const tmp = Math.atan2(-Math.cos(a) - Math.cos(b), d + Math.sin(a) + Math.sin(b)) - Math.atan2(-2, p);
    return [mod2pi(tmp - a), p, mod2pi(tmp - mod2pi(b))];
  },
  RSL: (d, a, b) => {
    const p2 = -2 + d * d + 2 * Math.cos(a - b) - 2 * d * (Math.sin(a) + Math.sin(b));
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const tmp = Math.atan2(Math.cos(a) + Math.cos(b), d - Math.sin(a) - Math.sin(b)) - Math.atan2(2, p);
    return [mod2pi(a - tmp), p, mod2pi(b - tmp)];
  },
  RLR: (d, a, b) => {
    const tmp = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b))) / 8;
    if (Math.abs(tmp) > 1) return null;
    const p = mod2pi(TWO_PI - Math.acos(tmp));
    const phi = Math.atan2(Math.cos(a) - Math.cos(b), d - Math.sin(a) + Math.sin(b));
    const t = mod2pi(a - phi + mod2pi(p / 2));
    return [t, p, mod2pi(a - b - t + mod2pi(p))];
  },
  LRL: (d, a, b) => {
    const tmp = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a))) / 8;
    if (Math.abs(tmp) > 1) return null;
    const p = mod2pi(TWO_PI - Math.acos(tmp));
    const phi = Math.atan2(Math.cos(a) - Math.cos(b), d + Math.sin(a) - Math.sin(b));
    const t = mod2pi(-a - phi + p / 2);
    return [t, p, mod2pi(mod2pi(b) - a - t + mod2pi(p))];
  },
};

// All feasible words from start to goal, shortest first.
export function dubinsPaths(start, goal, radius) {
  const dx = goal[0] - start[0], dy = goal[1] - start[1];
  const d = Math.hypot(dx, dy) / radius;
  const theta = d > 0 ? mod2pi(Math.atan2(dy, dx)) : 0;
  const a = mod2pi(start[2] - theta), b = mod2pi(goal[2] - theta);
  const paths = [];
  for (const [word, fn] of Object.entries(WORDS)) {
    const lengths = fn(d, a, b);
    if (lengths) paths.push({ word, lengths, length: (lengths[0] + lengths[1] + lengths[2]) * radius });
  }
  return paths.sort((p, q) => p.length - q.length);
}

// Pose after driving `s` metres along one segment type from `pose`.
function advance([x, y, h], type, s, radius) {
  if (type === "S") return [x + s * Math.cos(h), y + s * Math.sin(h), h];
  const dir = type === "L" ? 1 : -1;
  const h1 = h + (dir * s) / radius;
  return [x + dir * radius * (Math.sin(h1) - Math.sin(h)), y - dir * radius * (Math.cos(h1) - Math.cos(h)), h1];
}

// [x, y, heading] every `step` metres along the path, ending exactly on
// the final pose.
export function sample(path, start, radius, step = 0.02) {
  const points = [];
  let segStart = start;
  let s = 0, from = 0; // distance along the whole path / where this segment starts
  for (let i = 0; i < 3; i++) {
    const type = path.word[i], len = path.lengths[i] * radius;
    for (; s < from + len; s += step) points.push(advance(segStart, type, s - from, radius));
    segStart = advance(segStart, type, len, radius);
    from += len;
  }
  points.push(segStart);
  return points;
}
