/**
 * Phosphene's boot tab — declared in `objectiveai.json` as `viewer.tabs[0]`.
 *
 * ARCHITECTURE. The viewer half is a DISPLAY, not the application. It spawns
 * work as agent completions through the daemon and renders what the agent is
 * doing; it never reaches an upstream itself. See HANDOFF §"ARCHITECTURE
 * CHANGED".
 *
 * Two host contracts this file lives under (docs/platform/01-viewer.md):
 *   1. It receives ONE prop, `arguments`, and a manifest-declared boot tab is
 *      always opened with none — so at boot it is undefined. (`arguments` is a
 *      reserved binding in strict mode; destructure it under another name.)
 *   2. Everything else comes from the harness: the daemon transport and the
 *      window's zoom. No theme, no router, no host state.
 *
 * It renders inside a document already carrying the viewer's own `app.css`.
 * We consume the viewer's `@theme` tokens where they mean the same thing to us,
 * but never its Tailwind utility classes — those exist only because the viewer
 * happens to use them today (spikes/01-calibration §C).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Client, functionsListExecute } from "@objectiveai/sdk";
import { transport } from "./transport";
import { inventDirections, type Direction, type Invention } from "./lib/directions";

interface TabProps {
  arguments?: unknown;
}

type Health =
  | { state: "connecting" }
  | { state: "ready"; roundTripMs: number }
  | { state: "unavailable"; reason: string };

type Run =
  | { phase: "idle" }
  | { phase: "inventing"; brief: string; aih?: string; streamed: number }
  | { phase: "done"; brief: string; invention: Invention }
  | { phase: "failed"; brief: string; reason: string };

/**
 * Prove the daemon is REACHABLE, not merely that a client object constructed.
 * `Client.viewer(transport)` is a synchronous constructor and succeeds whether
 * or not anything is listening, so this makes a real round trip: `functions
 * list` is the cheapest read-only command that exercises SDK → Tauri IPC →
 * `daemon_execute` → daemon → response stream. An empty result is healthy.
 */
async function checkDaemon(): Promise<Health> {
  const started = performance.now();
  try {
    const t = await transport();
    const client = Client.viewer(t);
    const stream = functionsListExecute(client, {} as never);
    for await (const item of stream as AsyncIterable<unknown>) {
      const chunk = item as { type?: string; message?: unknown };
      if (chunk?.type === "error") {
        console.error("phosphene: daemon returned an error", chunk.message);
        return {
          state: "unavailable",
          reason: JSON.stringify(chunk.message).slice(0, 160),
        };
      }
      break;
    }
    const roundTripMs = Math.round(performance.now() - started);
    // console.* is the sanctioned path to the viewer's log inbox — the host
    // injects a capture script into every webview. "Did phosphene come up and
    // could it reach the daemon" is exactly what belongs there when someone
    // reports a blank tab.
    console.info(`phosphene: ready · daemon round trip ${roundTripMs}ms`);
    return { state: "ready", roundTripMs };
  } catch (error) {
    console.error("phosphene: daemon transport unavailable", error);
    return { state: "unavailable", reason: String(error).slice(0, 200) };
  }
}

function DirectionCard({ direction }: { direction: Direction }) {
  const [bg, surface, accent, text, muted] = direction.palette;
  return (
    <article className="ph-card">
      <header className="ph-card-head">
        <h3 className="ph-card-name">{direction.name}</h3>
        {direction.mood && <span className="ph-card-mood">{direction.mood}</span>}
      </header>

      {/* The legacy app invented palettes, fed them to generation, and rendered
          them nowhere (docs/legacy §8). Showing them is the point of a card. */}
      <div className="ph-swatches" aria-label="palette">
        {direction.palette.map((hex, i) => (
          <span
            key={`${hex}-${i}`}
            className="ph-swatch"
            style={{ backgroundColor: hex }}
            title={["background", "surface", "accent", "text", "muted"][i] + " " + hex}
          />
        ))}
      </div>

      <p className="ph-card-desc">{direction.description}</p>

      {/* A miniature of the direction, drawn with its own colours — the
          cheapest honest preview before real generation exists. */}
      <div className="ph-mini" style={{ backgroundColor: bg, borderColor: muted }}>
        <div className="ph-mini-bar" style={{ backgroundColor: surface }}>
          <span className="ph-mini-dot" style={{ backgroundColor: accent }} />
        </div>
        <div className="ph-mini-line" style={{ backgroundColor: text, width: "62%" }} />
        <div className="ph-mini-line" style={{ backgroundColor: muted, width: "88%" }} />
        <div className="ph-mini-line" style={{ backgroundColor: muted, width: "74%" }} />
        <div className="ph-mini-cta" style={{ backgroundColor: accent }} />
      </div>

      <p className="ph-card-type">{direction.typography}</p>
    </article>
  );
}

