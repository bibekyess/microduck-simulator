// Agent decision strip (bottom centre): the at-a-glance view of the agent
// loop while it runs - which phase it is in (observe -> decide -> act),
// what System One just picked and how sure it was, and the trail of
// earlier decisions. The AgentPanel on the right holds the full trace.
import Box from "@mui/material/Box";
import { keyframes } from "@mui/material/styles";
import { useGame } from "../store.js";
import { ORANGE, MONO } from "../theme.js";
import { ANTON, CREAM } from "./comic.jsx";

const PHASES = [
  { id: "observe", label: "Observe" },
  { id: "decide", label: "Decide" },
  { id: "act", label: "Act" },
];

const pulse = keyframes`0%, 100% { opacity: 1 } 50% { opacity: 0.35 }`;
// Slide only (no opacity): if animations are throttled the text still shows.
const pop = keyframes`from { transform: translateY(6px) } to { transform: none }`;

// An option label's title as offered in that step.
const titleOf = (step, label) => step.options.find((o) => o.label === label)?.title ?? label;
const DIM = "rgba(250,248,242,0.45)";

function PhaseRail({ phase }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: "6px" }}>
      {PHASES.map((p, i) => {
        const on = p.id === phase;
        return (
          <Box key={p.id} sx={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {i > 0 && <Box sx={{ width: 14, height: "1px", background: DIM }} />}
            <Box sx={{
              display: "flex", alignItems: "center", gap: "5px", px: "7px", py: "2px",
              border: `1px solid ${on ? ORANGE : "rgba(250,248,242,0.25)"}`,
              color: on ? ORANGE : DIM, fontSize: "0.64rem", letterSpacing: "0.12em", textTransform: "uppercase",
            }}>
              <Box sx={{
                width: 6, height: 6, borderRadius: "50%", background: on ? ORANGE : "transparent",
                border: on ? "none" : `1px solid ${DIM}`, animation: on ? `${pulse} 0.9s ease-in-out infinite` : "none",
              }} />
              {p.label}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// Headline: the decision being acted on, or what the agent is doing now.
function Headline({ status, paused, phase, last, steps }) {
  const tail = steps[steps.length - 1];
  if (status === "scored") {
    return <Box sx={{ fontFamily: ANTON, fontSize: "1.9rem", color: ORANGE }}>GOAL! · {steps.filter((s) => s.skill).length} steps</Box>;
  }
  if (status !== "running") {
    const text = { failed: "Out of steps", stopped: "Stopped", error: "Error", stuck: "Stuck" }[status];
    return <Box sx={{ fontFamily: ANTON, fontSize: "1.5rem", color: CREAM }}>{text}</Box>;
  }
  if (paused) {
    return <Box sx={{ fontFamily: ANTON, fontSize: "1.5rem", color: CREAM }}>Paused</Box>;
  }
  if (phase !== "act" || !last) {
    return (
      <Box sx={{ fontFamily: ANTON, fontSize: "1.5rem", color: DIM }}>
        {phase === "decide" ? (tail?.decidedBy === "llm" || tail?.kind === "think" ? "The LLM is thinking…" : "System One is choosing…") : "Reading the field…"}
      </Box>
    );
  }
  if (last.decidedBy === "llm") {
    return (
      <Box key={last.n} sx={{ animation: `${pop} 0.25s ease-out` }}>
        <Box sx={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
          <Box sx={{ fontFamily: ANTON, fontSize: "1.9rem", color: CREAM, lineHeight: 1.1 }}>{titleOf(last, last.choice)}</Box>
          <Box sx={{ color: "#9b8cff", fontSize: "0.9rem" }}>LLM</Box>
        </Box>
        <Box sx={{ fontSize: "0.68rem", color: DIM, mt: "6px" }}>
          {Object.entries(last.args ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ")}{last.latencyMs ? ` · ${last.latencyMs} ms` : ""}
        </Box>
      </Box>
    );
  }
  const alt = Object.entries(last.probabilities ?? {})
    .filter(([n]) => n !== last.choice).sort((a, b) => b[1] - a[1])[0];
  const p = last.probabilities?.[last.choice] ?? last.confidence ?? 0;
  const open = last.options.filter((o) => !o.blocked).length;
  return (
    <Box key={last.n} sx={{ animation: `${pop} 0.25s ease-out` }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
        <Box sx={{ fontFamily: ANTON, fontSize: "1.9rem", color: CREAM, lineHeight: 1.1 }}>{titleOf(last, last.choice)}</Box>
        <Box sx={{ color: ORANGE, fontSize: "0.9rem" }}>{Math.round(p * 100)}%</Box>
      </Box>
      <Box sx={{ height: 3, background: "rgba(250,248,242,0.12)", my: "6px" }}>
        <Box sx={{ width: `${Math.round(p * 100)}%`, height: "100%", background: ORANGE, transition: "width 0.3s" }} />
      </Box>
      <Box sx={{ fontSize: "0.68rem", color: DIM }}>
        chosen from {open} option{open > 1 ? "s" : ""}
        {alt && <> · runner-up {titleOf(last, alt[0])} {Math.round(alt[1] * 100)}%</>}
        {" · "}{last.latencyMs} ms
      </Box>
    </Box>
  );
}

export default function AgentTicker() {
  const menuOpen = useGame((s) => s.menuOpen);
  const { status, paused, phase, steps } = useGame((s) => s.agent);
  if (menuOpen || status === "idle") return null;
  const skillSteps = steps.filter((s) => s.skill);
  const last = skillSteps[skillSteps.length - 1];
  const trail = skillSteps.slice(-7, phase === "act" ? -1 : undefined);

  return (
    <Box sx={{
      position: "fixed", bottom: "1.5rem", left: "50%", transform: "translateX(-50%)", zIndex: 10,
      width: "min(560px, calc(100vw - 32px))", p: "12px 16px",
      background: "rgba(8,8,12,0.85)", backdropFilter: "blur(6px)",
      border: `2px solid ${status === "scored" ? ORANGE : CREAM}`, color: CREAM, fontFamily: MONO,
    }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: "8px" }}>
        <PhaseRail phase={status === "running" && !paused ? phase : null} />
        <Box sx={{ fontSize: "0.64rem", letterSpacing: "0.12em", color: DIM }}>
          STEP {skillSteps.length}
        </Box>
      </Box>
      <Headline status={status} paused={paused} phase={phase} last={last} steps={steps} />
      {trail.length > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: "4px", mt: "10px" }}>
          {trail.map((s) => (
            <Box key={s.n} title={`${s.decidedBy === "llm" ? "[LLM] " : ""}${s.result ?? ""}`} sx={{
              fontSize: "0.62rem", px: "6px", py: "2px", color: DIM,
              border: `1px solid ${s.ok === false ? "rgba(255,107,107,0.6)" : s.ok ? "rgba(61,220,132,0.6)" : "rgba(250,248,242,0.2)"}`,
            }}>
              {s.ok === false ? "✗" : "✓"} {s.n}. {titleOf(s, s.choice)}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
