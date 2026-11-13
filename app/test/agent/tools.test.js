// The skill shape the harness and the deciders rely on, and the blockers.
import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../../src/agent/tools.js";
import { observe } from "../../src/agent/observe.js";

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
  assert.deepEqual(Object.keys(TOOLS), ["navigate_to", "approach", "kick"]);
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
  assert.deepEqual(labels, ["navigate_to:behind_ball", "approach:left", "approach:right", "kick:left", "kick:right"]);
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
