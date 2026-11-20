// The penalty field as the nav stack sees it: where "behind the ball" is
// and what to keep clear of. Pure functions of an observation, shared by
// the tools and the offline test bed.
import { makeWorld } from "../nav/world.js";
import { ARENA_HALF, BALL_RADIUS } from "../game/constants.js";
import { GOAL, GOAL_AIM } from "../game/goal.js";

export const STAGE_BACK = 0.5; // m behind the ball where run-ups start
const STAGE_FALLBACKS = [0.5, 0.4, 0.3]; // closer staging when the walls leave no room
const BALL_CLEAR = 0.04; // m extra around the ball (it must not be brushed)

// Where a shot can aim, by name. Corners sit 0.18 m off centre, inside
// the posts (halfWidth 0.3) with room for the ball. y + = the duck's left
// when it faces the goal.
const CORNER = 0.18;
export const AIMS = {
  goal: GOAL_AIM,
  left_corner: [GOAL_AIM[0], CORNER],
  right_corner: [GOAL_AIM[0], -CORNER],
};

// Goal posts and net walls as segments the duck must not walk into.
const { mouthX, backX, halfWidth: w, post: p } = GOAL;
const GOAL_SEGMENTS = [
  { x1: mouthX, y1: w + p, x2: backX, y2: w + p },
  { x1: mouthX, y1: -w - p, x2: backX, y2: -w - p },
  { x1: backX, y1: -w - p, x2: backX, y2: w + p },
];

// The duck's position relative to the shooting line (obs.shotHeading,
// i.e. the aim obs was observed with), shifted `side` metres to the
// line's left: s = metres along it (negative = behind the ball), offset =
// metres to its left, at(s) = the floor point at line coordinate s.
export function lineCoords(obs, side = 0) {
  const h = obs.shotHeading;
  const ux = Math.cos(h), uy = Math.sin(h); // along the line
  const nx = -uy, ny = ux; // to the line's left
  const ox = obs.ballPos[0] + nx * side, oy = obs.ballPos[1] + ny * side;
  const dx = obs.duck[0] - ox, dy = obs.duck[1] - oy;
  return {
    s: dx * ux + dy * uy,
    offset: dx * nx + dy * ny,
    at: (s) => [ox + ux * s, oy + uy * s],
  };
}

// Nearest arena wall to a floor point, named as seen from the spawn
// (facing the goal): { dist, wall: "left" | "right" | "back" | "goal" }.
export function nearestWall([x, y]) {
  const walls = { goal: ARENA_HALF - x, back: ARENA_HALF + x, left: ARENA_HALF - y, right: ARENA_HALF + y };
  const wall = Object.keys(walls).reduce((a, b) => (walls[b] < walls[a] ? b : a));
  return { dist: walls[wall], wall };
}

// Free metres behind the ball along the shooting line before a wall: the
// room a run-up has.
export function roomBehind(obs) {
  const back = [-Math.cos(obs.shotHeading), -Math.sin(obs.shotHeading)];
  let room = Infinity;
  for (let k = 0; k < 2; k++) {
    if (Math.abs(back[k]) < 1e-6) continue;
    const wall = back[k] > 0 ? ARENA_HALF : -ARENA_HALF;
    room = Math.min(room, (wall - obs.ballPos[k]) / back[k]);
  }
  return room;
}

// Pose `back` metres behind the ball on the shooting line, facing the aim
// point (obs carries the aim it was observed with).
export function behindBall(obs, back = STAGE_BACK) {
  const h = obs.shotHeading;
  return [obs.ballPos[0] - back * Math.cos(h), obs.ballPos[1] - back * Math.sin(h), h];
}

// Staging poses for navigate(), best first: the full run-up distance, then
// closer ones that still satisfy the approach tool's blocker.
export const stagingPoses = (obs) => STAGE_FALLBACKS.map((back) => behindBall(obs, back));

