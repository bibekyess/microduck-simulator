// The decider cascade's rules (docs/agent-nav-react-plan.md, Phase 3b).
// Jev (system-one.js) decides every step by default; the ReAct LLM
// (react.js) takes over for a scoped recovery when either
//   1. the last skill Jev chose failed, or
//   2. Jev picks the extra THINK option ("none of these fits").
// Each recovery may run up to CALLS_PER_ESCALATION skills, each run at most
// ESCALATIONS_PER_RUN of them. Out of budget, Jev carries on alone. The same
// skill failing the same way STUCK_REPEATS times in a row ends the run.
//
// Pure functions of the step records, so replay.js and the tests use them
// as they are.

export const ESCALATIONS_PER_RUN = 2;
export const CALLS_PER_ESCALATION = 3;
export const STUCK_REPEATS = 3;

export const THINK = "think_it_through";
export const THINK_OPTION = {
  label: THINK,
  title: "Think it through",
  description: "None of the other actions fits the situation: hand over to a slower planner that reasons about it and can use non-default arguments.",
  skill: null,
  args: {},
  blocked: null,
};

// Why the LLM should take over before Jev's next decision, or null.
// Only Jev's own failures count: a failure inside a recovery is the LLM's
// to handle while it has control.
export function escalationReason(lastStep) {
  if (!lastStep || lastStep.decidedBy !== "jev" || lastStep.ok !== false || !lastStep.skill) return null;
  const call = [lastStep.skill, ...Object.entries(lastStep.args ?? {}).map(([k, v]) => `${k}=${v}`)].join(" ");
  return `the last skill failed: ${call} -> ${lastStep.result}`;
}

// Jev's options for this step: the gated skill options plus THINK while
// an escalation is still possible.
export function withThink(options, canEscalate) {
  return canEscalate ? [...options, THINK_OPTION] : options;
}

// True when the last STUCK_REPEATS skill steps were the same call and all
// failed: retrying it again won't help.
export function isStuck(steps) {
  const runs = steps.filter((s) => s.skill && s.ok !== null);
  if (runs.length < STUCK_REPEATS) return false;
  const last = runs.slice(-STUCK_REPEATS);
  const key = (s) => `${s.skill} ${JSON.stringify(s.args ?? {})}`;
  return last.every((s) => s.ok === false && key(s) === key(last[0]));
}

// Per-run budget.
export function makeBudget({ escalations = ESCALATIONS_PER_RUN, calls = CALLS_PER_ESCALATION, enabled = true } = {}) {
  let used = 0;
  return {
    calls,
    get used() { return used; },
    canEscalate: () => enabled && used < escalations,
    spend: () => { used++; },
    disable: () => { enabled = false; },
  };
}
