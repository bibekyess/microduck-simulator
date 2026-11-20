# Plan: navigation stack + Jev / ReAct decider cascade

Status (2026-11-20): **Phases 0-4 done** (nav stack in
`app/src/nav/`, `navigate_to` on it, offline test bed, browser benchmark
below; pivot-aware planner that cannot be trapped by corners or walls;
tasks as objects, skills with params / defaults / options, `aim`, run
export and offline replay; the Jev -> ReAct LLM cascade, verified with
both deciders mocked; a live-model eval is waiting on an API key;
`nudge_ball` for balls against walls and in corners). Next: runs with
the real Jev and a real LLM, exported as fixtures. Supersedes the "Ideas for next time" in
`agent-go-behind-ball.md`. Amended 2026-11-13 after review (Decisions
5-10): via-points before Hybrid A*, scoped LLM recovery, fewer escalation
triggers, run export, `aim` pulled forward, tasks as objects.

## Why

`go_behind_ball` is a hand-tuned waypoint script (side spot -> far spot ->
line-up) built for one layout. It is slow (it loops back to a fixed far
point even when the duck is already behind the ball, walks everything at
the minimum speed, and stops between phases) and every new layout needs a
new special case. The decision layer (Jev) can only pick a tool name: no
reasoning, no arguments, no reflection on failures.

Goal: a general structure that production robots use and that extends to
new scenarios (other targets, more obstacles, other tasks) by adding
skills, not by rewriting control code.

## Architecture

Two halves, each doing what it is good at:

```
 Task object                  goal text, setup, done(obs), allowed skills
   |
 Decider (cascade)
   Jev (System One)           picks a skill each step; fast, cheap, accurate
     | escalates after a failure or when Jev asks for it
   ReAct LLM (System Two)     Thought -> Action(skill, args) -> Observation
   |                          keeps control for a few calls until recovered
   | skill calls
 Skills (tools)               navigate_to, approach, kick, nudge_ball, ...
   |                          deterministic, return { ok, text, data }
 Nav stack                    planner (Dubins, via-points around obstacles)
   |                          + controller (Regulated Pure Pursuit), replans
 RL policies                  walking + kick ONNX policies (unchanged)
```

Rule of thumb: **numbers that come from geometry are computed in code;
arguments that express intent come from the LLM.** Neither decider ever
produces velocities, step counts or raw coordinates ("walk left 4 cm" is
not even feasible for a forward-only duck). They pick *what* to do (skill +
semantic args, e.g. aim for the left corner, use the right foot, nudge the
ball away from the wall); the nav stack decides *how* to drive there.
This is the split used by SayCan, Inner Monologue, Code-as-Policies and Figure's Helix
(System 2 / System 1), and Nav2 for the lower half.

## Lower half: navigation stack (`app/src/nav/`)

Pure functions, no imports from `game/` or the DOM, so they run under
`node --test` and in the offline test bed.

### Files

| File | Contents |
|---|---|
| `nav/robot.js` | Robot model: measured motion limits (one object, documented) |
| `nav/world.js` | World model: walls + circular obstacles, `isFree(pose, path)` |
| `nav/dubins.js` | Dubins shortest path between two poses (6 word types: LSL, RSR, LSR, RSL, RLR, LRL), sampling to a polyline |
| `nav/planner.js` | `plan(start, goal, world)`: direct Dubins, then Dubins via-points (Phase 2), else `null` |
| (`nav/planner.js`, Phase 2b) | Pivot-first plans and a grid A* fallback walked as pivot -> straight legs (replaced the Hybrid A* idea once pivots were measured) |
| `nav/pure-pursuit.js` | Regulated Pure Pursuit: path + pose -> `[vx, wz]` |
| `nav/navigate.js` | `navigate(env, goalFn, opts)`: plan, follow, replan, report |

### Robot model (`robot.js`)

Fitted from logs, not measured by hand: Phase 0 records command and pose
at 50 Hz during a few runs and a small script fits actual speed per
command, turn rate per command (and whether it depends on speed) and the
start lag. The table in `agent-go-behind-ball.md` is the prior.

Measured 2026-11-13 with `__bench.measure(vx, wz)` (4 s holds, steady
state over the second half):

