// The agent loop. Each step:
//   1. observe   duck / ball / goal geometry           (observe.js)
//   2. gate      every option of the task's skills     (tasks.js, tools.js)
//   3. decide    Jev picks one of the available ones   (system-one.js)
//   4. act       run that skill to completion          (tools.js)
//   5. record    push the step to the store            (AgentPanel renders it)
// until the task is done, the step budget runs out, or Stop.
// A goal watcher ends the run the moment the task is done, even mid-skill;
// it and Pause / Stop reach into running skills through run-control.js.
import { useGame, gameApi } from "../store.js";
import { observe, describe } from "./observe.js";
import { TOOLS } from "./tools.js";
import { decide } from "./system-one.js";
import { TASKS, waitFor, gateOptions, decideInput } from "./tasks.js";
import { checkpoint, endRun, resetControl, setPaused, RunEnded } from "./run-control.js";
import "./bench.js"; // window.__bench debug helpers

export { TASKS };

const MAX_STEPS = 20;
const GOAL_WATCH_MS = 50; // task-done check rate

const setAgent = (patch) => useGame.setState((s) => ({ agent: { ...s.agent, ...patch } }));
const updateStep = (i, patch) => useGame.setState((s) => ({
  agent: { ...s.agent, steps: s.agent.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) },
}));

// fresh: set the task up anew; otherwise play from the field as it is
// (still set up if there's no ball to kick).
async function runAgent(taskId, fresh) {
  const env = gameApi.agentEnv;
  const task = TASKS[taskId];
  resetControl();
  setAgent({
    task: taskId, status: "running", paused: false, phase: "observe", steps: [], error: null,
    startedAt: performance.now(), endedAt: null,
  });
  let status = "failed", error = null;
  let acting = null; // { i, t0 } while a skill runs, to close its step on a goal
  const goalWatch = setInterval(() => {
    if (env.getBallPos() && task.done(observe(env))) endRun("scored");
  }, GOAL_WATCH_MS);
  try {
    if (fresh || env.getBallPos() === null) await task.setup(env);
    const history = [];
    for (let n = 1; n <= MAX_STEPS; n++) {
      await checkpoint();
      await waitFor(() => env.isReady() && env.getBallPos() !== null);

      setAgent({ phase: "observe" });
      const obs = observe(env);
      const options = gateOptions(TOOLS, task.skills, obs);
      const observation = describe(obs);

      await checkpoint();
      setAgent({ phase: "decide" });
      const decision = await decide(...decideInput(task, observation, history, options));
      const chosen = options.find((o) => o.label === decision.choice && !o.blocked);
      if (!chosen) throw new Error(`Jev picked an option not on offer: ${decision.choice}`);

      const i = useGame.getState().agent.steps.length;
      const step = {
        n, obs: { duck: obs.duck, ballPos: obs.ballPos }, observation,
        options: options.map(({ description, ...o }) => o),
        decidedBy: "jev", ...decision, skill: chosen.skill, args: chosen.args,
        ok: null, result: null, data: null, actMs: null,
      };
      useGame.setState((s) => ({ agent: { ...s.agent, steps: [...s.agent.steps, step] } }));
      setAgent({ phase: "act" });
      acting = { i, t0: performance.now() };
      const { ok, text, data = null } = await TOOLS[chosen.skill].run(env, chosen.args);
      updateStep(i, { ok, result: text, data, actMs: Math.round(performance.now() - acting.t0) });
      acting = null;
      history.push({ step: n, action: chosen.label, result: text });
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
