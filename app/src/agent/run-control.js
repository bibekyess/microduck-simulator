// Pause / end for an agent run, shared by the harness loop and the tools'
// control loops. Both call checkpoint() between ticks: it waits while the
// run is paused and throws RunEnded once the run has been ended (Stop, or
// the harness's goal watcher), so the end takes effect mid-tool instead of
// after it.

export class RunEnded extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason; // "stopped" | "scored"
  }
}

const control = { paused: false, ended: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resetControl() {
  control.paused = false;
  control.ended = null;
}

export function setPaused(paused) {
  control.paused = paused;
}

// First reason wins: a goal scored just before a Stop stays a goal.
export function endRun(reason) {
  control.ended ??= reason;
}

// Returns how long it waited (ms), so timeouts can skip paused time.
export async function checkpoint(onPause) {
  let waited = 0;
  if (control.paused) onPause?.();
  while (control.paused && !control.ended) {
    await sleep(100);
    waited += 100;
  }
  if (control.ended) throw new RunEnded(control.ended);
  return waited;
}