// tight: 1 cm margins instead of 4 / 3 cm, for nudges, which must squeeze
// between a ball and a wall (a 25 cm gap fits the 16 cm duck, but not
// with the normal margins on both sides).
export function fieldWorld(obs, { tight = false } = {}) {
  return makeWorld({
    bounds: ARENA_HALF,
    obstacles: [{ x: obs.ballPos[0], y: obs.ballPos[1], r: BALL_RADIUS + (tight ? 0.01 : BALL_CLEAR) }],
    segments: GOAL_SEGMENTS,
    margin: tight ? 0.01 : 0.03,
  });
}
export const nudgeWorld = (obs) => fieldWorld(obs, { tight: true });

// ── Nudges (Phase 4) ───────────────────────────────────────────────────
// A ball close to a wall has no free spot behind it on the line to the
// goal. A nudge kicks it a short way into open floor first, from whichever
// side of it is free.

export const NUDGE_BACKS = [0.4, 0.3, 0.25, 0.23]; // m behind the ball the nudge stages at, best first
const NUDGE_SLACK = 0.015; // m of clearance a nudge staging pose must keep, so ball jitter can't block it
const NUDGE_REACH = [0.5, 1.0, 1.5, 1.8]; // m a nudge kick may carry the ball (the one kick strength: 0.4-1.7 m measured)
const NUDGE_HEADINGS = 72;
// Walls and goal only: where a nudged ball could end up.
const PITCH = makeWorld({ bounds: ARENA_HALF, segments: GOAL_SEGMENTS, margin: 0 });

// True when one of the normal staging poses (toward the goal) is free.
export function hasRunUpRoom(obs) {
  const world = fieldWorld(obs);
  return stagingPoses(obs).some((p) => world.isFree(p));
}

// The ball at `p`, seen as a fresh penalty: aimed at the goal.
const ballAt = (p) => ({ ballPos: p, shotHeading: Math.atan2(GOAL_AIM[1] - p[1], GOAL_AIM[0] - p[0]) });

// Directions to nudge the ball in, best first: [{ heading, back, score }]. A
// direction qualifies when a staging pose `back` metres behind the ball on
// it is free and a short kick keeps the ball off the walls and the net. It
// scores by where the ball lands after short to long kicks (summed:
// the ball bounces off walls, so a long kick into one only costs a
// little): room for a normal run-up counts most, then distance from walls
// and the goal, then a longer staging distance, then kicking goalward.
export function nudgeHeadings(obs) {
  const world = nudgeWorld(obs), [bx, by] = obs.ballPos;
  const found = [];
  for (let i = 0; i < NUDGE_HEADINGS; i++) {
    const h = (i / NUDGE_HEADINGS) * 2 * Math.PI - Math.PI;
    const c = Math.cos(h), s = Math.sin(h);
    const back = NUDGE_BACKS.find((b) => world.clearance([bx - b * c, by - b * s]) >= NUDGE_SLACK);
    if (back === undefined) continue;
    const lands = NUDGE_REACH.map((r) => [bx + r * c, by + r * s]);
    if (PITCH.clearance(lands[0]) < 0) continue; // a short kick already hits a wall or the net
    const score = lands.reduce((sum, to) => {
      const room = PITCH.clearance(to);
      return sum + (hasRunUpRoom(ballAt(to)) ? 1 : 0) + Math.max(-0.3, Math.min(room, 0.4));
    }, 0) + back + 0.1 * Math.cos(h - Math.atan2(GOAL_AIM[1] - by, GOAL_AIM[0] - bx)); // ties: steadier run-up, then toward the goal
    found.push({ heading: h, back, score });
  }
  return found.sort((a, b) => b.score - a.score);
}

export const nudgeHeading = (obs) => nudgeHeadings(obs)[0] ?? null;

// The nudge staging pose for one direction.
export const nudgeStage = (obs, { heading, back }) => [obs.ballPos[0] - back * Math.cos(heading), obs.ballPos[1] - back * Math.sin(heading), heading];
