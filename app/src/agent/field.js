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

export function fieldWorld(obs) {
  return makeWorld({
    bounds: ARENA_HALF,
    obstacles: [{ x: obs.ballPos[0], y: obs.ballPos[1], r: BALL_RADIUS + BALL_CLEAR }],
    segments: GOAL_SEGMENTS,
  });
}
