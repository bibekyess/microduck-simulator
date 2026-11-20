// Agent panel (right edge): task picker, run controls, run summary and the
// step-by-step trace from src/agent/harness.js. Each step card says who
// decided it (Jev or the LLM). Jev's cards show every skill option with
// its probability (options that weren't possible greyed out with the
// reason); the LLM's show why it was called, its reasoning and the call
// with its args, and each recovery ends on a hand-back card. A finished run
// can be exported as JSON for offline replay (replay.js).
import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import { keyframes } from "@mui/material/styles";
import { useGame } from "../store.js";
import {
  TASKS, startAgent, pauseAgent, stopAgent, restartAgent, resetField,
} from "../agent/harness.js";
import { getApiKey, setApiKey } from "../agent/system-one.js";
import { getLlmConfig, setLlmConfig } from "../agent/react.js";
import { exportRun } from "../agent/replay.js";
import { ORANGE, MONO } from "../theme.js";
import { ANTON, CREAM, COMIC_INK } from "./comic.jsx";

const OK = "#3ddc84";
const BAD = "#ff6b6b";
const DIM = "rgba(250,248,242,0.5)";
const FAINT = "rgba(250,248,242,0.14)";
const LLM = "#9b8cff"; // the LLM's colour, Jev keeps ORANGE

const titleOf = (step) => step.options.find((o) => o.label === step.choice)?.title ?? step.choice;
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, x) => a + x, 0) / xs.length) : 0);
const sum = (xs) => xs.reduce((a, x) => a + (x ?? 0), 0);
// "approach · foot: left", or just the skill when it takes no args.
const callOf = ({ skill, args }) => [skill, Object.entries(args ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")]
  .filter(Boolean).join(" · ");
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const pulse = keyframes`0%, 100% { opacity: 1 } 50% { opacity: 0.35 }`;

const STATUS = {
  idle: { text: "Ready", color: DIM },
  running: { text: "Running", color: ORANGE, live: true },
  paused: { text: "Paused", color: CREAM },
  scored: { text: "Goal", color: OK },
  failed: { text: "Out of steps", color: BAD },
  stopped: { text: "Stopped", color: DIM },
  stuck: { text: "Stuck", color: BAD },
  error: { text: "Error", color: BAD },
};

// Re-render every `ms` while `on` (live elapsed time).
function useTicker(on, ms = 250) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [on, ms]);
}

function Button({ children, onClick, primary }) {
  return (
    <Box component="button" onClick={onClick} sx={{
      flex: 1, fontFamily: ANTON, fontSize: "0.82rem", letterSpacing: "0.06em", py: "6px",
      cursor: "pointer", border: `2px solid ${primary ? ORANGE : CREAM}`,
      background: primary ? ORANGE : "transparent", color: primary ? COMIC_INK : CREAM,
      "&:hover": { background: primary ? "#ff8d4d" : "rgba(250,248,242,0.1)" },
    }}>
      {children}
    </Box>
  );
}

function StatusPill({ status, paused }) {
  const s = STATUS[paused ? "paused" : status];
  return (
    <Box sx={{
      display: "flex", alignItems: "center", gap: "6px", px: "8px", py: "2px",
      border: `1px solid ${s.color}`, color: s.color, fontSize: "0.62rem",
      letterSpacing: "0.12em", textTransform: "uppercase",
    }}>
      <Box sx={{
        width: 6, height: 6, borderRadius: "50%", background: s.color,
        animation: s.live ? `${pulse} 0.9s ease-in-out infinite` : "none",
      }} />
      {s.text}
    </Box>
  );
}

