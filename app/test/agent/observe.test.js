// observe() / describe(): aims, named targets, and the terse text Jev reads
// staying exactly as it was before the full (LLM) view was added.
import test from "node:test";
import assert from "node:assert/strict";
import { observe, describe } from "../../src/agent/observe.js";
import { GOAL_CENTER } from "../../src/game/goal.js";
import { SPAWN_X, SPAWN_Y } from "../../src/game/constants.js";

const env = (duck, ball) => ({ getDuckPose: () => duck, getBallPos: () => ball });
const SPOT = env([-0.6, 0, 0], [0, 0.2]); // duck at spawn, ball off-centre to the left

test("aim turns the shooting line toward that corner", () => {
  const goal = observe(SPOT), left = observe(SPOT, "left_corner"), right = observe(SPOT, "right_corner");
  assert.equal(goal.aim, "goal");
  assert.equal(left.aim, "left_corner");
  // y + is left facing the goal: a left corner aim turns the heading left (+).
  assert.ok(left.shotHeading > goal.shotHeading);
  assert.ok(right.shotHeading < goal.shotHeading);
  assert.ok(left.facingErr > goal.facingErr);
});

test("named targets", () => {
  const { targets } = observe(SPOT);
  assert.deepEqual(targets.ball, [0, 0.2]);
  assert.deepEqual(targets.goal, GOAL_CENTER);
  assert.deepEqual(targets.spawn, [SPAWN_X, SPAWN_Y]);
});

test("describe(obs) is unchanged for Jev", () => {
  // Snapshots taken from describe() before the full view was added.
  const cases = [
    [SPOT, {
      ball: "0.63 m away; 0.60 m ahead, 0.20 m to the left",
      goal: "1.80 m away",
      facing_goal: "yes: a kick now would travel toward the goal",
      ball_in_goal: false,
    }],
    [env([0.3, 0.1, 0.2], [0.39, 0.06]), {
      ball: "0.10 m away; in kicking range of the right foot",
      goal: "0.91 m away",
      facing_goal: "no: a kick now would miss by 15° to the left",
      ball_in_goal: false,
    }],
    [env([1.0, 0.5, 2.5], [0.5, -0.4]), {
      ball: "1.03 m away; behind the duck",
      goal: "0.54 m away",
      facing_goal: "no: a kick now would miss by 118° to the left",
      ball_in_goal: false,
    }],
  ];
  for (const [e, expected] of cases) assert.deepEqual(describe(observe(e)), expected);
});

test("describe(obs, { full: true }) adds the field geometry", () => {
  const obs = observe(SPOT);
  const full = describe(obs, { full: true });
  assert.deepEqual(Object.fromEntries(Object.keys(describe(obs)).map((k) => [k, full[k]])), describe(obs));
  assert.equal(full.ball_to_walls, "1.30 m from the left wall");
  assert.equal(full.room_behind_ball, "1.52 m along the shooting line");
  assert.equal(full.duck_vs_shooting_line, "0.56 m behind the ball, 0.29 m to the right of the line");
  assert.equal(full.duck_to_walls, "0.90 m from the back wall");
});
