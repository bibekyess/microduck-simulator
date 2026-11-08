// Observation: turn raw poses into what the agent reasons about.
//
// observe(env) -> numbers the tools and the gating use. Metres and
// radians; duck-frame values: fwd = ahead of the duck, lat = + to its
// left / - to its right, bearings + = left.
// describe(obs) -> the same thing as short plain text for System One.
import { GOAL_CENTER, isBallInGoal } from "../game/goal.js";

export const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (rad) => Math.round((rad * 180) / Math.PI);

// Kick sweet spot, measured with the blind kick policies: ball centre
// KICK_FWD ahead of the duck and KICK_LAT out to the kicking foot's side.
// The shot then travels roughly along the duck's heading.
export const KICK_FWD = [0.07, 0.11];
export const KICK_LAT = [0.025, 0.075];

export function observe(env) {
  const duck = env.getDuckPose();
  const [x, y, yaw] = duck;
  const ballPos = env.getBallPos();
  const bdx = ballPos[0] - x, bdy = ballPos[1] - y;
  const ball = {
    dist: Math.hypot(bdx, bdy),
    fwd: bdx * Math.cos(yaw) + bdy * Math.sin(yaw),
    lat: -bdx * Math.sin(yaw) + bdy * Math.cos(yaw),
  };
  const goalBearing = wrapPi(Math.atan2(GOAL_CENTER[1] - y, GOAL_CENTER[0] - x) - yaw);
  // Shooting line: from the ball to the goal centre. A kick sends the ball
  // along the duck's heading, so this is the heading the duck should hold.
  const shotHeading = Math.atan2(GOAL_CENTER[1] - ballPos[1], GOAL_CENTER[0] - ballPos[0]);
  return {
    duck, ballPos, ball,
    goal: { dist: Math.hypot(GOAL_CENTER[0] - x, GOAL_CENTER[1] - y), bearing: goalBearing },
    shotHeading,
    facingErr: wrapPi(shotHeading - yaw), // + = should turn left
    ballInGoal: isBallInGoal(ballPos[0], ballPos[1]),
  };
}

// Which foot (if any) the ball is in kicking range of.
export function kickableFoot(obs) {
  const { fwd, lat } = obs.ball;
  if (fwd < KICK_FWD[0] || fwd > KICK_FWD[1]) return null;
  if (lat >= KICK_LAT[0] && lat <= KICK_LAT[1]) return "left";
  if (-lat >= KICK_LAT[0] && -lat <= KICK_LAT[1]) return "right";
  return null;
}

function ballPlacement(obs) {
  const { fwd, lat } = obs.ball;
  const foot = kickableFoot(obs);
  if (foot) return `in kicking range of the ${foot} foot`;
  if (fwd < 0) return "behind the duck";
  const side = Math.abs(lat) < KICK_LAT[0] ? "centred between the feet"
    : `${Math.abs(lat).toFixed(2)} m to the ${lat > 0 ? "left" : "right"}`;
  return `${fwd.toFixed(2)} m ahead, ${side}`;
}

export function describe(obs) {
  const f = deg(obs.facingErr);
  return {
    ball: `${obs.ball.dist.toFixed(2)} m away; ${ballPlacement(obs)}`,
    goal: `${obs.goal.dist.toFixed(2)} m away`,
    facing_goal: Math.abs(f) <= 8
      ? "yes: a kick now would travel toward the goal"
      : `no: a kick now would miss by ${Math.abs(f)}° to the ${f > 0 ? "right" : "left"}`,
    ball_in_goal: obs.ballInGoal,
  };
}