// Save the run's full trace as microduck-run-<timestamp>.json.
function downloadRun(agent) {
  const url = URL.createObjectURL(new Blob([exportRun(agent, agent.task)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `microduck-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function Controls({ agent, task }) {
  const { status, paused } = agent;
  if (status === "idle") {
    return <Button primary onClick={() => startAgent(task, false)}>▶ START</Button>;
  }
  if (status === "running") {
    return (
      <>
        <Button primary onClick={() => pauseAgent(!paused)}>{paused ? "▶ RESUME" : "❚❚ PAUSE"}</Button>
        <Button onClick={stopAgent}>■ STOP</Button>
        <Button onClick={() => restartAgent(task)}>↻ RESTART</Button>
      </>
    );
  }
  return (
    <>
      <Button primary onClick={() => startAgent(task)}>↻ RUN AGAIN</Button>
      <Button onClick={() => resetField(task)}>⟲ RESET FIELD</Button>
      <Button onClick={() => downloadRun(agent)}>⇩ EXPORT RUN</Button>
    </>
  );
}

function Stat({ label, value }) {
  return (
    <Box sx={{ flex: 1, border: `1px solid ${FAINT}`, p: "6px 8px" }}>
      <Box sx={{ fontSize: "0.56rem", letterSpacing: "0.12em", color: DIM, textTransform: "uppercase" }}>{label}</Box>
      <Box sx={{ fontSize: "0.9rem", mt: "2px" }}>{value}</Box>
    </Box>
  );
}

// Run totals, with think time and cost split by decider.
function Summary({ agent }) {
  const { steps, startedAt, endedAt, status } = agent;
  useTicker(status === "running");
  if (!startedAt) return null;
  const jev = steps.filter((s) => s.decidedBy === "jev" && s.latencyMs != null);
  const llmSteps = steps.filter((s) => s.decidedBy === "llm");
  const llmThink = llmSteps.filter((s) => s.latencyMs);
  const recoveries = steps.filter((s) => s.kind === "handback").length;
  const skillSteps = steps.filter((s) => s.skill).length;
  return (
    <>
      <Box sx={{ display: "flex", gap: "6px", mb: "6px" }}>
        <Stat label="Steps" value={skillSteps} />
        <Stat label="Time" value={secs((endedAt ?? performance.now()) - startedAt)} />
        <Stat label="Cost" value={`$${sum(steps.map((s) => s.cost)).toFixed(5)}`} />
      </Box>
      <Box sx={{ display: "flex", gap: "6px", mb: "10px" }}>
        <Stat label="Jev" value={<Box component="span" sx={{ color: ORANGE }}>{jev.length} · {avg(jev.map((s) => s.latencyMs))} ms · ${sum(jev.map((s) => s.cost)).toFixed(5)}</Box>} />
        <Stat label="LLM" value={<Box component="span" sx={{ color: LLM }}>{recoveries} rec · {avg(llmThink.map((s) => s.latencyMs))} ms · ${sum(llmSteps.map((s) => s.cost)).toFixed(4)}</Box>} />
      </Box>
    </>
  );
}

function DeciderBadge({ by }) {
  const c = by === "llm" ? LLM : ORANGE;
  return (
    <Box component="span" sx={{ fontSize: "0.56rem", letterSpacing: "0.1em", px: "5px", py: "1px", border: `1px solid ${c}`, color: c, textTransform: "uppercase" }}>
      {by === "llm" ? "LLM" : "Jev"}
    </Box>
  );
}

// The LLM's reasoning (and why it was called, on a recovery's first card).
function LlmNotes({ step }) {
  return (
    <>
      {step.why && (
        <Box sx={{ fontSize: "0.62rem", color: DIM, mb: "4px" }}>
          <Box component="span" sx={{ color: LLM }}>escalated:</Box> {step.why}
        </Box>
      )}
      {step.thought && (
        <Box sx={{ fontSize: "0.66rem", fontStyle: "italic", borderLeft: `2px solid ${LLM}`, pl: "6px", mb: "6px", whiteSpace: "pre-wrap" }}>
          {step.thought}
        </Box>
      )}
    </>
  );
}

// End of an LLM recovery: its summary, which Jev reads next.
function HandbackCard({ step }) {
  return (
    <Box sx={{ border: `1px dashed ${LLM}`, p: "8px 10px", mb: "8px" }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: "8px", mb: "4px" }}>
        <DeciderBadge by="llm" />
        <Box sx={{ fontFamily: ANTON, fontSize: "0.95rem", flex: 1 }}>
          {step.recovered ? "Recovered · back to Jev" : "Hand-back · back to Jev"}
        </Box>
        <Box sx={{ fontSize: "0.58rem", color: DIM }}>
          {step.calls ?? 0} skill{step.calls === 1 ? "" : "s"} · {step.requests ?? 0} req
        </Box>
      </Box>
      <LlmNotes step={step} />
      <Box sx={{ fontSize: "0.66rem", color: step.recovered ? OK : BAD }}>→ {step.summary}</Box>
    </Box>
  );
}

function Chip({ children, good }) {
  const color = good === true ? OK : good === false ? BAD : DIM;
  return (
    <Box component="span" sx={{
      display: "inline-block", fontSize: "0.6rem", px: "5px", py: "1px", mr: "4px", mb: "4px",
      border: `1px solid ${good === undefined ? FAINT : color}`, color,
    }}>
      {children}
    </Box>
  );
}

function OptionRow({ title, p, chosen, reason }) {
  const blocked = reason != null;
  return (
    <Box title={reason ?? ""} sx={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.64rem", opacity: blocked ? 0.38 : 1, mb: "2px" }}>
      <Box sx={{ width: 118, color: chosen ? ORANGE : CREAM, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {title}
      </Box>
      {blocked ? (
        <Box sx={{ flex: 1, fontStyle: "italic", color: DIM, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {reason}
        </Box>
      ) : (
        <>
          <Box sx={{ flex: 1, height: 5, background: FAINT }}>
            <Box sx={{ width: `${Math.round(p * 100)}%`, height: "100%", background: chosen ? ORANGE : "rgba(250,248,242,0.4)" }} />
          </Box>
          <Box sx={{ width: 28, textAlign: "right" }}>{p.toFixed(2)}</Box>
        </>
      )}
    </Box>
  );
}

function StepCard({ step, live }) {
  if (step.kind === "handback") return <HandbackCard step={step} />;
  const llm = step.decidedBy === "llm";
  const facing = step.observation.facing_goal?.startsWith("yes");
  const badge = step.ok == null ? null : step.ok ? { t: "✓", c: OK } : { t: "✗", c: BAD };
  const open = step.options.filter((o) => !o.blocked);
  const rows = [
    ...open.map((o) => ({ ...o, p: step.probabilities?.[o.label] ?? 0 })).sort((a, b) => b.p - a.p),
    ...step.options.filter((o) => o.blocked),
  ];
  return (
    <Box sx={{ border: `1px solid ${live ? (llm ? LLM : ORANGE) : FAINT}`, p: "8px 10px", mb: "8px" }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
        <Box sx={{ fontSize: "0.62rem", color: DIM }}>{String(step.n).padStart(2, "0")}</Box>
        <DeciderBadge by={step.decidedBy} />
        <Box sx={{ fontFamily: ANTON, fontSize: "1rem", letterSpacing: "0.03em", flex: 1 }}>{titleOf(step)}</Box>
        {badge ? <Box sx={{ color: badge.c, fontSize: "0.9rem" }}>{badge.t}</Box>
          : <Box sx={{ width: 7, height: 7, borderRadius: "50%", background: ORANGE, animation: `${pulse} 0.9s ease-in-out infinite` }} />}
      </Box>
      <Box sx={{ fontSize: "0.58rem", color: DIM, mb: "6px" }}>
        {step.kind === "think" ? "hand over to the LLM" : callOf(step)}
        {step.latencyMs ? <> · think {step.latencyMs} ms</> : null}{step.actMs != null && <> · act {secs(step.actMs)}</>}
      </Box>
      {llm && <LlmNotes step={step} />}
      <Box sx={{ mb: "4px" }}>
        <Chip>ball {step.observation.ball}</Chip>
        <Chip good={facing}>{facing ? "facing goal" : "not facing goal"}</Chip>
      </Box>
      {!llm && rows.map((r) => (
        <OptionRow key={r.label} title={r.title} p={r.p} reason={r.blocked} chosen={r.label === step.choice} />
      ))}
      <Box sx={{ fontSize: "0.66rem", mt: "6px", color: step.result ? (step.ok ? OK : BAD) : DIM }}>
        → {step.result ?? "running…"}
      </Box>
    </Box>
  );
}

// ReAct LLM endpoint (react.js), kept in this browser. Read at run start.
function LlmSettings({ disabled }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState(getLlmConfig);
  const set = (patch) => { const next = { ...cfg, ...patch }; setCfg(next); setLlmConfig(next); };
  let headersOk = true;
  try { if (cfg.headers.trim()) JSON.parse(cfg.headers); } catch { headersOk = false; }
  const field = { fontFamily: MONO, fontSize: "0.66rem", background: "transparent", color: CREAM, border: `1px solid ${FAINT}`, p: "4px 5px", mb: "5px", width: "100%", boxSizing: "border-box" };
  return (
    <>
      <Box component="button" onClick={() => setOpen((v) => !v)} sx={{
        alignSelf: "flex-start", background: "none", border: "none", color: DIM, cursor: "pointer",
        fontFamily: MONO, fontSize: "0.6rem", p: 0, mb: "8px",
      }}>
        {open ? "▾" : "▸"} LLM recovery {cfg.enabled ? `on · ${cfg.model}` : "off"}
      </Box>
      {open && (
        <Box component="fieldset" disabled={disabled} sx={{ border: `1px solid ${FAINT}`, p: "6px 8px", m: 0, mb: "10px", fontSize: "0.6rem", color: DIM }}>
          <Box component="label" sx={{ display: "flex", alignItems: "center", gap: "6px", mb: "6px", color: CREAM }}>
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            escalate to the LLM after a failure or when Jev asks (2 per run, 3 skills each)
          </Box>
          base URL (empty = dev proxy to OpenRouter)
          <Box component="input" value={cfg.baseUrl} placeholder="https://openrouter.ai/api/v1" onChange={(e) => set({ baseUrl: e.target.value })} sx={field} />
          model
          <Box component="input" value={cfg.model} onChange={(e) => set({ model: e.target.value })} sx={field} />
          API key (direct calls only; stays in this browser)
          <Box component="input" type="password" value={cfg.apiKey} onChange={(e) => set({ apiKey: e.target.value.trim() })} sx={field} />
          custom headers (JSON){!headersOk && <Box component="span" sx={{ color: BAD }}> · not valid JSON</Box>}
          <Box component="input" value={cfg.headers} placeholder='{"X-Title": "Microduck"}' onChange={(e) => set({ headers: e.target.value })} sx={field} />
        </Box>
      )}
    </>
  );
}

export default function AgentPanel() {
  const menuOpen = useGame((s) => s.menuOpen);
  const bootDone = useGame((s) => s.bootDone);
  const agent = useGame((s) => s.agent);
  const [task, setTask] = useState("penalty");
  const [key, setKey] = useState(getApiKey);
  const [showKey, setShowKey] = useState(false);
  const listRef = useRef(null);

  // Keep the newest step in view.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [agent.steps]);

  if (menuOpen || !bootDone) return null;
  const { status, paused, steps, error } = agent;

  return (
    <Box sx={{
      position: "fixed", top: "5rem", right: "1.5rem", zIndex: 10, width: 360,
      maxHeight: "calc(100vh - 7rem)", display: "flex", flexDirection: "column",
      border: `2px solid ${CREAM}`, background: "rgba(8,8,12,0.86)", backdropFilter: "blur(6px)",
      color: CREAM, fontFamily: MONO, p: "12px",
    }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: "10px" }}>
        <Box sx={{ fontFamily: ANTON, fontSize: "1.1rem", letterSpacing: "0.05em" }}>AGENT · JEV + LLM</Box>
        <StatusPill status={status} paused={paused} />
      </Box>

      <Box component="select" value={task} disabled={status === "running"} onChange={(e) => setTask(e.target.value)} sx={{
        fontFamily: MONO, fontSize: "0.75rem", background: COMIC_INK, color: CREAM,
        border: `1px solid ${FAINT}`, p: "5px", mb: "8px",
      }}>
        {Object.entries(TASKS).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
      </Box>

      <Box sx={{ display: "flex", gap: "6px", mb: "8px" }}>
        <Controls agent={agent} task={task} />
      </Box>

      <Box component="button" onClick={() => setShowKey((v) => !v)} sx={{
        alignSelf: "flex-start", background: "none", border: "none", color: DIM, cursor: "pointer",
        fontFamily: MONO, fontSize: "0.6rem", p: 0, mb: "8px",
      }}>
        {showKey ? "▾" : "▸"} OpenRouter key {key ? "(set)" : "(optional, uses dev proxy)"}
      </Box>
      {showKey && (
        <Box component="input" type="password" placeholder="sk-or-… stays in this browser" value={key}
          onChange={(e) => { setKey(e.target.value); setApiKey(e.target.value.trim()); }}
          sx={{
            fontFamily: MONO, fontSize: "0.68rem", background: "transparent", color: CREAM,
            border: `1px solid ${FAINT}`, p: "5px", mb: "10px",
          }} />
      )}

      <LlmSettings disabled={status === "running"} />

      <Summary agent={agent} />
      {error && <Box sx={{ fontSize: "0.7rem", color: BAD, mb: "8px" }}>{error}</Box>}

      <Box ref={listRef} sx={{ overflowY: "auto", pr: "2px" }}>
        {steps.map((s, i) => (
          <StepCard key={i} step={s} live={status === "running" && i === steps.length - 1} />
        ))}
      </Box>
    </Box>
  );
}
