// The penalty field as the nav stack sees it: where "behind the ball" is
// and what to keep clear of. Pure functions of an observation, shared by
// the tools and the offline test bed.
import { makeWorld } from "../nav/world.js";
import { ARENA_HALF, BALL_RADIUS } from "../game/constants.js";
import { GOAL } from "../game/goal.js";

export const STAGE_BACK = 0.5; // m behind the ball where run-ups start
const STAGE_FALLBACKS = [0.5, 0.4, 0.3]; // closer staging when the walls leave no room
const BALL_CLEAR = 0.04; // m extra around the ball (it must not be brushed)

// Goal posts and net walls as segments the duck must not walk into.
const { mouthX, backX, halfWidth: w, post: p } = GOAL;
const GOAL_SEGMENTS = [
  { x1: mouthX, y1: w + p, x2: backX, y2: w + p },
  { x1: mouthX, y1: -w - p, x2: backX, y2: -w - p },
  { x1: backX, y1: -w - p, x2: backX, y2: w + p },
];

// Pose `back` metres behind the ball on the shooting line, facing the goal.
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
