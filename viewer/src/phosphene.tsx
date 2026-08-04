/**
 * Phosphene's boot tab — declared in `objectiveai.json` as `viewer.tabs[0]`.
 *
 * ARCHITECTURE. The tab is a DISPLAY. One button spawns ONE agent that
 * declares phosphene's plugin and does all the work — inventing, rendering,
 * judging — by calling phosphene's tools. Everything on screen below the
 * composer is DERIVED from that agent's tool-event stream: the arguments name
 * the cell, the results carry the documents and verdicts. The tab holds no
 * work of its own; it is the human's window onto the agent.
 *
 * (The direct path — the tab orchestrating completions itself — existed while
 * the tool lane was unproven and was deleted once it wasn't. Work the tab did
 * privately could not be watched, resumed, or shared; work the agent does can.)
 *
 * Host contracts this file lives under (docs/platform/01-viewer.md):
 *   1. It receives ONE prop, `arguments`, and a manifest-declared boot tab is
 *      always opened with none — so at boot it is undefined.
 *   2. Everything else comes from the harness: the daemon transport and the
 *      window's zoom. No theme, no router, no host state.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Client, functionsListExecute } from "@objectiveai/sdk";
import { transport } from "./transport";
import type { Direction, Invention } from "./lib/directions";
import { ARTBOARD_HEIGHT, ARTBOARD_WIDTH, cellKey, type CellStatus } from "./lib/board";
import {
  deriveExploration,
  explore,
  refine,
  resume,
  type Exploration,
  type ScoreEvent,
} from "./lib/orchestrator";
import type { ToolEvent } from "./lib/agent";

interface TabProps {
  arguments?: unknown;
}

type Health =
  | { state: "connecting" }
  | { state: "ready"; roundTripMs: number }
  | { state: "unavailable"; reason: string };

type Run =
  | { phase: "idle" }
  | {
      phase: "exploring";
      brief: string;
      explorationId: string;
      aih?: string;
      exploration: Exploration;
      /** Prior rounds' merged board, kept under the live run so a refine
       * round updates cells in place instead of blanking the board. */
      base?: Exploration;
    }
  | { phase: "done"; brief: string; explorationId: string; exploration: Exploration }
  | {
      phase: "failed";
      brief: string;
      explorationId?: string;
      reason: string;
      exploration?: Exploration;
    };

/** Later rounds win cell-by-cell; scores accumulate; invention persists. */
function mergeExploration(base: Exploration | undefined, current: Exploration): Exploration {
  if (!base) return current;
  return {
    invention: current.invention ?? base.invention,
    cells: { ...base.cells, ...current.cells },
    scores: [...base.scores, ...current.scores],
    summary: current.summary ?? base.summary,
    tools: current.tools,
  };
}

/** The one localStorage key. Namespaced `phosphene.*` — the origin is shared
 * by every tab in the viewer (spikes/01 §E), so exclusivity is never assumed. */
const STORE_KEY = "phosphene.lastExploration";

interface StoredExploration {
  explorationId: string;
  brief: string;
}

function loadStored(): StoredExploration | undefined {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as StoredExploration;
    return parsed.explorationId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function saveStored(value: StoredExploration): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: resume is a convenience, never a failure.
  }
}

interface Zoomed {
  direction: Direction;
  label: string;
  html: string;
}

/** Thumbnails are the artboard's true size scaled down, never a reflow — a
 * design judged at a different width is a different design. */
const THUMB_SCALE = 0.55;

const DIMENSIONS = ["craft", "distinctiveness", "fitness", "coherence"] as const;

/**
 * Prove the daemon is REACHABLE, not merely that a client object constructed:
 * `functions list` is the cheapest read-only round trip through the whole
 * SDK → Tauri IPC → daemon path. An empty result is healthy.
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
    // console.* is the sanctioned path to the viewer's log inbox — exactly
    // where "did phosphene come up" belongs when someone reports a blank tab.
    console.info(`phosphene: ready · daemon round trip ${roundTripMs}ms`);
    return { state: "ready", roundTripMs };
  } catch (error) {
    console.error("phosphene: daemon transport unavailable", error);
    return { state: "unavailable", reason: String(error).slice(0, 200) };
  }
}

function DirectionCard({ direction }: { direction: Direction }) {
  return (
    <article className="ph-card">
      <header className="ph-card-head">
        <h3 className="ph-card-name">{direction.name}</h3>
        {direction.mood && <span className="ph-card-mood">{direction.mood}</span>}
      </header>
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
      <p className="ph-card-type">{direction.typography}</p>
    </article>
  );
}

/**
 * One cell. `sandbox=""` — the empty allow-list — is what makes rendering
 * model-authored markup safe: no scripts, no forms, opaque origin. The
 * generation prompt forbids JavaScript; the sandbox ENFORCES it.
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
        {status?.phase === "generating" && "the agent is rendering…"}
        {status?.phase === "failed" && status.reason}
      </span>
    </div>
  );
}

/** A direction's judge verdicts, side by side. Never averaged — with vote
 * distributions gone, the spread between judges IS the signal. */