| vx cmd | wz cmd | speed m/s | turn rad/s | radius m | lag s |
|---|---|---|---|---|---|
| 0.22 | 1.0 | 0.157 | 0.48 | 0.33 | 0.38 |
| 0.25 | 0 | 0.158 | 0 | | ~0.4 |
| 0.25 | 0.5 | 0.161 | 0.33 | 0.49 | 0.65 |
| 0.25 | 1.0 | 0.165 | 0.53 | 0.31 | 0.39 |
| 0.25 | 1.5 | 0.166 | 0.70 | 0.24 | 0.25 |
| 0.25 | 2.0 | 0.163 | 0.85 | 0.19 | 0.40 |
| 0.30 | 2.0 | 0.177 | 0.99 | 0.18 | 0.25 |
| 0.30 | 2.5 | 0.176 | 1.19 | 0.15 | 0.39 |
| 0.35 | 0 | 0.189 | 0 | | 0.43 |
| 0.35 | 1.0 | 0.190 | 0.69 | 0.28 | 0.25 |
| 0.35 | 2.0 | 0.192 | 1.10 | 0.18 | 0.42 |
| 0.40 | 0 | 0.205 | 0 | | 0.26 |
| 0.50 | 0 | 0.242 | 0 | | 0.24 |
| 0.50 | 1.0 | 0.247 | 0.66 | 0.38 | 0.24 |

Reverse (measured the same way): `vx = -0.2` and `-0.3` with `wz = 0`
do not move the duck at all; with a turn command added it walks
*forward* in a curve (0.15 m/s, 0.63 rad/s). So there is no back-up
skill to be had from this policy.

**Pivot on the spot** (measured 2026-11-20, `vx = 0`, timed on the sim
clock): the earlier "turn in place is impossible" came from `wz = 1.0`,
which really does barely turn (0.1 rad/s). Higher commands pivot:

| wz cmd | 90° in | 180° in | max drift | fell |
|---|---|---|---|---|
| 1.5 | 2.0 s | 4.0 s | 3.8 cm | no |
| 2.0 | 1.4 s | 2.8 s | 2.3 cm | no |
| 2.5 | 1.1 s | 2.2 s | 3.9 cm | no |
| 3.0 | 0.9 s | 1.8 s | 4.0 cm | no |
| -2.5 | 1.0 s | 2.2 s | 6.1 cm | no |

`robot.js` pivots at 2.5 (~1.4 rad/s), stopping 0.25 rad early for the
lag. A duck that can pivot is never trapped: it can always face open
floor and walk out (Phase 2b below).

The duck stayed up in every row. Two things the earlier notes had wrong:
the walk is ~0.16 m/s at the 0.25 command (not 0.1), and the policy takes
turn commands well above the keyboard's 1.0 rad/s. The model in
`robot.js`:

```js
export const ROBOT = {
  vMinCmd: 0.22,    // m/s command below which the policy doesn't step
  vCurve: 0.3,      // m/s command on curves (0.18 m/s actual)
  vMaxCmd: 0.4,     // m/s command on straights (0.21 m/s actual)
  wMax: 2.0,        // rad/s command limit (2.5 was still stable; margin kept)
  turnPerCmd: 0.45, // actual rad/s per commanded rad/s
  turnRadius: 0.18, // m, at vCurve and wMax
  planRadius: 0.235,// m, 1.3 x turnRadius: what the planner uses
  lag: 0.3,         // s, first-order response to a command
  radius: 0.08,     // m, footprint for collision checks
};
export const actualSpeed = (vx) => (vx < ROBOT.vMinCmd ? 0 : 0.09 + 0.3 * vx);
```

`planRadius` and the controller's lookahead are tied: the lookahead is
one `planRadius` (0.12 m on the last stretch, so the heading settles),
because a lookahead longer than the planned turn radius cannot track the
tightest arcs.

### World model (`world.js`)

```js
makeWorld({
  bounds: ARENA_HALF - margin,          // square arena walls
  obstacles: [{ x, y, r }],             // ball (r = BALL_RADIUS + clearance), goal posts; later: other ducks
})
world.isFree([x, y])                    // point vs walls + obstacles, inflated by ROBOT.radius
world.pathFree(points)                  // every sample free
```

Obstacles are recomputed from `observe()` each plan, so a moved ball is
picked up automatically.

### Planner

- **Pose**: `[x, y, heading]`.
- **Dubins** gives the shortest forward-only path with turn radius
  `planRadius`: closed form, microseconds. Try all 6 words, keep the
  shortest collision-free one. This alone covers the open-field cases.
- **Dubins via-points** (Phase 2) when no direct word is free (ball
  between duck and goal pose): candidate intermediate poses on a ring
  around each obstacle at its inflated radius, headings tangent to the
  ring in both directions (~8 points x 2 headings per obstacle), path =
  Dubins(start -> via) + Dubins(via -> goal); keep the shortest
  collision-free combination. A few dozen closed-form evaluations, tens of
  lines of code. The arena has one real obstacle, so this should cover
  every benchmark layout that has room behind the ball.