export default function Phosphene({ arguments: _args }: TabProps) {
  const [health, setHealth] = useState<Health>({ state: "connecting" });
  const [brief, setBrief] = useState("");
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const abort = useRef<{ aborted: boolean }>({ aborted: false });

  useEffect(() => {
    let disposed = false;
    void checkDaemon().then((next) => {
      if (!disposed) setHealth(next);
    });
    return () => {
      disposed = true;
      abort.current.aborted = true;
    };
  }, []);

  const invent = useCallback(async () => {
    const text = brief.trim();
    if (text.length === 0 || run.phase === "inventing") return;
    abort.current = { aborted: false };
    const signal = abort.current;
    setRun({ phase: "inventing", brief: text, streamed: 0 });
    try {
      const client = Client.viewer(await transport());
      const invention = await inventDirections(
        client,
        text,
        (p) =>
          setRun((prev) =>
            prev.phase === "inventing"
              ? { ...prev, aih: p.aih, streamed: p.streamed }
              : prev,
          ),
        signal,
      );
      if (!signal.aborted) setRun({ phase: "done", brief: text, invention });
    } catch (error) {
      console.error("phosphene: invention failed", error);
      if (!signal.aborted) {
        setRun({ phase: "failed", brief: text, reason: String(error).slice(0, 300) });
      }
    }
  }, [brief, run.phase]);

  const busy = run.phase === "inventing";

  return (
    <div className="phosphene">
      <header className="phosphene-header">
        <h1 className="phosphene-title">phosphene</h1>
        <p className="phosphene-subtitle">
          Describe a brief. Phosphene invents contrasting design directions, then
          renders and judges them.
        </p>
      </header>

      <section className="ph-composer">
        <label className="ph-label" htmlFor="ph-brief">
          brief
        </label>
        <textarea
          id="ph-brief"
          className="ph-input"
          rows={3}
          value={brief}
          disabled={busy}
          placeholder="A dating app where pickles match on brine compatibility"
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void invent();
          }}
        />
        <div className="ph-composer-row">
          <button
            type="button"
            className="ph-button"
            onClick={() => void invent()}
            disabled={busy || brief.trim().length === 0 || health.state !== "ready"}
          >
            {busy ? "inventing…" : "invent directions"}
          </button>
          <span className="ph-hint">⌘↵</span>
        </div>
      </section>

      {run.phase === "inventing" && (
        <section className="ph-progress" aria-live="polite">
          <span className="phosphene-dot phosphene-dot--connecting" aria-hidden="true" />
          <span>
            inventing directions
            {run.streamed > 0 && ` · ${(run.streamed / 1024).toFixed(1)} KB streamed`}
          </span>
          {run.aih && <code className="ph-aih">{run.aih.split("/").pop()}</code>}
        </section>
      )}

      {run.phase === "failed" && (
        <section className="ph-error" role="alert">
          <strong>invention failed</strong>
          <span>{run.reason}</span>
        </section>
      )}

      {run.phase === "done" && (
        <section className="ph-results">
          <div className="ph-results-head">
            <h2 className="ph-results-title">
              {run.invention.directions.length} directions
            </h2>
            {run.invention.states.length > 0 && (
              <p className="ph-states">
                states:{" "}
                {run.invention.states.map((s) => (
                  <span key={s} className="ph-state">
                    {s}
                  </span>
                ))}
              </p>
            )}
          </div>
          <div className="ph-grid">
            {run.invention.directions.map((d, i) => (
              <DirectionCard key={`${d.name}-${i}`} direction={d} />
            ))}
          </div>
        </section>
      )}

      <footer className="phosphene-status" aria-live="polite">
        <span
          className={`phosphene-dot phosphene-dot--${health.state}`}
          aria-hidden="true"
        />
        {health.state === "connecting" && <span>connecting to the daemon…</span>}
        {health.state === "ready" && (
          <span>daemon reachable · {health.roundTripMs}ms</span>
        )}
        {health.state === "unavailable" && (
          <span>daemon unavailable — {health.reason}</span>
        )}
      </footer>
    </div>
  );
}