function ScorePanel({ scores }: { scores: ScoreEvent[] }) {
  if (scores.length === 0) return null;
  return (
    <div className="ph-scores">
      <table className="ph-score-table">
        <thead>
          <tr>
            <th>judge</th>
            {DIMENSIONS.map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scores.map((s, i) => (
            <tr key={`${s.judge}-${i}`}>
              <td className="ph-score-judge">{s.judge.split("/").pop()}</td>
              {DIMENSIONS.map((d) => (
                <td key={d} className="ph-score-cell">
                  {s.scores[d] !== undefined ? s.scores[d].toFixed(2) : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {scores.map((s, i) => (
        <details className="ph-score-notes" key={`notes-${s.judge}-${i}`}>
          <summary>
            why, per {s.judge.split("/").pop()}
            {s.statesSeen.length > 0 && ` · saw ${s.statesSeen.length} state(s)`}
          </summary>
          {DIMENSIONS.filter((d) => s.notes[d]).map((d) => (
            <p key={d}>
              <strong>{d}.</strong> {s.notes[d]}
            </p>
          ))}
        </details>
      ))}
    </div>
  );
}

export default function Phosphene({ arguments: _args }: TabProps) {
  const [health, setHealth] = useState<Health>({ state: "connecting" });
  const [brief, setBrief] = useState("");
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [zoomed, setZoomed] = useState<Zoomed | null>(null);
  const abort = useRef<{ aborted: boolean }>({ aborted: false });

  useEffect(() => {
    let disposed = false;
    void checkDaemon().then((next) => {
      if (!disposed) setHealth(next);
    });
    return () => {
      disposed = true;
      // KNOWN LIMIT: breaking the stream cancels the daemon-side run, so
      // closing the tab kills the agent mid-work. The fix is reattach-by-AIH
      // (agentsInstancesListener) — a future slice; noted rather than hidden.
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

  const start = useCallback(async () => {
    const text = brief.trim();
    if (text.length === 0 || run.phase === "exploring") return;
    // Escape hatch: `resume:<exploration-id>` replays any stored board by id —
    // including boards from runs that never reached done (where localStorage
    // was never written). The database is the truth; this is just a key.
    if (text.toLowerCase().startsWith("resume:")) {
      const id = text.slice("resume:".length).trim();
      if (id) void doResume(id, `resumed ${id.slice(0, 8)}…`);
      return;
    }
    abort.current = { aborted: false };
    const signal = abort.current;
    // The id is the name of the WORK, not of the run — refine rounds and any
    // future reattach key off it, and every database row is scoped by it.
    const explorationId = crypto.randomUUID();
    setRun({
      phase: "exploring",
      brief: text,
      explorationId,
      exploration: deriveExploration([]),
    });
    try {
      const client = Client.viewer(await transport());
      const exploration = await explore(
        client,
        explorationId,
        text,
        (p) =>
          setRun((prev) =>
            prev.phase === "exploring"
              ? { ...prev, aih: p.aih, exploration: deriveExploration(p.tools) }
              : prev,
          ),
        signal,
      );
      console.info(
        `phosphene: exploration done — ${exploration.tools.length} tool calls`,
      );
      if (!signal.aborted) {
        setRun({ phase: "done", brief: text, explorationId, exploration });
        if (exploration.invention) {
          saveStored({ explorationId, brief: text });
        }
      }
    } catch (error) {
      console.error("phosphene: exploration failed", error);
      if (!signal.aborted) {
        setRun((prev) => ({
          phase: "failed",
          brief: text,
          explorationId,
          reason: String(error).slice(0, 300),
          // Keep whatever the board had — a failed run with 7 rendered cells
          // should show 7 cells and the error, not a blank page.
          exploration: prev.phase === "exploring" ? prev.exploration : undefined,
        }));
      }
    }
  }, [brief, run.phase]);

  /** The stop control: flips the abort flag, which breaks the stream — and
   * breaking the stream cancels the daemon-side run. The formerly-undocumented
   * close-tab behaviour, promoted to a button. */
  const stop = useCallback(() => {
    if (run.phase !== "exploring") return;
    abort.current.aborted = true;
    setRun((prev) =>
      prev.phase === "exploring"
        ? {
            phase: "failed",
            brief: prev.brief,
            explorationId: prev.explorationId,
            reason: "stopped by you — the board keeps everything already rendered",
            exploration: mergeExploration(prev.base, prev.exploration),
          }
        : prev,
    );
  }, [run.phase]);

  const doResume = useCallback(
    async (explorationId: string, label: string) => {
      if (run.phase === "exploring") return;
      abort.current = { aborted: false };
      const signal = abort.current;
      setRun({
        phase: "exploring",
        brief: label,
        explorationId,
        exploration: deriveExploration([]),
      });
      try {
        const client = Client.viewer(await transport());
        const replay = await resume(
          client,
          explorationId,
          (p) =>
            setRun((prev) =>
              prev.phase === "exploring"
                ? { ...prev, aih: p.aih, exploration: deriveExploration(p.tools) }
                : prev,
            ),
          signal,
        );
        console.info(`phosphene: resumed — ${replay.tools.length} reads`);
        if (!signal.aborted) {
          setRun({
            phase: "done",
            brief: label,
            explorationId,
            exploration: replay,
          });
          if (replay.invention) saveStored({ explorationId, brief: label });
        }
      } catch (error) {
        console.error("phosphene: resume failed", error);
        if (!signal.aborted) {
          setRun({
            phase: "failed",
            brief: label,
            explorationId,
            reason: String(error).slice(0, 300),
          });
        }
      }
    },
    [run.phase],
  );

  const [feedback, setFeedback] = useState("");
  const sendFeedback = useCallback(async () => {
    const text = feedback.trim();
    if (text.length === 0 || run.phase !== "done") return;
    const { explorationId, exploration: prior, brief: priorBrief } = run;
    const invention = prior.invention;
    if (!invention) return;
    abort.current = { aborted: false };
    const signal = abort.current;
    setFeedback("");
    setRun({
      phase: "exploring",
      brief: priorBrief,
      explorationId,
      exploration: deriveExploration([]),
      base: prior,
    });
    try {
      const client = Client.viewer(await transport());
      const round = await refine(
        client,
        explorationId,
        invention.directions.map((d) => d.name),
        invention.states,
        text,
        (p) =>
          setRun((prev) =>
            prev.phase === "exploring"
              ? { ...prev, aih: p.aih, exploration: deriveExploration(p.tools) }
              : prev,
          ),
        signal,
      );
      console.info(`phosphene: refine done — ${round.tools.length} tool calls`);
      if (!signal.aborted) {
        const merged = mergeExploration(prior, round);
        setRun({
          phase: "done",
          brief: priorBrief,
          explorationId,
          exploration: merged,
        });
        if (merged.invention) {
          saveStored({ explorationId, brief: priorBrief });
        }
      }
    } catch (error) {
      console.error("phosphene: refine failed", error);
      if (!signal.aborted) {
        setRun({
          phase: "failed",
          brief: priorBrief,
          explorationId,
          reason: String(error).slice(0, 300),
          exploration: prior,
        });
      }
    }
  }, [feedback, run]);

  const busy = run.phase === "exploring";
  const exploration =
    run.phase === "idle"
      ? undefined
      : run.phase === "exploring"
        ? mergeExploration(run.base, run.exploration)
        : run.exploration;
  const invention = exploration?.invention;
  const cells = exploration?.cells ?? {};
  const doneCount = Object.values(cells).filter((c) => c.phase === "done").length;
  const failedCount = Object.values(cells).filter((c) => c.phase === "failed").length;
  const totalCells = invention
    ? invention.directions.length * invention.states.length
    : 0;

  return (
    <div className="phosphene">
      <header className="phosphene-header">
        <h1 className="phosphene-title">phosphene</h1>
        <p className="phosphene-subtitle">
          Describe a brief. Your agent invents contrasting design directions,
          renders them across shared states, and — if you name judge models —
          scores them. You watch it work.
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
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
          }}
        />
        <div className="ph-composer-row">
          <button
            type="button"
            className="ph-button"
            onClick={() => void start()}
            disabled={busy || brief.trim().length === 0 || health.state !== "ready"}
          >
            {busy ? "exploring…" : "explore"}
          </button>
          {busy && (
            <button type="button" className="ph-button ph-button--ghost" onClick={stop}>
              stop
            </button>
          )}
          {!busy && run.phase === "idle" && loadStored() && (
            <button
              type="button"
              className="ph-button ph-button--ghost"
              onClick={() => {
                const stored = loadStored();
                if (stored) void doResume(stored.explorationId, stored.brief);
              }}
              disabled={health.state !== "ready"}
              title={`Reload "${loadStored()?.brief.slice(0, 60) ?? ""}" from storage — no generation`}
            >
              resume last
            </button>
          )}
          <span className="ph-hint">⌘↵</span>
        </div>
      </section>

      {/* What the agent is doing with its tools — the display half of the
          architecture, and the only place a human can see it happen. */}
      {exploration && exploration.tools.length > 0 && (
        <section className="ph-tools" aria-live="polite">
          {exploration.tools.slice(-8).map((tool: ToolEvent, i: number) => (
            <div className="ph-tool" key={`${tool.name}-${i}`}>
              <span
                className={`phosphene-dot phosphene-dot--${tool.result ? "ready" : "connecting"}`}
                aria-hidden="true"
              />
              <code className="ph-tool-name">{tool.name || "…"}</code>
              <span className="ph-tool-state">
                {tool.result
                  ? `${(tool.result.length / 1024).toFixed(1)} KB back`
                  : "calling…"}
              </span>
            </div>
          ))}
          {run.phase === "exploring" && run.aih && (
            <code className="ph-aih">{run.aih.split("/").pop()}</code>
          )}
        </section>
      )}

      {run.phase === "failed" && (
        <section className="ph-error" role="alert">
          <strong>exploration failed</strong>
          <span>{run.reason}</span>
        </section>
      )}

      {invention && (
        <section className="ph-results">
          <div className="ph-results-head">
            <h2 className="ph-results-title">
              {invention.directions.length} directions
            </h2>
            {invention.states.length > 0 && (
              <p className="ph-states">
                states:{" "}
                {invention.states.map((s) => (
                  <span key={s} className="ph-state">
                    {s}
                  </span>
                ))}
              </p>
            )}
            {totalCells > 0 && (
              <p className="ph-states">
                <span>
                  {doneCount}/{totalCells} rendered
                  {failedCount > 0 && ` · ${failedCount} failed`}
                </span>
              </p>
            )}
          </div>
          <div className="ph-grid">
            {invention.directions.map((d, i) => (
              <DirectionCard key={`${d.name}-${i}`} direction={d} />
            ))}
          </div>
        </section>
      )}

      {invention && invention.states.length > 0 && (
        <section className="ph-board">
          {/* Directions across, shared states down — one set of states is what
              makes a row compare like with like. */}
          <div
            className="ph-board-grid"
            style={{
              gridTemplateColumns: `max-content repeat(${invention.directions.length}, max-content)`,
            }}
          >
            <span aria-hidden="true" />
            {invention.directions.map((d, i) => (
              <div key={`col-${i}`} className="ph-board-col">
                {d.name}
              </div>
            ))}
            {invention.states.map((label) => (
              <Fragment key={label}>
                <div className="ph-board-row">{label}</div>
                {invention.directions.map((d, i) => (
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

          {/* Judgment as a surface, not a number: per direction, every judge's
              scores side by side, plus every written why. */}
          {(exploration?.scores.length ?? 0) > 0 &&
            invention.directions.map((d, i) => {
              const forDirection =
                exploration?.scores.filter((s) => s.directionIndex === i) ?? [];
              if (forDirection.length === 0) return null;
              return (
                <div key={`scores-${i}`} className="ph-direction-scores">
                  <h3 className="ph-results-title">{d.name} — judged</h3>
                  <ScorePanel scores={forDirection} />
                </div>
              );
            })}
        </section>
      )}

      {/* ITERATION — the product's first noun. Feedback goes to a refine
          agent that revises the stored board through phosphene_refine_state;
          the cells update in place as revisions stream back. */}
      {run.phase === "done" && invention && (
        <section className="ph-composer">
          <label className="ph-label" htmlFor="ph-feedback">
            refine
          </label>
          <textarea
            id="ph-feedback"
            className="ph-input"
            rows={2}
            value={feedback}
            placeholder={`Make ${invention.directions[0]?.name ?? "the first direction"}'s header calmer — or name any direction, state, or change`}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendFeedback();
            }}
          />
          <div className="ph-composer-row">
            <button
              type="button"
              className="ph-button"
              onClick={() => void sendFeedback()}
              disabled={feedback.trim().length === 0 || health.state !== "ready"}
            >
              refine
            </button>
            <span className="ph-hint">⌘↵ · revises only what the feedback names</span>
          </div>
        </section>
      )}

      {run.phase === "done" && exploration?.summary && (
        <section className="ph-progress">
          <span>{exploration.summary}</span>
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