- **Hybrid A*** only if a benchmark case still fails after via-points.
  Not planned in detail until then.
- Returns `{ points: [[x, y, heading], ...], length }` or `null` with a
  reason (`"goal pose is blocked"`, `"no path"`), which becomes the skill's
  failure text for the agent.

### Controller: Regulated Pure Pursuit

Nav2's default for car-like robots:

- Lookahead point on the path at distance `L` (scaled with speed, clamped
  to about `[0.8, 1.5] x planRadius`).
- Curvature `k = 2 * sin(alpha) / L`, `wz = v * k`, clamped to `wMax`.
- Speed regulation: slow down on high curvature and when close to the goal
  (`v -> vMinCmd` within ~0.25 m), never below `vMinCmd` while moving.
  On any curve the speed must drop to `vCurve`, because the turn radius
  grows with speed: the planner's `turnRadius` only holds at `vCurve`.
- **Path extended past the goal pose** by one lookahead along the final
  heading, so the pursuit converges onto the heading instead of cutting
  the last corner. The duck stops when it reaches the real goal pose.
- Done when within position tolerance and heading tolerance of the goal.

### `navigate()`

```js
await navigate(env, goalFn, {
  obstacles: (obs) => [...],   // what to avoid (default: the ball)
  posTol: 0.06, headingTol: 0.3, timeoutS: 20,
})  // -> { ok, text, data: { timeS, pathLength, replans } }
```

- `goalFn(obs)` returns the goal pose, re-evaluated each tick, so goals
  attached to the ball follow it.
- Replan when: the goal pose moved > 5 cm, the duck is > 10 cm off the
  path, or the path became blocked. Otherwise keep following.
- Split into a **pure step function** `navStep(state, obs, now) -> { cmd,
  state, done }` (planning, replanning, pursuit; no timers, no `env`) and a
  thin async runner on the existing `drive()` loop. The offline test bed
  calls `navStep` with a virtual clock; the browser calls the runner.
- The runner uses the existing `drive()` loop semantics: pause/stop via
  `run-control.js`, intent shown with `env.showTarget` (extend to draw the
  whole path).

## Upper half: tasks, skills, decider cascade

### Tasks (`agent/tasks.js`)

A task is an object, so a new scenario is a new entry, not a harness
change:

```js
penalty: {
  label: "Penalty kick",
  goal: "Score a goal: kick the ball into the goal net.",
  setup: async (env) => { ... },          // duck respawned, ball on the spot
  done: (obs) => obs.ballInGoal,          // checked by the harness watcher
  skills: ["navigate_to", "approach", "kick"],
}
```

The harness's goal watcher calls `task.done(obs)` instead of
`isBallInGoal` directly. Later tasks: obstacle course (`navigate_to` with
more obstacles), dribble to a point, penalty with a keeper duck.

### Named world targets (`agent/observe.js`)

`observe()` also returns a map of named things (`ball`, `goal`, `spawn`;
later `cone_A`, `duck_2`). Skills resolve semantic targets like
`behind_ball` against it; other ducks become obstacles in the world model
through the same map. For the LLM, `describe(obs, { full: true })` adds
what Jev doesn't need: ball distance to the nearest walls, room behind the
ball, the duck's offset from the shooting line, and the last skill's
`data`.

### Skills (`agent/tools.js`)

Each skill keeps the current shape (`description`, `blocker`, `run`) and
gains:

- `params`: JSON schema of its **semantic** args (named targets, sides,
  directions), resolved to poses in code. Used by the LLM.
- `defaults`: the args used when no one passes any, so every skill can run
  without the LLM.
- `options`: the small set of arg presets offered to Jev as separate
  choices (e.g. `approach` -> `approach:left`, `approach:right`), so Jev
  keeps choosing among fixed labels exactly as today.

| Skill | Args (default) | Jev options | Implementation |
|---|---|---|---|
| `navigate_to` | `target`: `"behind_ball"` \| `"spawn"` (`behind_ball`); `aim` (`goal`) | `navigate_to:behind_ball` | `navigate()` to the resolved pose, ball as obstacle |
| `approach` | `foot`: `left` \| `right` (none); `aim` (`goal`) | `:left`, `:right` | existing `approachForKick` (line-following, unchanged, see Decisions) |
| `kick` | `foot` (none) | `:left`, `:right` | existing `kick` |
| `nudge_ball` (Phase 4) | `direction`: `"away_from_wall"` \| `"toward_goal"` (`away_from_wall`) | `nudge_ball:away_from_wall` | `navigate_to` + `approach` with `aim` = that direction, then a `kick`: a composition of the skills above, no new control law |

