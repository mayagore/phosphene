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
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Client, functionsListExecute } from "@objectiveai/sdk";
import { transport } from "./transport";
import { inventDirections, type Direction, type Invention } from "./lib/directions";
import {
  ARTBOARD_HEIGHT,
  ARTBOARD_WIDTH,
  cellKey,
  generateBoard,
  type CellStatus,
} from "./lib/generate";

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

interface Zoomed {
  direction: Direction;
  label: string;
  html: string;
}

/** Thumbnails are the artboard's true size scaled down, never a reflow — a
 * design judged at a different width is a different design. */
const THUMB_SCALE = 0.55;

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

      {/* A miniature of the direction, drawn with its own colours — what stands
          in for the real thing until the board is rendered. */}
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

/**
 * One cell of the board.
 *
 * `sandbox=""` — the empty allow-list — is what makes rendering model-authored
 * markup safe: no scripts, no forms, no popups, no top-level navigation, and an
 * opaque origin, so the document cannot reach this tab, the transport, or the
 * daemon. The generation prompt also forbids JavaScript; the sandbox is what
 * ENFORCES it, and the prompt is not a security boundary.
 */
function Artboard({
  status,
  label,
  directionName,
  onOpen,
}: {
  status: CellStatus | undefined;
  label: string;
  directionName: string;
  onOpen: () => void;
}) {
  if (status?.phase === "done") {
    return (
      <div className="ph-artboard">
        <iframe
          className="ph-frame"
          sandbox=""
          srcDoc={status.html}
          title={`${directionName} — ${label}`}
          width={ARTBOARD_WIDTH}
          height={ARTBOARD_HEIGHT}
          style={{ transform: `scale(${THUMB_SCALE})` }}
        />
        <button type="button" className="ph-artboard-open" onClick={onOpen}>
          <span>open</span>
        </button>
      </div>
    );
  }

  const phase = status?.phase ?? "pending";
  return (
    <div className={`ph-artboard ph-artboard--${phase}`}>
      {status?.phase === "generating" && (
        <span className="phosphene-dot phosphene-dot--connecting" aria-hidden="true" />
      )}
      <span className="ph-artboard-note">
        {phase === "pending" && "queued"}
        {status?.phase === "generating" &&
          (status.streamed > 0
            ? `${(status.streamed / 1024).toFixed(1)} KB`
            : "starting…")}
        {status?.phase === "failed" && status.reason}
      </span>
    </div>
  );
}

export default function Phosphene({ arguments: _args }: TabProps) {
  const [health, setHealth] = useState<Health>({ state: "connecting" });
  const [brief, setBrief] = useState("");
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [cells, setCells] = useState<Record<string, CellStatus>>({});
  const [rendering, setRendering] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<Zoomed | null>(null);
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

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoomed]);

  const invent = useCallback(async () => {
    const text = brief.trim();
    if (text.length === 0 || run.phase === "inventing" || rendering) return;
    abort.current = { aborted: false };
    const signal = abort.current;
    setRun({ phase: "inventing", brief: text, streamed: 0 });
    // A new brief invalidates the old board rather than leaving artboards from
    // a different question sitting under new directions.
    setCells({});
    setBoardError(null);
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
  }, [brief, run.phase, rendering]);

  const render = useCallback(async () => {
    if (run.phase !== "done" || rendering) return;
    const { invention } = run;
    abort.current = { aborted: false };
    const signal = abort.current;

    const initial: Record<string, CellStatus> = {};
    for (let i = 0; i < invention.directions.length; i++) {
      for (const label of invention.states) {
        initial[cellKey(i, label)] = { phase: "pending" };
      }
    }
    setCells(initial);
    setBoardError(null);
    setRendering(true);
    try {
      const client = Client.viewer(await transport());
      await generateBoard(
        client,
        invention,
        (key, status) => setCells((prev) => ({ ...prev, [key]: status })),
        signal,
      );
    } catch (error) {
      console.error("phosphene: board failed", error);
      if (!signal.aborted) setBoardError(String(error).slice(0, 300));
    } finally {
      setRendering(false);
    }
  }, [run, rendering]);

  const busy = run.phase === "inventing";
  const cellCount = Object.keys(cells).length;
  const doneCount = Object.values(cells).filter((c) => c.phase === "done").length;
  const failedCount = Object.values(cells).filter((c) => c.phase === "failed").length;

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
            disabled={
              busy || rendering || brief.trim().length === 0 || health.state !== "ready"
            }
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
            <button
              type="button"
              className="ph-button"
              onClick={() => void render()}
              disabled={rendering || run.invention.states.length === 0}
            >
              {rendering
                ? `rendering ${doneCount + failedCount}/${cellCount}…`
                : cellCount > 0
                  ? "render again"
                  : `render ${run.invention.directions.length * run.invention.states.length} artboards`}
            </button>
          </div>
          <div className="ph-grid">
            {run.invention.directions.map((d, i) => (
              <DirectionCard key={`${d.name}-${i}`} direction={d} />
            ))}
          </div>
        </section>
      )}

      {boardError && (
        <section className="ph-error" role="alert">
          <strong>render failed</strong>
          <span>{boardError}</span>
        </section>
      )}

      {run.phase === "done" && cellCount > 0 && (
        <section className="ph-board">
          <div className="ph-results-head">
            <h2 className="ph-results-title">board</h2>
            <p className="ph-states">
              <span>
                {doneCount}/{cellCount} rendered
                {failedCount > 0 && ` · ${failedCount} failed`}
              </span>
            </p>
          </div>

          {/* Directions across, shared states down — the whole point of pinning
              one set of states at invention time is that a row compares like
              with like. */}
          <div
            className="ph-board-grid"
            style={{
              gridTemplateColumns: `max-content repeat(${run.invention.directions.length}, max-content)`,
            }}
          >
            <span aria-hidden="true" />
            {run.invention.directions.map((d, i) => (
              <div key={`col-${i}`} className="ph-board-col">
                {d.name}
              </div>
            ))}
            {run.invention.states.map((label) => (
              <Fragment key={label}>
                <div className="ph-board-row">{label}</div>
                {run.invention.directions.map((d, i) => (
                  <Artboard
                    key={cellKey(i, label)}
                    status={cells[cellKey(i, label)]}
                    label={label}
                    directionName={d.name}
                    onOpen={() => {
                      const cell = cells[cellKey(i, label)];
                      if (cell?.phase === "done") {
                        setZoomed({ direction: d, label, html: cell.html });
                      }
                    }}
                  />
                ))}
              </Fragment>
            ))}
          </div>
        </section>
      )}

      {zoomed && (
        <div
          className="ph-zoom"
          role="dialog"
          aria-modal="true"
          aria-label={`${zoomed.direction.name} — ${zoomed.label}`}
          onClick={() => setZoomed(null)}
        >
          <div className="ph-zoom-panel" onClick={(e) => e.stopPropagation()}>
            <header className="ph-zoom-head">
              <strong className="ph-zoom-name">{zoomed.direction.name}</strong>
              <span className="ph-zoom-state">{zoomed.label}</span>
              <button
                type="button"
                className="ph-zoom-close"
                onClick={() => setZoomed(null)}
              >
                close
              </button>
            </header>
            <iframe
              className="ph-zoom-frame"
              sandbox=""
              srcDoc={zoomed.html}
              title={`${zoomed.direction.name} — ${zoomed.label}`}
              width={ARTBOARD_WIDTH}
              height={ARTBOARD_HEIGHT}
            />
          </div>
        </div>
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
