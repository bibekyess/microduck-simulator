// The skill shape the harness and the deciders rely on, and the blockers.
import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../../src/agent/tools.js";
import { observe } from "../../src/agent/observe.js";
import { nudgeHeading, hasRunUpRoom, nudgeWorld } from "../../src/agent/field.js";

const env = (duck, ball) => ({ getDuckPose: () => duck, getBallPos: () => ball });

// Every arg is one of its param's enum values, and required ones are there.
function assertFits(params, args, where) {
  for (const [k, v] of Object.entries(args)) {
    assert.ok(params.properties[k], `${where}: unknown arg ${k}`);
    assert.ok(params.properties[k].enum.includes(v), `${where}: ${k}=${v} not allowed`);
  }
  for (const k of params.required ?? []) assert.ok(k in args, `${where}: missing ${k}`);
}

test("every skill has the full shape", () => {
  assert.deepEqual(Object.keys(TOOLS), ["navigate_to", "approach", "kick", "nudge_ball"]);
  for (const [name, tool] of Object.entries(TOOLS)) {
    for (const k of ["label", "description"]) assert.equal(typeof tool[k], "string", `${name}.${k}`);
    for (const k of ["blocker", "run"]) assert.equal(typeof tool[k], "function", `${name}.${k}`);
    assert.equal(tool.params.type, "object");
    assert.ok(tool.options.length > 0);
    // Defaults alone fit, minus the required args the options supply.
    for (const [k, v] of Object.entries(tool.defaults)) assert.ok(tool.params.properties[k].enum.includes(v), `${name} default ${k}`);
    for (const opt of tool.options) {
      assert.match(opt.label, new RegExp(`^${name}:[a-z_]+$`));
      assert.equal(typeof opt.title, "string");
      assert.equal(typeof opt.description, "string");
      assertFits(tool.params, { ...tool.defaults, ...opt.args }, opt.label);
    }
  }
  const labels = Object.values(TOOLS).flatMap((t) => t.options.map((o) => o.label));
  assert.deepEqual(labels, ["navigate_to:behind_ball", "approach:left", "approach:right", "kick:left", "kick:right", "nudge_ball:away_from_wall"]);
});

test("navigate_to refuses unknown targets and aims without throwing", async () => {
  const nav = TOOLS.navigate_to;
  const res = await nav.run(env([0, 0, 0], [0.5, 0]), { ...nav.defaults, target: "moon" });
  assert.equal(res.ok, false);
  assert.match(res.text, /unknown target/);
  assert.deepEqual(res.data, {});
  const bad = await nav.run(env([0, 0, 0], [0.5, 0]), { ...nav.defaults, aim: "crossbar" });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /unknown aim/);
});

test("blockers", () => {
  const block = (skill, foot, duck, ball) => TOOLS[skill].blocker(observe(env(duck, ball)), { ...TOOLS[skill].defaults, foot });
  // Ball 9 cm ahead, 5 cm to the left: kickable with the left foot only.
  assert.equal(block("kick", "left", [0, 0, 0], [0.09, 0.05]), null);
  assert.equal(block("kick", "right", [0, 0, 0], [0.09, 0.05]), "ball not in front of the right foot");
  // Ball out of range.
  assert.equal(block("kick", "left", [0, 0, 0], [0.5, 0]), "ball not in front of the left foot");
  // Run-up: 0.5 m behind the ball on the line is fine, at the ball is not.
  assert.equal(block("approach", "left", [-0.5, 0, 0], [0, 0]), null);
  assert.equal(block("approach", "left", [0, 0, 0], [0.1, 0]), "not behind the ball");
  assert.equal(block("approach", "left", [-1.0, 0, 0], [0, 0]), "too far behind the ball");
  assert.equal(block("approach", "left", [-0.5, 0.3, 0], [0, 0]), "off the shooting line");
  assert.equal(block("approach", "left", [-0.5, 0, Math.PI], [0, 0]), "not facing the goal");
  assert.equal(TOOLS.navigate_to.blocker(observe(env([0, 0, 0], [0.5, 0])), TOOLS.navigate_to.defaults), null);
});

test("nudge: offered only when the ball has no room for a run-up", () => {
  const at = (ball) => observe({ getDuckPose: () => [-0.6, 0, 0], getBallPos: () => ball });
  const open = at([0.7, 0.1]);
  assert.equal(TOOLS.navigate_to.blocker(open, TOOLS.navigate_to.defaults), null);
  assert.match(TOOLS.nudge_ball.blocker(open, TOOLS.nudge_ball.defaults), /room for a normal run-up/);
  for (const ball of [[0.3, 1.25], [-1.2, -1.2], [1.2, 1.25], [-1.25, 0.4]]) {
    const obs = at(ball);
    assert.match(TOOLS.navigate_to.blocker(obs, TOOLS.navigate_to.defaults), /no room behind the ball .* nudge it off first/, `${ball}`);
    assert.equal(TOOLS.navigate_to.blocker(obs, { target: "spawn" }), null);
    assert.equal(TOOLS.nudge_ball.blocker(obs, TOOLS.nudge_ball.defaults), null, `${ball}`);
  }
});

test("nudge heading: staging free, most kick lengths leave room for a run-up", () => {
  for (const ball of [[0.3, 1.25], [-1.2, -1.2], [1.2, 1.25], [-1.25, 0.4], [0.9, -1.3]]) {
    const obs = observe({ getDuckPose: () => [-0.6, 0, 0], getBallPos: () => ball });
    const n = nudgeHeading(obs);
    assert.ok(n, `${ball}: no heading`);
    const stage = [ball[0] - n.back * Math.cos(n.heading), ball[1] - n.back * Math.sin(n.heading)];
    assert.ok(nudgeWorld(obs).isFree(stage), `${ball}: staging blocked`);
    // The one kick strength carries the ball 0.4-1.7 m: most of that range
    // must land with room for the normal play.
    const roomy = [0.5, 1.0, 1.5, 1.8].filter((r) => {
      const to = [ball[0] + r * Math.cos(n.heading), ball[1] + r * Math.sin(n.heading)];
      return hasRunUpRoom(observe({ getDuckPose: () => [-0.6, 0, 0], getBallPos: () => to }));
    });
    assert.ok(roomy.length >= 3, `${ball}: room after only ${roomy.join(", ")} m kicks`);
  }
});
