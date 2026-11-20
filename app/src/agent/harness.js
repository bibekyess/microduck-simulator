// The agent loop. Each step:
//   1. observe   duck / ball / goal geometry           (observe.js)
//   2. gate      every option of the task's skills     (tasks.js, tools.js)
//   3. decide    the decider cascade (decider.js): Jev picks one option
//                (system-one.js); after a failed Jev step, or when Jev picks
//                think_it_through, the ReAct LLM (react.js) takes control
//                for a scoped recovery and hands back a summary
//   4. act       run that skill to completion          (tools.js)
//   5. record    push the step to the store            (AgentPanel renders it)
// until the task is done, the step budget runs out, the same call keeps
// failing, or Stop. A goal watcher ends the run the moment the task is
// done, even mid-skill; it and Pause / Stop reach into running skills
// through run-control.js.
import { useGame, gameApi } from "../store.js";
import { observe, describe } from "./observe.js";
import { TOOLS } from "./tools.js";
import { decide } from "./system-one.js";
import { recover, chatCompletion, getLlmConfig } from "./react.js";
import { THINK, escalationReason, withThink, isStuck, makeBudget } from "./decider.js";
import { TASKS, waitFor, gateOptions, decideInput } from "./tasks.js";
import { checkpoint, endRun, resetControl, setPaused, RunEnded } from "./run-control.js";
import "./bench.js"; // window.__bench debug helpers

export { TASKS };

const MAX_STEPS = 20; // skill steps per run, both deciders together
const GOAL_WATCH_MS = 50; // task-done check rate

const setAgent = (patch) => useGame.setState((s) => ({ agent: { ...s.agent, ...patch } }));
const pushStep = (step) => {
  const i = useGame.getState().agent.steps.length;
  useGame.setState((s) => ({ agent: { ...s.agent, steps: [...s.agent.steps, step] } }));
  return i;
};
const updateStep = (i, patch) => useGame.setState((s) => ({
  agent: { ...s.agent, steps: s.agent.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) },
}));
const stripDescriptions = (options) => options.map(({ description, ...o }) => o);

// Test hook: window.__agentLlm = async (messages, tools) => ({ message, latencyMs, cost })
// replaces the endpoint (used to drive the cascade without a key).
const llmFor = (cfg) => (typeof window !== "undefined" && window.__agentLlm) || ((m, t) => chatCompletion(cfg, m, t));

