// Agent panel (right edge): task picker, run controls, run summary and the
// step-by-step trace from src/agent/harness.js. Each step card shows what
// the duck saw, every tool with System One's probability (tools that
// weren't possible greyed out with the reason), and how the step ended.
import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import { keyframes } from "@mui/material/styles";
import { useGame } from "../store.js";
import {
  TASKS, startAgent, pauseAgent, stopAgent, restartAgent, resetField,
} from "../agent/harness.js";
import { getApiKey, setApiKey } from "../agent/system-one.js";
import { TOOLS } from "../agent/tools.js";
import { ORANGE, MONO } from "../theme.js";
import { ANTON, CREAM, COMIC_INK } from "./comic.jsx";

const OK = "#3ddc84";
const BAD = "#ff6b6b";
const DIM = "rgba(250,248,242,0.5)";
const FAINT = "rgba(250,248,242,0.14)";

const labelOf = (name) => TOOLS[name]?.label ?? name;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const pulse = keyframes`0%, 100% { opacity: 1 } 50% { opacity: 0.35 }`;

const STATUS = {
  idle: { text: "Ready", color: DIM },
  running: { text: "Running", color: ORANGE, live: true },
  paused: { text: "Paused", color: CREAM },
  scored: { text: "Goal", color: OK },
  failed: { text: "Out of steps", color: BAD },
  stopped: { text: "Stopped", color: DIM },
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

function Controls({ status, paused, task }) {
  if (status === "idle") {
    return <Button primary onClick={() => startAgent(task)}>▶ START</Button>;
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
      <Button onClick={resetField}>⟲ RESET FIELD</Button>
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

function Summary({ agent }) {
  const { steps, startedAt, endedAt, status } = agent;
  useTicker(status === "running");
  if (!startedAt) return null;
  const decided = steps.filter((s) => s.latencyMs != null);
  const avgThink = decided.length ? Math.round(decided.reduce((a, s) => a + s.latencyMs, 0) / decided.length) : 0;
  const cost = steps.reduce((a, s) => a + (s.cost ?? 0), 0);
  return (
    <Box sx={{ display: "flex", gap: "6px", mb: "10px" }}>
      <Stat label="Steps" value={steps.length} />
      <Stat label="Time" value={secs((endedAt ?? performance.now()) - startedAt)} />
      <Stat label="Avg think" value={`${avgThink} ms`} />
      <Stat label="Cost" value={`$${cost.toFixed(5)}`} />
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

function ToolRow({ name, p, chosen, reason }) {
  const blocked = reason != null;
  return (
    <Box title={reason ?? ""} sx={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.64rem", opacity: blocked ? 0.38 : 1, mb: "2px" }}>
      <Box sx={{ width: 118, color: chosen ? ORANGE : CREAM, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {labelOf(name)}
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
  const facing = step.observation.facing_goal.startsWith("yes");
  const badge = step.ok == null ? null : step.ok ? { t: "✓", c: OK } : { t: "✗", c: BAD };
  const rows = [
    ...step.available.map((name) => ({ name, p: step.probabilities[name] ?? 0 })).sort((a, b) => b.p - a.p),
    ...Object.entries(step.blocked).map(([name, reason]) => ({ name, reason })),
  ];
  return (
    <Box sx={{ border: `1px solid ${live ? ORANGE : FAINT}`, p: "8px 10px", mb: "8px" }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
        <Box sx={{ fontSize: "0.62rem", color: DIM }}>{String(step.n).padStart(2, "0")}</Box>
        <Box sx={{ fontFamily: ANTON, fontSize: "1rem", letterSpacing: "0.03em", flex: 1 }}>{labelOf(step.choice)}</Box>
        {badge ? <Box sx={{ color: badge.c, fontSize: "0.9rem" }}>{badge.t}</Box>
          : <Box sx={{ width: 7, height: 7, borderRadius: "50%", background: ORANGE, animation: `${pulse} 0.9s ease-in-out infinite` }} />}
      </Box>
      <Box sx={{ fontSize: "0.58rem", color: DIM, mb: "6px" }}>
        think {step.latencyMs} ms{step.actMs != null && <> · act {secs(step.actMs)}</>}
      </Box>
      <Box sx={{ mb: "4px" }}>
        <Chip>ball {step.observation.ball}</Chip>
        <Chip good={facing}>{facing ? "facing goal" : "not facing goal"}</Chip>
      </Box>
      {rows.map((r) => (
        <ToolRow key={r.name} name={r.name} p={r.p} reason={r.reason} chosen={r.name === step.choice} />
      ))}
      <Box sx={{ fontSize: "0.66rem", mt: "6px", color: step.result ? (step.ok ? OK : BAD) : DIM }}>
        → {step.result ?? "running…"}
      </Box>
    </Box>
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
        <Box sx={{ fontFamily: ANTON, fontSize: "1.1rem", letterSpacing: "0.05em" }}>AGENT · SYSTEM ONE</Box>
        <StatusPill status={status} paused={paused} />
      </Box>

      <Box component="select" value={task} disabled={status === "running"} onChange={(e) => setTask(e.target.value)} sx={{
        fontFamily: MONO, fontSize: "0.75rem", background: COMIC_INK, color: CREAM,
        border: `1px solid ${FAINT}`, p: "5px", mb: "8px",
      }}>
        {Object.entries(TASKS).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
      </Box>

      <Box sx={{ display: "flex", gap: "6px", mb: "8px" }}>
        <Controls status={status} paused={paused} task={task} />
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

      <Summary agent={agent} />
      {error && <Box sx={{ fontSize: "0.7rem", color: BAD, mb: "8px" }}>{error}</Box>}

      <Box ref={listRef} sx={{ overflowY: "auto", pr: "2px" }}>
        {steps.map((s, i) => (
          <StepCard key={s.n} step={s} live={status === "running" && i === steps.length - 1} />
        ))}
      </Box>
    </Box>
  );
}
