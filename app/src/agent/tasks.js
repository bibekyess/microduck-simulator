// Tasks the agent can be given. Each one is:
//   label    task name for the UI
//   goal     what Jev reads as the goal of the run
//   setup    async (env) => puts the field in the task's start state
//   done     (obs) => true once the task is achieved (the harness's goal
//            watcher and step loop check it)
//   skills   which TOOLS entries the task may use
// A new scenario is a new entry here, not a harness change.
//
// Also the per-step bits the harness and replay.js share, so an offline
// replay offers Jev exactly what the live run did.

const PENALTY_SPOT = [0.7, 0]; // ball start (~0.55 m out, inside kick range); y gets a random offset

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond, timeoutS = 10) {
  const end = performance.now() + timeoutS * 1000;
  while (!cond()) {
    if (performance.now() > end) throw new Error("timed out waiting for the sim");
    await sleep(50);
  }
}

export const TASKS = {
  penalty: {
    label: "Penalty kick",
    goal: "Score a goal: kick the ball into the goal net.",
    // Duck respawned, ball on the penalty spot.
    setup: async (env) => {
      env.resetDuck();
      await sleep(100);
      await waitFor(env.isReady);
      env.placeBall(PENALTY_SPOT[0], PENALTY_SPOT[1] + (Math.random() - 0.5) * 0.6);
      await waitFor(() => env.getBallPos() !== null);
      await sleep(500); // let the ball settle
    },
    done: (obs) => obs.ballInGoal,
    skills: ["navigate_to", "approach", "kick"],
  },
};

export const HISTORY_LEN = 3; // recent steps sent to Jev

// Every option of every skill the task allows, gated against obs:
// [{ label, title, description, skill, args, blocked: reason | null }].
// args are the skill's defaults overlaid with the option's preset.
export function gateOptions(tools, skills, obs) {
  return skills.filter((skill) => tools[skill]).flatMap((skill) => {
    const tool = tools[skill];
    return tool.options.map((o) => {
      const args = { ...tool.defaults, ...o.args };
      return { label: o.label, title: o.title, description: o.description, skill, args, blocked: tool.blocker(obs, args) ?? null };
    });
  });
}

// The two arguments of decide() (system-one.js) for one step.
export function decideInput(task, observation, history, options) {
  return [
    { goal: task.goal, observation, recent_steps: history.slice(-HISTORY_LEN) },
    Object.fromEntries(options.filter((o) => !o.blocked).map((o) => [o.label, o.description])),
  ];
}
