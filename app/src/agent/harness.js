// The agent loop. Each step:
//   1. observe   duck / ball / goal geometry      (observe.js)
//   2. gate      tools whose precondition holds   (tools.js)
//   3. decide    System One picks one of them     (system-one.js)
//   4. act       run that tool to completion      (tools.js)
//   5. record    push the step to the store       (AgentPanel renders it)
// until the ball is in the net, the step budget runs out, or Stop.
import { useGame, gameApi } from "../store.js";
import { observe, describe } from "./observe.js";
import { TOOLS } from "./tools.js";
import { decide } from "./system-one.js";

export const TASKS = {
  penalty: {
    label: "Penalty kick",
    goal: "Score a goal: kick the ball into the goal net.",
  },
};

const MAX_STEPS = 20;
const HISTORY_LEN = 3; // recent steps sent to System One
const PENALTY_SPOT = [0.7, 0]; // ball start (~0.55 m out, inside kick range); y gets a random offset

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

let stopRequested = false;
export function stopAgent() {
  stopRequested = true;
}

export async function runAgent(taskId) {
  const env = gameApi.agentEnv;
  const task = TASKS[taskId];
  stopRequested = false;
  setAgent({ status: "running", phase: "observe", steps: [], error: null });
  try {
    await setupPenalty(env);
    const history = [];
    for (let n = 1; n <= MAX_STEPS; n++) {
      if (stopRequested) return setAgent({ status: "stopped", phase: null });
      await waitFor(env.isReady);

      setAgent({ phase: "observe" });
      const obs = observe(env);
      if (obs.ballInGoal) return setAgent({ status: "scored", phase: null });

      const available = Object.keys(TOOLS).filter((name) => TOOLS[name].available(obs));
      const observation = describe(obs);
      setAgent({ phase: "decide" });
      const decision = await decide(
        { goal: task.goal, observation, recent_steps: history.slice(-HISTORY_LEN) },
        Object.fromEntries(available.map((name) => [name, TOOLS[name].description])),
      );

      const i = useGame.getState().agent.steps.length;
      useGame.setState((s) => ({
        agent: { ...s.agent, steps: [...s.agent.steps, { n, observation, available, ...decision, result: null }] },
      }));
      setAgent({ phase: "act" });
      const result = await TOOLS[decision.choice].run(env);
      updateStep(i, { result });
      history.push({ step: n, action: decision.choice, result });
    }
    await sleep(500);
    setAgent({ status: observe(env).ballInGoal ? "scored" : "failed", phase: null });
  } catch (e) {
    env.stop();
    setAgent({ status: "error", phase: null, error: String(e.message ?? e) });
  }
}
