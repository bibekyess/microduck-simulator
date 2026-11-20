// The decider cascade (decider.js) and the ReAct recovery (react.js),
// driven by a scripted LLM, plus an optional live eval against a real
// model: set LLM_API_KEY (and optionally LLM_BASE_URL, LLM_MODEL) to run
// it; it is skipped otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { escalationReason, withThink, isStuck, makeBudget, THINK } from "../../src/agent/decider.js";
import { recover, validateArgs, toolDefs, chatCompletion } from "../../src/agent/react.js";
import { TOOLS } from "../../src/agent/tools.js";
import { TASKS, gateOptions } from "../../src/agent/tasks.js";
import { observe, describe } from "../../src/agent/observe.js";

const task = TASKS.penalty;

// ── decider.js ─────────────────────────────────────────────────────────

test("escalates only after a failed Jev step", () => {
  const step = (decidedBy, ok) => ({ decidedBy, ok, skill: "kick", args: { foot: "left" }, result: "the ball stopped wide right" });
  assert.match(escalationReason(step("jev", false)), /kick foot=left -> the ball stopped wide right/);
  assert.equal(escalationReason(step("jev", true)), null);
  assert.equal(escalationReason(step("llm", false)), null);
  assert.equal(escalationReason(null), null);
});

test("think_it_through is offered only while the budget lasts", () => {
  const b = makeBudget({ escalations: 2 });
  assert.equal(withThink([], b.canEscalate()).at(-1).label, THINK);
  b.spend(); b.spend();
  assert.equal(withThink([], b.canEscalate()).length, 0);
  assert.equal(makeBudget({ enabled: false }).canEscalate(), false);
});

test("the same failing call three times in a row is stuck", () => {
  const f = { skill: "approach", args: { foot: "left" }, ok: false };
  assert.ok(isStuck([f, f, f]));
  assert.ok(!isStuck([f, f]));
  assert.ok(!isStuck([f, { ...f, args: { foot: "right" } }, f]));
  assert.ok(!isStuck([f, f, { ...f, ok: true }]));
});

// ── react.js ───────────────────────────────────────────────────────────

test("args are checked against the skill's params", () => {
  assert.equal(validateArgs(TOOLS.kick.params, { foot: "left" }), null);
  assert.match(validateArgs(TOOLS.kick.params, {}), /missing required argument "foot"/);
  assert.match(validateArgs(TOOLS.kick.params, { foot: "middle" }), /foot must be one of left, right/);
  assert.match(validateArgs(TOOLS.navigate_to.params, { where: "x" }), /unknown argument "where"/);
});

test("tool definitions: one per task skill, plus recovered", () => {
  const names = toolDefs(TOOLS, task.skills).map((t) => t.function.name);
  assert.deepEqual(names, [...task.skills, "recovered"]);
});

