// Run export and offline replay.
//
// exportRun(agent, taskId) -> the store's agent run as a JSON string (the
// "Export run" button saves it). Steps keep the raw duck / ball poses, so
//
// replayRun(run, { tools, decide }) can rebuild each step's observation
// through observe() / describe() with no sim, re-gate the options with
// `tools` and ask `decide` (system-one.js signature) again. Per step:
// { n, recorded, replayed, optionsMatch }, where optionsMatch says the
// replay offered the same options as the live run.
import { observe, describe } from "./observe.js";
import { TASKS, gateOptions, decideInput } from "./tasks.js";

export function exportRun(agent, taskId) {
  const { status, startedAt, endedAt, steps } = agent;
  return JSON.stringify({ version: 1, task: taskId, status, startedAt, endedAt, steps }, null, 2);
}

const available = (options) => options.filter((o) => !o.blocked).map((o) => o.label).join();

export async function replayRun(run, { tools, decide }) {
  const task = TASKS[run.task];
  const history = [];
  const rows = [];
  for (const step of run.steps) {
    const { duck, ballPos } = step.obs;
    const obs = observe({ getDuckPose: () => duck, getBallPos: () => ballPos });
    const options = gateOptions(tools, task.skills, obs);
    const { choice } = await decide(...decideInput(task, describe(obs), history, options));
    rows.push({ n: step.n, recorded: step.choice, replayed: choice, optionsMatch: available(options) === available(step.options) });
    // Jev's history is what happened live, not what the replay would have done.
    history.push({ step: step.n, action: step.choice, result: step.result });
  }
  return rows;
}