// fresh: set the task up anew; otherwise play from the field as it is
// (still set up if there's no ball to kick).
async function runAgent(taskId, fresh) {
  const env = gameApi.agentEnv;
  const task = TASKS[taskId];
  const llmCfg = getLlmConfig();
  const budget = makeBudget({ enabled: llmCfg.enabled });
  resetControl();
  setAgent({
    task: taskId, status: "running", paused: false, phase: "observe", steps: [], error: null,
    startedAt: performance.now(), endedAt: null, llmModel: llmCfg.enabled ? llmCfg.model : null,
  });
  let status = "failed", error = null;
  let acting = null; // { i, t0 } while a skill runs, to close its step on a goal
  let n = 0; // skill steps so far
  const goalWatch = setInterval(() => {
    if (env.getBallPos() && task.done(observe(env))) endRun("scored");
  }, GOAL_WATCH_MS);

  // Run one skill as step n, recorded with `meta` (decider, choice, ...).
  const act = async (obs, observation, options, meta) => {
    n++;
    const i = pushStep({
      n, obs: { duck: obs.duck, ballPos: obs.ballPos }, observation, options: stripDescriptions(options),
      ok: null, result: null, data: null, actMs: null, ...meta,
    });
    if (meta.blocked) {
      const text = `not run: ${meta.blocked}`;
      updateStep(i, { ok: false, result: text, actMs: 0 });
      return { ok: false, text };
    }
    setAgent({ phase: "act" });
    acting = { i, t0: performance.now() };
    const { ok, text, data = null } = await TOOLS[meta.skill].run(env, meta.args);
    updateStep(i, { ok, result: text, data, actMs: Math.round(performance.now() - acting.t0) });
    acting = null;
    return { ok, text };
  };

  // Current field, as both deciders see it.
  const look = () => {
    const obs = observe(env);
    return { obs, options: gateOptions(TOOLS, task.skills, obs) };
  };

  // Scoped LLM recovery; returns the hand-back line for Jev's history.
  const escalate = async (why, history) => {
    budget.spend();
    const escalation = budget.used;
    setAgent({ phase: "decide" });
    const rec = await recover({
      task, tools: TOOLS, why, history, llm: llmFor(llmCfg), maxCalls: budget.calls, checkpoint,
      look: () => {
        const { obs, options } = look();
        return { observation: describe(obs, { full: true }), options, blockerFor: (skill, args) => TOOLS[skill].blocker(obs, args) ?? null };
      },
      act: async (call) => {
        if (n >= MAX_STEPS) return { ok: false, text: "not run: the run is out of steps" };
        const { obs, options } = look();
        // Same call as one of Jev's presets: reuse its label (and title).
        const key = (args) => JSON.stringify(Object.entries(args).sort());
        const preset = options.find((o) => o.skill === call.skill && key(o.args) === key(call.args));
        const r = await act(obs, describe(obs, { full: true }), options, {
          decidedBy: "llm", escalation, why: call.index === 0 ? why : null, thought: call.thought,
          choice: preset?.label ?? call.skill, skill: call.skill, args: call.args, blocked: call.blocked,
          latencyMs: call.latencyMs, cost: call.cost,
        });
        await waitFor(() => env.isReady() && env.getBallPos() !== null);
        return r;
      },
    });
    // The hand-back, as a card of its own.
    pushStep({
      n: `${n}+`, kind: "handback", decidedBy: "llm", escalation, why: rec.calls === 0 ? why : null,
      thought: rec.thought, summary: rec.summary, recovered: rec.recovered, calls: rec.calls, requests: rec.requests,
      cost: rec.cost, ok: rec.recovered, result: rec.summary, options: [], observation: {},
    });
    return { step: n, action: THINK, decided_by: "llm", result: `recovery (${rec.calls} skill call${rec.calls === 1 ? "" : "s"}): ${rec.summary}` };
  };

  try {
    if (fresh || env.getBallPos() === null) await task.setup(env);
    const history = [];
    let why = null; // pending escalation reason
    while (n < MAX_STEPS) {
      await checkpoint();
      await waitFor(() => env.isReady() && env.getBallPos() !== null);
      if (isStuck(useGame.getState().agent.steps)) { status = "stuck"; break; }

      if (why && budget.canEscalate()) {
        try {
          history.push(await escalate(why, history));
        } catch (e) {
          if (e instanceof RunEnded) throw e;
          // Endpoint down / bad key: note it, carry on with Jev alone.
          budget.disable();
          pushStep({ n: `${n}+`, kind: "handback", decidedBy: "llm", why, ok: false, summary: `LLM unavailable: ${e.message ?? e}`, result: `LLM unavailable: ${e.message ?? e}`, options: [], observation: {} });
        }
        why = null;
        continue;
      }
      why = null;

      setAgent({ phase: "observe" });
      const { obs, options: gated } = look();
      const options = withThink(gated, budget.canEscalate());
      const observation = describe(obs);

      await checkpoint();
      setAgent({ phase: "decide" });
      const decision = await decide(...decideInput(task, observation, history, options));
      const chosen = options.find((o) => o.label === decision.choice && !o.blocked);
      if (!chosen) throw new Error(`Jev picked an option not on offer: ${decision.choice}`);

      if (chosen.label === THINK) {
        // Recorded as a decision with no skill; the LLM acts next.
        pushStep({
          n: `${n}+`, kind: "think", obs: { duck: obs.duck, ballPos: obs.ballPos }, observation,
          options: stripDescriptions(options), decidedBy: "jev", ...decision, skill: null, args: {},
          ok: true, result: "handed over to the LLM",
        });
        why = "the fast decider chose think_it_through: none of its preset options fits the situation";
        continue;
      }
      const { ok, text } = await act(obs, observation, options, {
        decidedBy: "jev", ...decision, skill: chosen.skill, args: chosen.args,
      });
      history.push({ step: n, action: chosen.label, decided_by: "jev", result: text });
      const last = useGame.getState().agent.steps.at(-1);
      why = ok ? null : escalationReason(last);
    }
  } catch (e) {
    if (e instanceof RunEnded) status = e.reason;
    else { status = "error"; error = String(e.message ?? e); }
    // A goal mid-skill ends that step as the one that scored.
    if (status === "scored" && acting) {
      updateStep(acting.i, {
        ok: true, result: "GOAL! the ball crossed the goal line",
        actMs: Math.round(performance.now() - acting.t0),
      });
    }
  } finally {
    clearInterval(goalWatch);
    env.stop();
    env.showTarget(null);
    setAgent({ status, error, phase: null, paused: false, endedAt: performance.now() });
  }
}

// ── Controls (AgentPanel buttons) ─────────────────────────────────────
let currentRun = null;

export function startAgent(taskId, fresh = true) {
  currentRun = runAgent(taskId, fresh);
}

export function pauseAgent(paused) {
  setPaused(paused);
  setAgent({ paused });
}

export function stopAgent() {
  endRun("stopped");
}

// Stop the current run (if any), wait for it to wind down, start fresh.
export async function restartAgent(taskId) {
  endRun("stopped");
  await currentRun;
  startAgent(taskId);
}

// Back to the task's start state, trace emptied. START then plays from
// this field instead of setting up again.
export async function resetField(taskId) {
  setAgent({ task: taskId, status: "idle", steps: [], error: null, startedAt: null, endedAt: null });
  await TASKS[taskId].setup(gameApi.agentEnv);
}
