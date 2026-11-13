// Run export / offline replay (src/agent/replay.js) against a small fake
// skill set in the tools.js shape, plus any exported runs dropped into
// test/agent/fixtures/ (replayed against the real skills).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { exportRun, replayRun } from "../../src/agent/replay.js";
import { gateOptions } from "../../src/agent/tasks.js";

const opt = (skill, preset, args) => ({
  label: `${skill}:${preset}`, title: `${skill} ${preset}`, description: `do ${skill} ${preset}`, args,
});
const noop = async () => ({ ok: true, text: "done", data: null });
const TOOLS = {
  navigate_to: {
    label: "Navigate", defaults: { target: "behind_ball", aim: "goal" },
    options: [opt("navigate_to", "behind_ball", { target: "behind_ball" })],
    blocker: () => null, run: noop,
  },
  approach: {
    label: "Approach", defaults: { aim: "goal" },
    options: [opt("approach", "left", { foot: "left" }), opt("approach", "right", { foot: "right" })],
    blocker: (obs) => (obs.ball.dist > 0.5 ? "ball too far" : null), run: noop,
  },
  kick: {
    label: "Kick", defaults: {},
    options: [opt("kick", "left", { foot: "left" }), opt("kick", "right", { foot: "right" })],
    blocker: (obs) => (obs.ball.dist > 0.15 ? "ball out of reach" : null), run: noop,
  },
};

// Picks the last option on offer: navigate, then approach:right, then kick:right.
const lastOption = async (state, options) => ({ choice: Object.keys(options).at(-1), probabilities: {} });

// A run as the harness records it (options as gateOptions returns them).
function makeRun(poses, choices) {
  const steps = poses.map(([duck, ballPos], i) => {
    const obs = { duck, ballPos, ball: { dist: Math.hypot(ballPos[0] - duck[0], ballPos[1] - duck[1]) } };
    const options = gateOptions(TOOLS, Object.keys(TOOLS), obs).map(({ description, ...o }) => o);
    const chosen = options.find((o) => o.label === choices[i]);
    return {
      n: i + 1, obs: { duck, ballPos }, observation: {}, options,
      decidedBy: "jev", choice: chosen.label, skill: chosen.skill, args: chosen.args,
      probabilities: { [chosen.label]: 0.9 }, confidence: 0.9, latencyMs: 300, cost: 0.0001,
      ok: true, result: "done", data: null, actMs: 1000,
    };
  });
  return { version: 1, task: "penalty", status: "scored", startedAt: 0, endedAt: 9000, steps };
}

const RUN = makeRun(
  [[[-0.6, 0, 0], [0.7, 0]], [[0.3, 0.05, 0], [0.7, 0]], [[0.61, 0.05, 0], [0.7, 0]]],
  ["navigate_to:behind_ball", "approach:right", "kick:right"],
);

test("gateOptions merges defaults under each option's args and gates them", () => {
  const [nav, approachLeft, , kickLeft] = RUN.steps[1].options;
  assert.deepEqual(nav.args, { target: "behind_ball", aim: "goal" });
  assert.deepEqual(approachLeft.args, { aim: "goal", foot: "left" });
  assert.equal(approachLeft.blocked, null);
  assert.equal(kickLeft.blocked, "ball out of reach");
});

test("replay rebuilds each step and re-asks decide", async () => {
  const seen = [];
  const decide = async (state, options) => { seen.push({ state, options }); return lastOption(state, options); };
  const rows = await replayRun(RUN, { tools: TOOLS, decide });
  assert.deepEqual(rows.map((r) => r.replayed), ["navigate_to:behind_ball", "approach:right", "kick:right"]);
  assert.ok(rows.every((r) => r.optionsMatch && r.recorded === r.replayed));
  assert.deepEqual(Object.keys(seen[0].options), ["navigate_to:behind_ball"]);
  assert.equal(seen[2].state.recent_steps.length, 2);
  assert.equal(typeof seen[0].state.observation.ball, "string"); // describe() text, as live
});

test("replay flags a step whose options no longer match", async () => {
  const stale = structuredClone(RUN);
  stale.steps[0].options[1].blocked = null; // live run had approach on offer
  const rows = await replayRun(stale, { tools: TOOLS, decide: lastOption });
  assert.deepEqual(rows.map((r) => r.optionsMatch), [false, true, true]);
});

test("exportRun round-trips through JSON", async () => {
  const agent = { status: RUN.status, startedAt: 0, endedAt: 9000, steps: RUN.steps, paused: false, phase: null };
  const run = JSON.parse(exportRun(agent, "penalty"));
  assert.deepEqual(run, RUN);
  const rows = await replayRun(run, { tools: TOOLS, decide: lastOption });
  assert.equal(rows.length, 3);
});

// Exported runs: re-gate against the real skills, decide = the recorded choice.
const FIXTURES = new URL("./fixtures/", import.meta.url);
const files = (() => { try { return readdirSync(FIXTURES).filter((f) => f.endsWith(".json")); } catch { return []; } })();
for (const file of files) {
  test(`fixture ${file} replays with the same options`, async () => {
    const { TOOLS: real } = await import("../../src/agent/tools.js");
    const run = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8"));
    let i = 0;
    const recorded = async () => ({ choice: run.steps[i++].choice, probabilities: {} });
    const rows = await replayRun(run, { tools: real, decide: recorded });
    assert.equal(rows.length, run.steps.length);
    for (const r of rows) assert.ok(r.optionsMatch, `step ${r.n}: options differ from the live run`);
  });
}