// Scripted LLM: each entry is a tool call [name, args] or a string (a text
// reply). Records the messages it was sent.
function scripted(script) {
  const seen = [];
  let i = 0;
  const llm = async (messages) => {
    seen.push(structuredClone(messages));
    const s = script[i++];
    if (typeof s === "string") return { message: { content: s }, latencyMs: 5, cost: 0.001 };
    const calls = (Array.isArray(s[0]) ? s : [s]).map(([name, args], k) => ({ id: `c${i}_${k}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
    return { message: { content: `thinking about ${calls[0].function.name}`, tool_calls: calls }, latencyMs: 5, cost: 0.001 };
  };
  return { llm, seen };
}

// A field where the duck stands at the spawn and the ball is on the spot.
function field(blocked = {}) {
  const obs = observe({ getDuckPose: () => [-0.6, 0, 0], getBallPos: () => [0.7, 0.1] });
  return () => ({
    observation: describe(obs, { full: true }),
    options: gateOptions(TOOLS, task.skills, obs),
    blockerFor: (skill) => blocked[skill] ?? null,
  });
}

function actLog(results = {}) {
  const calls = [];
  const act = async (call) => {
    calls.push(call);
    if (call.blocked) return { ok: false, text: `not run: ${call.blocked}` };
    return results[call.skill] ?? { ok: true, text: `${call.skill} done` };
  };
  return { act, calls };
}

test("recovery: one skill, then hands back with a summary", async () => {
  const { llm, seen } = scripted([["navigate_to", { target: "behind_ball" }], ["recovered", { summary: "back behind the ball" }]]);
  const { act, calls } = actLog();
  const rec = await recover({ task, tools: TOOLS, why: "the last skill failed", history: [], look: field(), act, llm, maxCalls: 3 });
  assert.deepEqual(rec, { summary: "back behind the ball", recovered: true, calls: 1, requests: 2, cost: 0.002, thought: "thinking about recovered" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { target: "behind_ball", aim: "goal" }, "defaults merged under the LLM's args");
  assert.equal(calls[0].thought, "thinking about navigate_to");
  // The first message says why it was called and what it can do.
  assert.match(seen[0][1].content, /Why you were called: the last skill failed/);
  assert.match(seen[0][1].content, /approach\(aim=goal, foot=left\): blocked: /);
  // The tool reply carries the result and the fresh state.
  const reply = seen[1].at(-1);
  assert.equal(reply.role, "tool");
  assert.match(reply.content, /^succeeded: navigate_to done/);
  assert.match(reply.content, /Skill calls left in this recovery: 2/);
});

test("recovery: a blocked call returns the reason and costs no skill call", async () => {
  const { llm, seen } = scripted([["kick", { foot: "left" }], ["navigate_to", {}], ["recovered", { summary: "ok" }]]);
  const { act, calls } = actLog();
  const rec = await recover({ task, tools: TOOLS, why: "x", history: [], look: field({ kick: "ball not in front of the left foot" }), act, llm, maxCalls: 3 });
  assert.equal(rec.calls, 1);
  assert.equal(calls[0].blocked, "ball not in front of the left foot");
  assert.match(seen[1].at(-1).content, /^not run: ball not in front of the left foot\n/);
});

test("recovery: bad args and unknown skills are error observations, not crashes", async () => {
  const { llm, seen } = scripted([["kick", { foot: "middle" }], ["dance", {}], ["recovered", { summary: "gave up" }]]);
  const { act, calls } = actLog();
  const rec = await recover({ task, tools: TOOLS, why: "x", history: [], look: field(), act, llm, maxCalls: 3 });
  assert.equal(calls.length, 0);
  assert.equal(rec.recovered, true);
  assert.match(seen[1].at(-1).content, /error: foot must be one of left, right/);
  assert.match(seen[2].at(-1).content, /error: no skill "dance"/);
});

test("recovery: only the first of several tool calls runs, all get replies", async () => {
  const { llm, seen } = scripted([[["navigate_to", {}], ["approach", { foot: "left" }]], ["recovered", { summary: "ok" }]]);
  const { act, calls } = actLog();
  await recover({ task, tools: TOOLS, why: "x", history: [], look: field(), act, llm, maxCalls: 3 });
  assert.equal(calls.length, 1);
  const replies = seen[1].filter((m) => m.role === "tool");
  assert.equal(replies.length, 2);
  assert.match(replies[1].content, /one skill at a time/);
});

test("recovery: the skill-call budget is enforced", async () => {
  const nav = ["navigate_to", {}];
  const { llm } = scripted([nav, nav, nav, nav, nav, nav, nav, nav]);
  const { act, calls } = actLog();
  const rec = await recover({ task, tools: TOOLS, why: "x", history: [], look: field(), act, llm, maxCalls: 2 });
  assert.equal(calls.length, 2);
  assert.equal(rec.recovered, false);
  assert.equal(rec.requests, 5, "maxCalls + 3 requests at most");
  assert.match(rec.summary, /ran out of its budget/);
});

test("recovery: a text reply ends the recovery as its hand-back", async () => {
  const { llm } = scripted(["The duck is fine, carry on."]);
  const rec = await recover({ task, tools: TOOLS, why: "x", history: [], look: field(), act: actLog().act, llm, maxCalls: 3 });
  assert.deepEqual([rec.recovered, rec.summary, rec.calls], [false, "The duck is fine, carry on.", 0]);
});

// ── live eval (needs a key) ────────────────────────────────────────────
// Replays the fixture's failed kick (step 3: ball stopped short) through a
// real model with a text-only env: each skill returns what the live run
// recorded for it next. A sensible recovery goes behind the ball again
// and hands back within budget.
const live = process.env.LLM_API_KEY ? test : test.skip;
live("live: the LLM recovers from the fixture's missed kick", async () => {
  const run = JSON.parse(readFileSync(new URL("./fixtures/penalty-scored.json", import.meta.url)));
  const failed = run.steps.find((s) => s.ok === false);
  const after = run.steps.slice(run.steps.indexOf(failed) + 1);
  let pose = after[0].obs;
  const look = () => {
    const obs = observe({ getDuckPose: () => pose.duck, getBallPos: () => pose.ballPos });
    return { observation: describe(obs, { full: true }), options: gateOptions(TOOLS, task.skills, obs), blockerFor: (s, a) => TOOLS[s].blocker(obs, a) ?? null };
  };
  const ran = [];
  const act = async (call) => {
    ran.push(call.skill);
    if (call.blocked) return { ok: false, text: `not run: ${call.blocked}` };
    const next = after.find((s) => s.skill === call.skill && !ran.includes(`done:${s.n}`)) ?? null;
    if (!next) return { ok: false, text: `${call.skill} could not be simulated offline` };
    ran.push(`done:${next.n}`);
    pose = run.steps[run.steps.indexOf(next) + 1]?.obs ?? pose;
    return { ok: next.ok, text: next.result };
  };
  const cfg = { baseUrl: process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1", model: process.env.LLM_MODEL ?? "anthropic/claude-haiku-5.5", apiKey: process.env.LLM_API_KEY, headers: "" };
  const history = run.steps.slice(0, run.steps.indexOf(failed) + 1).map((s) => ({ step: s.n, action: s.choice, decided_by: "jev", result: s.result }));
  const rec = await recover({
    task, tools: TOOLS, history, look, act, maxCalls: 3,
    why: `the last skill failed: kick foot=left -> ${failed.result}`,
    llm: (m, t) => chatCompletion(cfg, m, t),
  });
  console.log(`live recovery: ${JSON.stringify({ ...rec, ran: ran.filter((r) => !r.startsWith("done:")) })}`);
  assert.equal(ran[0], "navigate_to", "a missed kick should be followed by getting behind the ball again");
  assert.ok(rec.calls <= 3);
});
