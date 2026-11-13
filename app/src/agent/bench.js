// Debug-only helpers for the agent, on window.__bench in the browser:
//
//   __bench.measure(0.25, 1.0)   drive one command for a few seconds and
//                                report actual speed, turn rate, radius, lag
//   __bench.run()                go_behind_ball on the benchmark layouts
//                                (docs/agent-nav-react-plan.md), rows in
//                                __bench.rows as they finish
//
// Open http://localhost:5173/?boot=1 first. Teleports the duck through
// window.rl, so this is for measurements, not play.
import { TOOLS } from "./tools.js";
import { observe } from "./observe.js";
import { gameApi } from "../store.js";

const SPAWN = [-0.6, 0, 0];
export const CASES = [
  { name: "penalty spot", ball: [0.7, 0.1], duck: SPAWN },
  { name: "goal line", ball: [1.12, 0.15], duck: SPAWN },
  { name: "near post", ball: [1.05, -0.22], duck: [0.85, 0.05, 0] },
  { name: "duck in front", ball: [0.5, 0.0], duck: [0.9, 0.0, Math.PI] },
  { name: "beside, facing away", ball: [0.2, 0.3], duck: [0.2, -0.1, -Math.PI / 2] },
  { name: "goal-side, offset", ball: [0.0, -0.4], duck: [0.5, -0.2, Math.PI / 2] },
  { name: "side wall", ball: [0.3, 1.25], duck: SPAWN },
  { name: "far corner", ball: [-1.2, -1.2], duck: SPAWN },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f) => { for (let i = 0; i < 400 && !f(); i++) await sleep(50); };
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

async function placeDuck(x, y, yaw) {
  const { data, model, mujoco } = window.rl;
  const q = data.qpos;
  q[0] = x; q[1] = y; q[2] = 0.12;
  q[3] = Math.cos(yaw / 2); q[4] = 0; q[5] = 0; q[6] = Math.sin(yaw / 2);
  for (let i = 0; i < 6; i++) data.qvel[i] = 0;
  mujoco.mj_forward(model, data);
  await sleep(1500);
}

async function freshDuck(env) {
  env.resetDuck();
  await sleep(200);
  await waitFor(env.isReady);
}

export async function run(names) {
  const env = gameApi.agentEnv;
  const rows = (window.__bench.rows = []);
  for (const c of CASES) {
    if (names && !names.includes(c.name)) continue;
    await freshDuck(env);
    await placeDuck(...c.duck);
    env.placeBall(...c.ball);
    await sleep(300);
    await waitFor(() => env.getBallPos());
    await sleep(600);
    const b0 = env.getBallPos(), t0 = performance.now();
    const res = await TOOLS.go_behind_ball.run(env);
    const b1 = env.getBallPos() ?? b0, o = observe(env);
    rows.push(`${c.name}: ${res.ok ? "OK" : "FAIL"} ${((performance.now() - t0) / 1000).toFixed(1)}s, ${res.text}, ` +
      `ball pushed ${Math.hypot(b1[0] - b0[0], b1[1] - b0[1]).toFixed(2)} m, facing err ${Math.round(o.facingErr * 57.3)}°`);
  }
  window.__bench.done = true;
  return rows;
}

// Hold one (vx, wz) command and log the pose at 50 Hz. Steady state is
// taken over the second half; lag is the time to reach half the steady
// speed.
export async function measure(vx, wz, seconds = 4) {
  const env = gameApi.agentEnv;
  await freshDuck(env);
  const log = [];
  const t0 = performance.now();
  env.setCommand(vx, wz);
  while (performance.now() - t0 < seconds * 1000) {
    log.push({ t: (performance.now() - t0) / 1000, pose: env.getDuckPose() });
    await sleep(20);
  }
  env.stop();
  const speedAt = (i, k = 10) => { // mean speed over the k samples before i
    const a = log[i - k], b = log[i];
    return Math.hypot(b.pose[0] - a.pose[0], b.pose[1] - a.pose[1]) / (b.t - a.t);
  };
  const half = Math.floor(log.length / 2), last = log.length - 1;
  let dist = 0, yaw = 0;
  for (let i = half + 1; i <= last; i++) {
    dist += Math.hypot(log[i].pose[0] - log[i - 1].pose[0], log[i].pose[1] - log[i - 1].pose[1]);
    yaw += wrapPi(log[i].pose[2] - log[i - 1].pose[2]);
  }
  const dt = log[last].t - log[half].t;
  const speed = dist / dt, turnRate = yaw / dt;
  let lag = null;
  for (let i = 10; i < log.length; i++) if (speedAt(i) > speed / 2) { lag = log[i].t; break; }
  return { vx, wz, speed: +speed.toFixed(3), turnRate: +turnRate.toFixed(3), radius: turnRate ? +Math.abs(speed / turnRate).toFixed(3) : null, lag };
}

if (typeof window !== "undefined") window.__bench = { run, measure, CASES, rows: [], done: false };
