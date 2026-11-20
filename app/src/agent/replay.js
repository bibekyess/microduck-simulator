// Run export and offline replay.
//
// exportRun(agent, taskId) -> the store's agent run as a JSON string (the
// "Export run" button saves it). Steps keep the raw duck / ball poses, so
//
// replayRun(run, { tools, decide }) can rebuild each step's observation
// through observe() / describe() with no sim, re-gate the options with
// `tools` and ask `decide` (system-one.js signature) again. Per step:
// { n, recorded, replayed, optionsMatch } for each of Jev's steps, where
// optionsMatch says the replay offered the same options as the live run.
// LLM recovery steps are not re-run (react.test.js evaluates those).
import { observe, describe } from "./observe.js";
import { TASKS, gateOptions, decideInput } from "./tasks.js";
import { THINK, withThink } from "./decider.js";

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
    // Only Jev's decisions are re-asked; LLM steps and hand-backs go into
    // the history exactly as they happened live.
    if (step.kind === "handback") {
      history.push({ step: parseInt(step.n, 10), action: THINK, decided_by: "llm", result: `recovery (${step.calls ?? 0} skill call${step.calls === 1 ? "" : "s"}): ${step.summary}` });
      continue;
    }
    if (step.decidedBy === "llm") continue;
    const { duck, ballPos } = step.obs;
    const obs = observe({ getDuckPose: () => duck, getBallPos: () => ballPos });
    const offeredThink = step.options.some((o) => o.label === THINK);
    const options = withThink(gateOptions(tools, task.skills, obs), offeredThink);
    const { choice } = await decide(...decideInput(task, describe(obs), history, options));
    rows.push({ n: step.n, recorded: step.choice, replayed: choice, optionsMatch: available(options) === available(step.options) });
    // Jev's history is what happened live, not what the replay would have done.
    if (step.kind !== "think") history.push({ step: step.n, action: step.choice, decided_by: "jev", result: step.result });
  }
  return rows;
}
