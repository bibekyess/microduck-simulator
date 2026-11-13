// System One (OpenRouter Decisions API, model Jev): one call per agent
// step. We send the state and one `choice` question whose options are the
// tools available right now; Jev returns the picked tool plus a
// probability for every option.
//
// Key handling: a key pasted in the agent panel is kept in this browser
// (localStorage) and sent straight to openrouter.ai. Without one, requests
// go to the dev server's /api/s1 proxy, which adds the key from app/.env
// (vite.config.js) so it never reaches the bundle.

const DIRECT_URL = "https://openrouter.ai/api/alpha/decisions";
const PROXY_URL = "/api/s1";
const MODEL = "typesafe/jev-1.13";
const KEY_STORAGE = "microduck.openrouterKey";

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* storage blocked: key just isn't remembered */ }
}

// tools: { option label: description } for the options on offer this step.
// Returns { choice, probabilities, confidence, latencyMs, cost }.
export async function decide(state, tools) {
  const key = getApiKey();
  const t0 = performance.now();
  const res = await fetch(key ? DIRECT_URL : PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key && { Authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify({
      model: MODEL,
      state,
      questions: {
        next_action: {
          type: "choice",
          instructions: "Which single action should the duck take next to make progress on the goal?",
          criteria: tools,
        },
      },
    }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`System One ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const answer = json.answers.next_action;
  return {
    choice: answer.choice,
    probabilities: answer.probabilities ?? {},
    confidence: answer.confidence,
    latencyMs,
    cost: json.usage?.cost,
  };
}
