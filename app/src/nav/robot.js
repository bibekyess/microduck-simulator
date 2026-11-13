// Robot model for the navigation stack: what the walking policy can do,
// fitted in the sim with window.__bench.measure() (agent/bench.js) on
// 2026-11-13; raw rows in docs/agent-nav-react-plan.md.
//
// The duck is a car that cannot reverse or turn in place: it reaches a
// heading only by walking a curve, and the command -> motion maps are far
// from identity (a 0.25 m/s command walks at ~0.16 m/s).
export const ROBOT = {
  vMinCmd: 0.22, // m/s command below which the policy doesn't step
  vCurve: 0.3, // m/s command on curves (0.18 m/s actual)
  vMaxCmd: 0.4, // m/s command on straights (0.21 m/s actual; 0.5 walked at 0.25 and stayed up)
  wMax: 2.0, // rad/s command limit (the policy takes more than the keyboard's 1.0 and stays up)
  turnPerCmd: 0.45, // actual rad/s per commanded rad/s (0.85 / 2.0 at vCurve)
  turnRadius: 0.18, // m, measured at vCurve and wMax
  planRadius: 0.235, // m, 1.3 x turnRadius: what the planner uses, so arcs are trackable
  lag: 0.3, // s, first-order response of speed and turn rate to a command
  radius: 0.08, // m, footprint for collision checks
};

// Actual walking speed for a forward command (fit: 0.25 -> 0.16, 0.35 ->
// 0.19, 0.5 -> 0.245 m/s). Below vMinCmd the policy stands still.
export const actualSpeed = (vx) => (vx < ROBOT.vMinCmd ? 0 : 0.09 + 0.3 * vx);
