// Agent panel (right edge): pick a task, Start / Stop, optional OpenRouter
// key, and the live step trace from src/agent/harness.js - what the duck
// saw, which tools were on offer, what System One picked (with every
// option's probability) and how the step turned out.
import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import { useGame } from "../store.js";
import { TASKS, runAgent, stopAgent } from "../agent/harness.js";
import { getApiKey, setApiKey } from "../agent/system-one.js";
import { TOOLS } from "../agent/tools.js";
import { ORANGE, MONO } from "../theme.js";
import { ANTON, CREAM, COMIC_INK } from "./comic.jsx";

const STATUS_TEXT = {
  idle: "",
  running: "RUNNING…",
  scored: "GOAL ✅",
  failed: "OUT OF STEPS ❌",
  stopped: "STOPPED",
  error: "ERROR",
};

const labelOf = (name) => TOOLS[name]?.label ?? name;

const btn = {
  fontFamily: ANTON, fontSize: "0.85rem", letterSpacing: "0.04em",
  padding: "4px 12px", border: `2px solid ${COMIC_INK}`, cursor: "pointer",
  boxShadow: `2px 2px 0 ${COMIC_INK}`,
};

function ProbBars({ probabilities, choice }) {
  const rows = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return rows.map(([name, p]) => (
    <Box key={name} sx={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.68rem" }}>
      <Box sx={{ width: 120, color: name === choice ? ORANGE : "rgba(255,255,255,0.6)" }}>{labelOf(name)}</Box>
      <Box sx={{ flex: 1, height: 6, background: "rgba(255,255,255,0.1)" }}>
        <Box sx={{ width: `${Math.round(p * 100)}%`, height: "100%", background: name === choice ? ORANGE : "rgba(255,255,255,0.35)" }} />
      </Box>
      <Box sx={{ width: 30, textAlign: "right" }}>{p.toFixed(2)}</Box>
    </Box>
  ));
}

function Step({ step }) {
  return (
    <Box sx={{ borderTop: "1px solid rgba(255,255,255,0.12)", py: "8px" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem" }}>
        <span>#{step.n} → <b style={{ color: ORANGE }}>{labelOf(step.choice)}</b></span>
        <span style={{ opacity: 0.5 }}>{step.latencyMs} ms</span>
      </Box>
      <Box sx={{ fontSize: "0.66rem", opacity: 0.6, my: "4px" }}>
        ball {step.observation.ball} · goal {step.observation.goal}
      </Box>
      <ProbBars probabilities={step.probabilities} choice={step.choice} />
      <Box sx={{ fontSize: "0.7rem", mt: "4px", color: step.result ? CREAM : "rgba(255,255,255,0.4)" }}>
        {step.result ?? "running…"}
      </Box>
    </Box>
  );
}

export default function AgentPanel() {
  const menuOpen = useGame((s) => s.menuOpen);
  const bootDone = useGame((s) => s.bootDone);
  const { status, steps, error } = useGame((s) => s.agent);
  const [task, setTask] = useState("penalty");
  const [key, setKey] = useState(getApiKey);
  const listRef = useRef(null);

  // Keep the newest step in view.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [steps]);

  if (menuOpen || !bootDone) return null;
  const running = status === "running";

  return (
    <Box sx={{
      position: "fixed", top: "5rem", right: "1.5rem", zIndex: 10, width: 330,
      maxHeight: "calc(100vh - 10rem)", display: "flex", flexDirection: "column",
      border: `3px solid ${CREAM}`, background: "rgba(8,8,12,0.82)", backdropFilter: "blur(6px)",
      color: CREAM, fontFamily: MONO, p: "12px",
    }}>
      <Box sx={{ fontFamily: ANTON, fontSize: "1.1rem", letterSpacing: "0.05em", mb: "8px" }}>
        AGENT · SYSTEM ONE
      </Box>

      <Box sx={{ display: "flex", gap: "8px", alignItems: "center", mb: "8px" }}>
        <select value={task} disabled={running} onChange={(e) => setTask(e.target.value)}
          style={{ flex: 1, fontFamily: MONO, background: COMIC_INK, color: CREAM, border: `1px solid ${CREAM}`, padding: "4px" }}>
          {Object.entries(TASKS).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
        </select>
        {running
          ? <button style={{ ...btn, background: CREAM }} onClick={stopAgent}>STOP</button>
          : <button style={{ ...btn, background: ORANGE }} onClick={() => runAgent(task)}>START</button>}
      </Box>

      <input type="password" placeholder="OpenRouter key (optional, stays in this browser)"
        value={key} onChange={(e) => { setKey(e.target.value); setApiKey(e.target.value.trim()); }}
        style={{ fontFamily: MONO, fontSize: "0.68rem", background: "transparent", color: CREAM,
          border: "1px solid rgba(255,255,255,0.25)", padding: "4px", marginBottom: "8px" }} />

      <Box sx={{ fontFamily: ANTON, fontSize: "1rem", color: status === "scored" ? ORANGE : CREAM }}>
        {STATUS_TEXT[status]}
      </Box>
      {error && <Box sx={{ fontSize: "0.7rem", color: "#ff6b6b" }}>{error}</Box>}

      <Box ref={listRef} sx={{ overflowY: "auto", mt: "6px" }}>
        {steps.map((s) => <Step key={s.n} step={s} />)}
      </Box>
    </Box>
  );
}
