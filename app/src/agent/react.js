// System Two: a ReAct LLM that takes control for a scoped recovery when
// the decider cascade escalates (decider.js). Thought -> one skill call ->
// its result -> repeat, until it calls `recovered(summary)` or runs out of
// skill calls; the summary goes into Jev's recent steps.
//
// Talks to any OpenAI-compatible chat-completions endpoint with tool
// calling. Settings (agent panel, kept in this browser):
//   baseUrl   empty = the dev server's /api/llm proxy (OpenRouter, key from
//             app/.env, vite.config.js); else e.g. https://openrouter.ai/api/v1
//   model     e.g. anthropic/claude-haiku-5.5 (any tool-calling model)
//   apiKey    sent as Bearer when calling baseUrl directly
//   headers   extra headers as JSON, e.g. {"X-Title": "Microduck"}
// Many endpoints refuse browser requests (CORS); the proxy is the default.
//
// The LLM picks skills and their semantic args only (named targets, feet,
// aims); poses and velocities stay in code. Skills keep their gating: a
// blocked call returns the reason instead of running, and args are checked
// against the skill's params.

const PROXY_URL = "/api/llm";
const STORAGE = "microduck.llm";
export const LLM_DEFAULTS = { enabled: true, baseUrl: "", model: "anthropic/claude-haiku-5.5", apiKey: "", headers: "" };
const RECOVERED = "recovered";
const EXTRA_REQUESTS = 3; // LLM requests per escalation beyond one per skill call (bad args, blocked calls)

export function getLlmConfig() {
  try { return { ...LLM_DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE) || "{}") }; } catch { return { ...LLM_DEFAULTS }; }
}

export function setLlmConfig(cfg) {
  try { localStorage.setItem(STORAGE, JSON.stringify(cfg)); } catch { /* storage blocked: not remembered */ }
}

function parseHeaders(text) {
  if (!text?.trim()) return {};
  const h = JSON.parse(text);
  if (typeof h !== "object" || Array.isArray(h)) throw new Error("custom headers must be a JSON object");
  return h;
}

// One chat-completions request. Returns { message, latencyMs, cost }.
export async function chatCompletion(cfg, messages, tools) {
  const direct = cfg.baseUrl.trim();
  const url = direct ? `${direct.replace(/\/+$/, "")}/chat/completions` : PROXY_URL;
  const openrouter = !direct || /openrouter\.ai/.test(direct);
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(direct && cfg.apiKey && { Authorization: `Bearer ${cfg.apiKey}` }),
      ...parseHeaders(cfg.headers),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_tokens: 2000,
      ...(openrouter && { usage: { include: true } }), // OpenRouter reports the cost
    }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error(`LLM: no message in the response (${JSON.stringify(json).slice(0, 200)})`);
  return { message, latencyMs, cost: json.usage?.cost ?? null };
}

// OpenAI tool definitions: one per skill the task allows, plus recovered.
export function toolDefs(tools, skills) {
  const defs = skills.filter((s) => tools[s]).map((s) => ({
    type: "function",
    function: { name: s, description: tools[s].description, parameters: { type: "object", properties: {}, ...tools[s].params } },
  }));
  defs.push({
    type: "function",
    function: {
      name: RECOVERED,
      description: "Hand control back to the fast decider once the duck is back in a normal situation (it can go behind the ball, run up and kick as usual), or when you cannot do better. Ends your turn.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "One sentence: what went wrong, what you did, what the fast decider should do next." } },
        required: ["summary"],
      },
    },
  });
  return defs;
}