`go_behind_ball` becomes `navigate_to({ target: "behind_ball" })`. Every
skill returns `{ ok, text, data }`; `text` is the observation both
deciders read. No skill takes raw coordinates or distances in cm.

**`aim`** (`goal` \| `left_corner` \| `right_corner` \| `away_from_wall`)
is the direction the shooting line points. `shootingLine` takes it instead
of always using `GOAL_AIM`. It is pulled forward because `nudge_ball` is
just the normal play aimed elsewhere, and because the far-corner layout has
no room on the wall side either, so a nudge there is a kick along the
wall.

**Failures report partial progress.** A timeout says how far from the goal
pose the duck got and how far off its heading is, never just "timed out".
That text is what the LLM diagnoses from; a bare timeout forces a blind
retry.

### Decider cascade (`agent/decider.js`, replaces the `decide()` call in `harness.js`)

Jev decides by default; the ReAct LLM is called only when needed. This is
a model cascade: cheap fast model first, slow strong model on escalation.

```
each step:
  obs, gated options          (as today)
  if escalate(prev step, jev) -> LLM recovery: up to N calls, then a summary
  else                        -> Jev: skill option
```

Escalate to the LLM when either of:

1. **The last skill failed** (`ok: false`): diagnosis and recovery.
2. **Jev asks for it**: an extra Jev option `think_it_through` ("none of
   these fits the situation") is always on offer, so Jev itself can
   escalate when non-default args or an unusual recovery are needed.

Deferred until logged runs exist: escalating on low confidence or a small
top-two margin. Jev's probabilities are logged on every step from Phase 3
on, so the thresholds can be chosen from data instead of guessed. An LLM
plan at task start (the old Phase 3b) is dropped for the penalty.

Rules:

- An escalation is a **scoped recovery**, like a sub-agent: the LLM keeps
  control for up to `N` skill calls (start: 3) until it declares the
  situation back to normal, then returns a one-line summary that goes
  into Jev's `recent_steps`. Jev never sees a half-finished recovery, so
  it cannot undo one.
- LLM budget per run (e.g. 2 escalations). Out of budget -> Jev only;
  repeated identical failures end the run.
- Normal play (penalty from the spot) should need **zero** LLM calls.

### Jev (`agent/system-one.js`, unchanged API)

Gets options as `skill:preset` labels plus `think_it_through`; state gains
`recent_steps[].decided_by` and the LLM's recovery summary when there was
one. Its `describe(obs)` text stays as terse as today.

### ReAct LLM (`agent/react.js`)

- Tool-calling LLM through any **OpenAI-compatible chat-completions
  endpoint** (OpenRouter by default; also local servers, gateways, other
  providers). Configured as `{ baseUrl, model, apiKey, headers }`, where
  `headers` are optional custom headers (e.g. OpenRouter's `HTTP-Referer` /
  `X-Title`, or a gateway's auth header). Set in the agent panel (kept in
  localStorage like the current key) or in `app/.env` for the dev-server
  proxy (`/api/llm`, same pattern as `/api/s1`). Start with a fast Claude
  model (Haiku class), compare with a Sonnet-class one; exact model IDs
  checked at implementation time.
- Many OpenAI-compatible endpoints block browser requests (CORS); the
  dev-server proxy is the default route, direct browser calls only for
  endpoints that allow them.
- Prompt: task, robot limits in plain words, how skills work, why it was
  escalated, recent steps (incl. Jev's), fresh `describe(obs, { full:
  true })`; "think, call one skill, read its result, repeat until the
  situation is back to normal, then say so". Tools = the gated skills with
  `params` plus `recovered(summary)`.
- **Gating stays**: blocked skills are listed with their reason; calling
  one returns that reason instead of running.
- Args validated against `params`; invalid calls become an error
  observation, not a crash.

### UI (`AgentPanel.jsx`)

Each step card shows **who decided** (Jev / LLM badge) and, for LLM steps,
the **escalation reason**, **thought** and **skill call with args**; Jev
steps keep the probability bars. Run stats split cost and latency by
decider. Planned path drawn on the floor while navigating.

**Run export**: an "Export run" button saves the whole trace as JSON
(per step: observation, available and blocked skills, decision,
probabilities, result, LLM thoughts). Exported runs are the fixtures for
an offline eval of the ReAct prompt and the escalation rules
(`app/test/agent/react.test.js`, a text-only mock env that replays
recorded observations against a cheap model), and the data the deferred
confidence thresholds are chosen from.

## Phases

Each phase is shippable on its own and ends with the benchmark.

### Phase 0: measure (no code changes kept) — done 2026-11-13

- Log command and pose at 50 Hz while driving vx = 0.25 / 0.35 / 0.45 /
  0.5 and wz = 0 / 0.5 / 1.0 for a few seconds each; fit speed per
  command, turn rate per command, start lag with a small script
  (scratch, not committed). Fill `robot.js`; decide whether `vMaxCmd` can
  be raised.
- Move the console benchmark snippet from `agent-go-behind-ball.md` into
  `app/src/agent/bench.js` (exposed on `window.__bench`, debug only) so it
  is not pasted every time.
- Baseline the current `go_behind_ball` on the 8 benchmark layouts
  (6 in `agent-go-behind-ball.md` + the 2 untested ones).

### Phase 1: Dubins + Regulated Pure Pursuit — done 2026-11-13

- `robot.js`, `world.js`, `dubins.js`, `planner.js` (Dubins only),
  `pure-pursuit.js`, `navigate.js`.
- Unit tests (`app/test/nav/*.test.js`): Dubins lengths against known
  cases, path endpoints/headings match the goal, collision checks.
- Offline test bed (`app/test/nav/sim.test.js`): unicycle model with the
  measured limits + start lag, virtual clock, runs `navigate()`'s step
  logic on hundreds of random layouts; reports success rate and time.
- `go_behind_ball` reimplemented on `navigate()`; Jev harness unchanged;
  benchmark snippet in `agent-go-behind-ball.md` updated to the new tool.
- **Done when**: penalty spot and goal line faster than baseline (target
  <= 6 s vs 8 s / 13 s), no ball pushed, duck-in-front and beside cases
  pass where the Dubins path is free.

### Phase 2: Dubins via-points — done 2026-11-13 (landed with Phase 1)

- Via-point search in `planner.js` as the fallback when the direct path
  collides.
- **Done when**: near-post and duck-in-front pass in the browser
  benchmark; offline success rate >= 95% on random layouts with room
  behind the ball; planning < 5 ms. If a layout still fails for want of
  a path, and only then, add Hybrid A* as Phase 2b.

### Phase 2b: pivots, never stuck — done 2026-11-20

- Measured the pivot (table under Robot model) and added it to
  `robot.js`. `bench.measure()` and `bench.run()` now time on the sim
  clock, so headless runs (software GL, below real time) give true rates.
- Plans are legs: `{ type: "pivot", heading }` or `{ type: "follow",
  points }`. `plan()` tries, cheapest first: (1) Dubins direct / via, as
  before; (2) pivot to one of 16 headings, then a direct Dubins path,
  chosen when it saves > 1 s over (1); (3) grid A* (4 cm cells) smoothed
  to straight lines, walked pivot -> straight -> ... -> pivot -> run-in.
  (3) succeeds whenever the start and goal are in the same free region,
  so the only remaining failures are a blocked goal pose (Phase 4) or a
  goal walled off entirely.
- `makeNav` walks the legs: a pivot leg commands `[0, ±pivotCmd]` until
  within `pivotLead`; intermediate straights hand over near their end;
  arrival is judged on the final leg as before. Results report `pivots`.
- Tests: pivot-first and L-corridor (grid tier) planner tests; the
  offline test bed models the pivot, starts right up to the walls, and
  checks every corner and wall start. The wedged-behind-the-ball test now
  expects success instead of a fast "no path".
- **Result**: offline 300 / 300 random layouts (was 287), mean 11.1 s
  (was 11.9), 12 / 12 corner and wall starts. Browser: every reachable
  benchmark layout passes, plus three new pivot cases (column below).

### Phase 3a: tasks, skills, export (no LLM) — done 2026-11-13

- `tasks.js` (task object; harness uses `task.setup` / `task.done` /
  `task.skills`; `gateOptions` / `decideInput` shared with the replay),
  named targets in `observe()`, `describe(obs, { full })`.
- Skills gained `params` / `defaults` / `options`; `go_behind_ball` is
  `navigate_to` (targets `behind_ball` / `spawn`); `aim` on `navigate_to`
  and `approach` (`goal` / `left_corner` / `right_corner`, carried in
  `obs`); partial-progress failure text on every skill; every result has
  `data`.
- Step record keeps the raw duck / ball poses, every gated option, the
  merged args and Jev's probabilities; "Export run" button; `replay.js`
  re-gates and re-decides a run offline. Fixture
  `test/agent/fixtures/penalty-scored.json` is a real scored run (6
  steps, recovery after a short kick) and replays with matching options.
- Verified in the browser: Jev alone scores from Start with the new
  option labels (4 and 6 decisions in two runs), cost unchanged
  (~$0.00002 per decision).

### Phase 3b: decider cascade (Jev + ReAct LLM)

- `decider.js` (escalation rules, scoped recovery), `react.js`, `/api/llm`
  proxy, endpoint settings (base URL, model, key, custom headers) in the
  agent panel.
- UI: decider badge, escalation reason, thought + args, cost split.
- Offline eval: `app/test/agent/react.test.js` replaying exported runs
  through the cascade with a cheap model (needs a key; skipped without).
- **Done when**: a penalty from the spot scores with **zero** LLM calls
  and Jev's cost unchanged; a deliberately failed step (e.g. ball moved
  mid-run) escalates, the LLM recovers within its call budget and hands
  back, and Jev carries on; per-run cost / latency per decider shown in
  the panel.

Done 2026-11-20:

- `agent/decider.js`: escalation rules as pure functions (`escalationReason`
  after a failed Jev step, `withThink` adds `think_it_through` while the
  budget lasts, `isStuck` = the same call failing 3 times in a row ends
  the run as "stuck", `makeBudget` = 2 escalations x 3 skill calls).
- `agent/react.js`: OpenAI-compatible chat completions with tool calling
  (one tool per task skill from its `params`, plus `recovered(summary)`);
  `recover()` loop: one skill per call, defaults merged under the LLM's
  args, args validated, blocked calls return their reason without
  running or costing a skill call, extra tool calls in one message are
  refused, at most `calls + 3` requests. A text-only reply counts as the
  hand-back. Default model `anthropic/claude-haiku-5.5` (a setting:
  check the exact ID on the endpoint).
- `/api/llm` dev proxy to OpenRouter (key from `app/.env`), or a direct
  base URL + key + custom headers from the panel. An endpoint error
  (bad key, 5xx, network) is recorded as "LLM unavailable" and Jev carries
  on alone for the rest of the run.
- Harness: hand-back summary goes into Jev's `recent_steps` (with
  `decided_by`); LLM steps share the 20-step budget. `replay.js`
  re-decides only Jev's steps and replays hand-backs into the history.
- UI: Jev / LLM badge per card, escalation reason and thought on LLM
  cards, a hand-back card per recovery, cost and think time per decider,
  LLM settings panel; ticker handles LLM steps.
- Tests (`test/agent/react.test.js`): decider rules and the recovery loop
  against a scripted LLM (11 tests); a live eval on the fixture's missed
  kick runs when `LLM_API_KEY` is set (`LLM_BASE_URL`, `LLM_MODEL`
  optional), skipped otherwise.
- Browser, Jev and the LLM mocked at the network layer (real request
  code, real physics): plain penalty scored with **0 LLM requests**;
  ball moved during Jev's run-up -> run-up failed -> LLM re-staged and ran
  up (2 skills), handed back, Jev kicked; a second failure used the
  second escalation, after which Jev went on alone and three identical
  failures ended the run as "stuck"; Jev choosing `think_it_through` ->
  LLM recovery -> Jev scored; LLM endpoint down -> "LLM unavailable",
  Jev scored alone.
- Not yet done: a run against a real LLM (no key in the dev container);
  run `LLM_API_KEY=... npm test` or play with the dev proxy to fill in
  real latency / cost.

### Phase 4: layouts that need reasoning

- `nudge_ball` as a composition (`navigate_to` + `approach` with `aim` +
  `kick`); wall and corner layouts solved by the agent chaining nudge ->
  navigate -> approach -> kick. No back-up skill: the policy does not
  reverse (measured 2026-11-13); pivots (Phase 2b) cover turning round.
- **Done when**: side-wall and far-corner layouts score.

Done 2026-11-20:

- `field.js`: `hasRunUpRoom(obs)` (a normal staging pose is free);
  `nudgeHeadings(obs)` tries 72 directions, keeps those with a free
  staging pose 0.4 / 0.3 / 0.25 / 0.23 m behind the ball (1.5 cm slack),
  drops those where a short kick hits a wall or the net, and scores where
  the ball lands after 0.5 / 1.0 / 1.5 / 1.8 m kicks (the kick has one
  strength; nudges travelled 1.2-1.7 m): room for a normal run-up, then
  distance from walls, then a longer staging distance, then goalward.
  Nudges use `nudgeWorld` (1 cm margins instead of 4 / 3 cm): in the far
  corner the only free side is the pocket between ball and corner, which
  the normal margins seal off though the 25 cm gap fits the 16 cm duck.
- `nudge_ball` skill (`direction: away_from_wall`, `foot`): picks the best
  direction whose staging pose the planner can reach, then navigate (aim
  fixed as a floor point along it) -> run-up -> kick. ok when the ball
  ends with room for a normal run-up. Offered only when there is no such
  room; `navigate_to:behind_ball` is blocked in exactly that case ("nudge
  it off first"), so Jev's choice there is forced.
- Planner: the grid tier also exempts the goal cell (a pose wedged near a
  wall can be free while its cell centre is not).
- Harness: when every option is blocked and no escalation is left, the
  run ends as "stuck" with the reasons, instead of asking Jev to choose
  from nothing.
- Tests: nudge gating, nudge headings for five wall / corner balls,
  corner staging reachable; 51 pass, 1 skipped (live LLM eval).

## Benchmark

Kept as the acceptance test for every phase, recorded in this file:

| Layout (ball / duck) | Baseline | P1+P2 (2026-11-13) | P2b pivots (2026-11-20) | P3 | P4 |
|---|---|---|---|---|---|
| Penalty spot (0.7, 0.1) / spawn | ✅ 8 s | ✅ 5.3 s, 3° | ✅ 5.1 s, 2° | ✅ 3 steps, 0 LLM | ✅ 3 steps, 0 LLM |
| Goal line (1.12, 0.15) / spawn | ✅ 13 s | ✅ 8.6 s, 4° | ✅ 9.0 s, 1° | | |
| Near post (1.05, −0.22) / (0.85, 0.05, 0°) | ❌ | ✅ 15.2 s, 6° | ✅ 9.5 s, 4°, 1 pivot | | |
| Duck in front (0.5, 0) / (0.9, 0, 180°) | ❌ | ✅ 11.9 s, 2° | ✅ 9.5 s, 13°, 1 pivot | | |
| Beside, facing away (0.2, 0.3) / (0.2, −0.1, −90°) | ? | ✅ 9.9 s, 1° | ✅ 9.9 s, 2° | | |
| Goal-side, offset (0.0, −0.4) / (0.5, −0.2, 90°) | ? | ✅ 13.2 s, 6° | ✅ 13.2 s, 8° | | |
| Side wall (0.3, 1.25) / spawn | ❌ no room | ❌ instant "target pose is blocked" | ❌ same (Phase 4) | | ✅ 2 / 2 (7 and 14 steps) |
| Far corner (−1.2, −1.2) / spawn | ❌ no room | ❌ instant "target pose is blocked" | ❌ same (Phase 4) | | ✅ 2 / 2 (4 steps, 0 LLM) |
| Beside the goal (1.2, 1.25) / spawn | | | | | ✅ 2 / 3 (third ended with the ball 7 cm from the goal wall, no move possible) |
| Wedged behind the ball (1.0, 0.05) / (0.85, 0, 6°) | | ❌ "no path" | ✅ 9.5 s, 1°, 1 pivot | | |
| Duck in a corner (0.7, 0.1) / (1.35, 1.35, 45°) | | | ✅ 14.8 s, 13°, 1 pivot | | |
| Duck facing the back wall (0.7, 0.1) / (−1.35, 0.3, 180°) | | | ✅ 11.0 s, 3°, 1 pivot | | |

P3 / P4 are full runs from Start in headless Chromium with Jev and the
LLM mocked at the network layer (Jev: kick > run-up > go behind > nudge,
by availability; the LLM: re-stage, run up, hand back), real skills and
physics. Misses after a run-up (mostly wide left) cost extra steps in
several runs; whether that is the slow headless sim (the kick's settle
pause is wall-clock) or the kick itself is not yet known. P1-P2b times
are `go_behind_ball` alone, ball never touched; the angle is the
facing error on arrival. Phase 2b times are on the sim clock (headless
Chromium, rendering throttled to 2 fps so the physics keeps up). Phases
1-2 were run with `__bench.run()` in the browser console (`app/src/agent/bench.js`, page opened with `?boot=1`);
Phases 3-4 run the full agent from Start.

Full agent from Start (Jev + the new tool, 2026-11-13): scored in 6
steps / 40.8 s: go behind -> run-up -> kick (wide right) -> go behind
(8.4 s, from beside the goal) -> run-up -> GOAL. The recovery after the
miss is new; the old tool could not line up from there. Two lessons from
the first full run: Jev chooses from the tool's result text, so a success
must say "ready for a run-up", not just where the duck is; and the
policy's stop stance turns the duck ~15°, which the run-up absorbs.

Offline test bed (`npm test`, `test/nav/sim.test.js`): the eight layouts
(six above plus two post-kick ones) pass, and 287 / 300 random layouts
with room for a run-in succeed (mean 11.9 s, no ball contact). The 13
failures are starts wedged against a wall, the goal net or the ball where
no forward-only path at the planned radius exists; they fail in
milliseconds with a "no path" reason. Since Phase 2b (pivots) the test
bed starts the duck right up to the walls and gets 300 / 300 (mean
11.1 s), plus 12 / 12 corner and wall starts.

## Risks

- **Model mismatch**: the policy's real turn radius / lag differ from
  `robot.js`, so planned paths aren't trackable. Mitigation: Phase 0
  fit from logs, replanning, `planRadius` = 1.3 x measured, lookahead
  tied to `planRadius`, path extended past the goal pose.
- **Ball contact**: the duck brushes the ball on the way. Mitigation:
  ball obstacle inflated by robot radius + clearance; slow near the goal.
- **LLM latency / cost**: seconds per call. Mitigation: Jev decides by
  default, LLM only on escalation (one skill per call), per-run budget.
- **Ping-pong between deciders**: Jev undoes what the LLM started.
  Mitigation: the LLM keeps control until its recovery is done and hands
  back a summary; repeated identical failures end the run.
- **Escalation too rare or too frequent**: with only failure and
  `think_it_through` as triggers the LLM may never see a "stuck but not
  failed" situation. Mitigation: Jev's probabilities logged from Phase 3;
  confidence / margin triggers added once exported runs show where they
  would have helped.
- **LLM picks bad args**: semantic args only, validated against the
  schema; invalid calls return an error observation, not a crash.

## Decisions

1. LLM route: any OpenAI-compatible endpoint (OpenRouter default) with
   configurable custom headers. (2026-11-11)
2. Jev stays long term: accurate and very cheap. (2026-11-11)
3. Jev and the LLM work as a cascade, not a toggle: Jev by default, the
   LLM on escalation. Numbers from geometry come from code, intent args
   from the LLM. (2026-11-11)
4. `approach` stays a line-follower for Phases 1-2; revisit once the
   offline test bed shows how precisely `navigate()` ends at a pose
   (merge if reliably within ~2 cm). (2026-11-11)
5. Dubins via-points before Hybrid A*; Hybrid A* only if a benchmark
   layout still fails. (2026-11-13)
6. An escalation is a scoped recovery: the LLM keeps control for up to N
   calls and hands back a summary. (2026-11-13)
7. Escalate only on failure and `think_it_through` at first; confidence /
   margin triggers wait for logged data. No LLM plan at task start.
   (2026-11-13)
8. Runs export as JSON and replay offline as the eval for the ReAct half.
   (2026-11-13)
9. `aim` is a Phase 3 arg; `nudge_ball` composes existing skills.
   (2026-11-13)
10. Tasks are objects (setup, done, skills); observe() names world
    targets. (2026-11-13)
11. Phase 3 is split: 3a (tasks, skills, export, replay; Jev only) before
    3b (the cascade), so the skill interface is proven with one decider
    and exported runs exist to write the ReAct prompt against.
    (2026-11-13)
12. No back-up skill: the walking policy ignores reverse commands.
    (2026-11-13)
13. The planner must never leave the duck stuck: it pivots on the spot
    (`wz` 2.5, measured) and falls back to grid A* with pivots instead of
    Hybrid A*. Normal play still prefers smooth curves; a pivot is used
    only when it saves > 1 s or nothing else fits. (2026-11-20)
14. LLM limits: up to 3 skill calls per escalation, 2 escalations per
    run, to be revisited with exported runs. (2026-11-20)
15. Confidence / margin escalation: decided from ~20-30 exported runs
    that include hard layouts; the threshold must never fire on a normal
    penalty (zero LLM calls), and is skipped if no threshold separates
    failing from succeeding steps. (2026-11-20)
16. Nudges are full-strength kicks (one kick policy), scored over the
    whole 0.5-1.8 m range, and navigate with 1 cm margins. A ball with no
    reachable free side is reported, not attempted. (2026-11-20)

## Open decisions

None open; 1-3 were settled as Decisions 13-15.
