// Single JSON logger: one wide event per API request (logging-best-practices).
// Handlers add business context via c.set("logCtx", {...}) — merged at emit.
export function logEvent(level: "info" | "error", event: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const newReqId = () => Math.random().toString(36).slice(2, 10);