// Checks args against a skill's params schema (object of enum/string
// properties, required list). Returns an error string or null.
export function validateArgs(schema, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const props = schema?.properties ?? {};
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) return `unknown argument "${k}" (expected ${Object.keys(props).join(", ") || "none"})`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(", ")}, not "${v}"`;
  }
  for (const k of schema?.required ?? []) if (!(k in args)) return `missing required argument "${k}"`;
  return null;
}

export function systemPrompt(task) {
  return [
    "You control a small two-legged robot duck in a physics simulation, in a square 3 x 3 m arena with one goal.",
    `Task: ${task.goal}`,
    "",
    "Normally a fast decider picks the duck's next skill each step. You have been called because something went wrong or the fast decider did not know what to do. Diagnose the situation, then call skills one at a time and read each result before the next call.",
    "",
    "How the duck moves: it walks forward only (no reversing), can pivot on the spot, and plans its own paths around the ball and the goal. You never give coordinates, distances or speeds: you choose a skill and its named arguments, and the skill works out the motion.",
    "Normal play is: navigate_to behind_ball -> approach with one foot -> kick with that foot. A kick sends the ball along the duck's heading.",
    "Some skills are blocked in some situations; the state lists which, with the reason. Calling a blocked skill only returns that reason.",
    "",
    "Before each call, write one or two sentences of reasoning. As soon as the duck is back in a situation where the normal play works (or you cannot do better), call recovered with a one-sentence summary. You may run at most the number of skills stated in each message.",
  ].join("\n");
}

// Plain text of what the LLM sees each turn: state, skills on offer.
function stateText(look, callsLeft) {
  const lines = Object.entries(look.observation).map(([k, v]) => `  ${k}: ${v}`);
  const skills = look.options.map((o) => `  - ${o.skill}(${Object.entries(o.args).map(([k, v]) => `${k}=${v}`).join(", ")}): ${o.blocked ? `blocked: ${o.blocked}` : "available"}`);
  return `State now:\n${lines.join("\n")}\nSkill presets right now (other argument values are allowed):\n${skills.join("\n")}\nSkill calls left in this recovery: ${callsLeft}.`;
}

// The scoped recovery. Callbacks:
//   look()        -> { observation (describe(obs, { full: true })), options (gated, defaults merged), blockerFor(skill, args) }
//   act(call)     -> runs (or records as not run) one skill call and resolves { ok, text }.
//                    call = { skill, args, thought, latencyMs, cost, blocked: reason | null, index }
//   llm(messages, tools) -> { message, latencyMs, cost } (chatCompletion bound to a config)
//   checkpoint()  -> resolves when not paused; throws when the run ends
// Returns { summary, recovered, calls, requests, cost, thought }.
export async function recover({ task, tools, why, history, look, act, llm, maxCalls, checkpoint = async () => {} }) {
  const defs = toolDefs(tools, task.skills);
  const recent = history.map((h) => `  ${h.step}. [${h.decided_by ?? "jev"}] ${h.action} -> ${h.result}`).join("\n") || "  (none)";
  const messages = [
    { role: "system", content: systemPrompt(task) },
    { role: "user", content: `Why you were called: ${why}\n\nRecent steps:\n${recent}\n\n${stateText(look(), maxCalls)}` },
  ];
  let calls = 0, requests = 0, cost = 0, pending = { thought: "", latencyMs: 0, cost: 0 };
  const maxRequests = maxCalls + EXTRA_REQUESTS;
  while (requests < maxRequests) {
    await checkpoint();
    const res = await llm(messages, defs);
    requests++;
    cost += res.cost ?? 0;
    const { message } = res;
    const thought = (typeof message.content === "string" ? message.content : "") || message.reasoning || "";
    pending = { thought: thought.trim(), latencyMs: res.latencyMs, cost: res.cost };
    messages.push({ role: "assistant", content: message.content ?? "", ...(message.tool_calls?.length && { tool_calls: message.tool_calls }) });
    const callsHere = message.tool_calls ?? [];
    // No tool call: the model answered in text; take it as its hand-back.
    if (!callsHere.length) return { summary: pending.thought || "ended without a summary", recovered: false, calls, requests, cost, thought: "" };
    let result = null;
    for (const [i, tc] of callsHere.entries()) {
      const reply = (content) => messages.push({ role: "tool", tool_call_id: tc.id, content });
      if (i > 0) { reply("not run: one skill at a time; call it again after reading the first result"); continue; }
      const name = tc.function?.name;
      let args;
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { reply("error: arguments are not valid JSON"); continue; }
      if (name === RECOVERED) {
        return { summary: String(args.summary ?? "").trim() || pending.thought || "recovered", recovered: true, calls, requests, cost, thought: pending.thought };
      }
      if (!task.skills.includes(name) || !tools[name]) { reply(`error: no skill "${name}" (skills: ${task.skills.join(", ")}, ${RECOVERED})`); continue; }
      const bad = validateArgs(tools[name].params, args);
      if (bad) { reply(`error: ${bad}`); continue; }
      if (calls >= maxCalls) { reply("not run: no skill calls left in this recovery; call recovered now"); continue; }
      const merged = { ...tools[name].defaults, ...args };
      const blocked = look().blockerFor(name, merged);
      result = await act({ skill: name, args: merged, blocked, index: calls, ...pending });
      pending = { thought: "", latencyMs: 0, cost: 0 }; // shown once, on the step it led to
      if (!blocked) calls++;
      const left = maxCalls - calls;
      reply(`${blocked ? `not run: ${blocked}` : `${result.ok ? "succeeded" : "failed"}: ${result.text}`}\n\n${stateText(look(), left)}`
        + (left <= 0 ? "\nNo skill calls left: call recovered now." : ""));
    }
  }
  return { summary: `ran out of its budget (${calls} skill calls, ${requests} requests) without declaring the situation recovered`, recovered: false, calls, requests, cost, thought: "" };
}
