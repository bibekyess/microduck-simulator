// The agent loop. Each step:
//   1. observe   duck / ball / goal geometry      (observe.js)
//   2. gate      tools whose precondition holds   (tools.js)
//   3. decide    System One picks one of them     (system-one.js)
//   4. act       run that tool to completion      (tools.js)
//   5. record    push the step to the store       (AgentPanel renders it)
// until the ball is in the net, the step budget runs out, or Stop.
// A goal watcher ends the run the moment the ball crosses the line, even
// mid-tool; it and Pause / Stop reach into running tools through
// run-control.js.
import { useGame, gameApi } from "../store.js";
import { observe, describe } from "./observe.js";
import { TOOLS } from "./tools.js";
import { decide } from "./system-one.js";
import { isBallInGoal } from "../game/goal.js";
import { checkpoint, endRun, resetControl, setPaused, RunEnded } from "./run-control.js";

export const TASKS = {
  penalty: {
    label: "Penalty kick",
    goal: "Score a goal: kick the ball into the goal net.",
  },
};

const MAX_STEPS = 20;
const HISTORY_LEN = 3; // recent steps sent to System One
const PENALTY_SPOT = [0.7, 0]; // ball start (~0.55 m out, inside kick range); y gets a random offset
const GOAL_WATCH_MS = 50; // ball-crossed-the-line check rate

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setAgent = (patch) => useGame.setState((s) => ({ agent: { ...s.agent, ...patch } }));
const updateStep = (i, patch) => useGame.setState((s) => ({
  agent: { ...s.agent, steps: s.agent.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) },
}));

async function waitFor(cond, timeoutS = 10) {
  const end = performance.now() + timeoutS * 1000;
  while (!cond()) {
    if (performance.now() > end) throw new Error("timed out waiting for the sim");
    await sleep(50);
  }
}

// Reset the duck and put the ball on the penalty spot.
async function setupPenalty(env) {
  env.resetDuck();
  await sleep(100);
  await waitFor(env.isReady);
  env.placeBall(PENALTY_SPOT[0], PENALTY_SPOT[1] + (Math.random() - 0.5) * 0.6);
  await waitFor(() => env.getBallPos() !== null);
  await sleep(500); // let the ball settle
}

async function runAgent(taskId) {
  const env = gameApi.agentEnv;
  const task = TASKS[taskId];
  resetControl();
  setAgent({
    status: "running", paused: false, phase: "observe", steps: [], error: null,
    startedAt: performance.now(), endedAt: null,
  });
  let status = "failed", error = null;
  let acting = null; // { i, t0 } while a tool runs, to close its step on a goal
  const goalWatch = setInterval(() => {
    const ball = env.getBallPos();
    if (ball && isBallInGoal(ball[0], ball[1])) endRun("scored");
  }, GOAL_WATCH_MS);
  try {
    await setupPenalty(env);
    const history = [];
    for (let n = 1; n <= MAX_STEPS; n++) {
      await checkpoint();
      await waitFor(() => env.isReady() && env.getBallPos() !== null);

      setAgent({ phase: "observe" });
      const obs = observe(env);

      const blocked = {};
      for (const [name, tool] of Object.entries(TOOLS)) {
        const reason = tool.blocker(obs);
        if (reason) blocked[name] = reason;
      }
      const available = Object.keys(TOOLS).filter((name) => !blocked[name]);
      const observation = describe(obs);

      await checkpoint();
      setAgent({ phase: "decide" });
      const decision = await decide(
        { goal: task.goal, observation, recent_steps: history.slice(-HISTORY_LEN) },
        Object.fromEntries(available.map((name) => [name, TOOLS[name].description])),
      );

      const i = useGame.getState().agent.steps.length;
      useGame.setState((s) => ({
        agent: { ...s.agent, steps: [...s.agent.steps, { n, observation, available, blocked, ...decision, result: null }] },
      }));
      setAgent({ phase: "act" });
      acting = { i, t0: performance.now() };
      const { ok, text } = await TOOLS[decision.choice].run(env);
      updateStep(i, { ok, result: text, actMs: Math.round(performance.now() - acting.t0) });
      acting = null;
      history.push({ step: n, action: decision.choice, result: text });
    }
  } catch (e) {
    if (e instanceof RunEnded) status = e.reason;
    else { status = "error"; error = String(e.message ?? e); }
    // A goal mid-tool ends that step as the one that scored.
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

export function startAgent(taskId) {
  currentRun = runAgent(taskId);
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

// Back to a clean field: duck respawned, ball cleared, trace emptied.
export function resetField() {
  gameApi.agentEnv.resetDuck();
  setAgent({ status: "idle", steps: [], error: null, startedAt: null, endedAt: null });
}
