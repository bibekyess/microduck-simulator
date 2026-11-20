// Observation: turn raw poses into what the agent reasons about.
//
// observe(env, aim) -> numbers the tools and the gating use. Metres and
// radians; duck-frame values: fwd = ahead of the duck, lat = + to its
// left / - to its right, bearings + = left. aim names the point the
// shooting line runs to (field.js AIMS), or is that point itself.
// describe(obs) -> the same thing as short plain text for System One;
// describe(obs, { full: true }) adds the field geometry an LLM needs.
import { GOAL_CENTER, isBallInGoal } from "../game/goal.js";
import { SPAWN_X, SPAWN_Y } from "../game/constants.js";
import { AIMS, lineCoords, nearestWall, roomBehind } from "./field.js";

export const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (rad) => Math.round((rad * 180) / Math.PI);

// Kick sweet spot, measured with the blind kick policies: ball centre
// KICK_FWD ahead of the duck and KICK_LAT out to the kicking foot's side.
// The shot then travels roughly along the duck's heading.
export const KICK_FWD = [0.07, 0.11];
export const KICK_LAT = [0.025, 0.075];

export function observe(env, aim = "goal") {
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
  // Shooting line: from the ball to the aim point in the net. A kick sends
  // the ball along the duck's heading, so this is the heading to hold.
  const [ax, ay] = Array.isArray(aim) ? aim : AIMS[aim]; // a name, or a floor point (nudges)
  const shotHeading = Math.atan2(ay - ballPos[1], ax - ballPos[0]);
  return {
    duck, ballPos, ball, aim,
    // Named places skills can be sent to (MJCF metres).
    targets: { ball: [ballPos[0], ballPos[1]], goal: GOAL_CENTER, spawn: [SPAWN_X, SPAWN_Y] },
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

const metres = (v) => `${Math.abs(v).toFixed(2)} m`;
const wallText = (p) => {
  const { dist, wall } = nearestWall(p);
  return `${metres(dist)} from the ${wall} wall`;
};

export function describe(obs, { full = false } = {}) {
  const f = deg(obs.facingErr);
  const terse = {
    ball: `${obs.ball.dist.toFixed(2)} m away; ${ballPlacement(obs)}`,
    goal: `${obs.goal.dist.toFixed(2)} m away`,
    facing_goal: Math.abs(f) <= 8
      ? "yes: a kick now would travel toward the goal"
      : `no: a kick now would miss by ${Math.abs(f)}° to the ${f > 0 ? "right" : "left"}`,
    ball_in_goal: obs.ballInGoal,
  };
  if (!full) return terse;
  const line = lineCoords(obs);
  return {
    ...terse,
    ball_to_walls: wallText(obs.ballPos),
    room_behind_ball: `${metres(roomBehind(obs))} along the shooting line`,
    duck_vs_shooting_line: `${metres(line.s)} ${line.s < 0 ? "behind" : "ahead of"} the ball, `
      + `${metres(line.offset)} to the ${line.offset >= 0 ? "left" : "right"} of the line`,
    duck_to_walls: wallText(obs.duck),
  };
}
