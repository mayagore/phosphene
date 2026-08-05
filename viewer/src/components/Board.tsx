/**
 * The center panel — the board. Directions across, shared states down; cells
 * are the artboard's true 400×720 scaled by transform, never reflowed.
 *
 * `Artboard` is memoized BY VALUE (phase + html/reason), ignoring function
 * props: the board re-derives on every stream tick and fresh cell objects
 * would defeat a shallow memo — and an unmemoized iframe re-parses its
 * srcDoc on every tick, which is the most expensive thing on the page.
 */
import { Fragment, memo } from "react";
import type { Direction, Invention } from "../lib/directions";
import { ARTBOARD_HEIGHT, ARTBOARD_WIDTH, cellKey, type CellStatus } from "../lib/board";
import type { ScoreEvent } from "../lib/orchestrator";

/** Thumbnails are the artboard's true size scaled down, never a reflow — a
 * design judged at a different width is a different design. */
const THUMB_SCALE = 0.55;

const DIMENSIONS = ["craft", "distinctiveness", "fitness", "coherence"] as const;

export interface Zoomed {
  direction: Direction;
  label: string;
  html: string;
}

export type StatusTone = "idle" | "busy" | "done" | "failed";

interface BoardProps {
  title: string;
  caption: string;
  statusChip: string;
  statusTone: StatusTone;
  invention?: Invention;
  cells: Record<string, CellStatus>;
  scores: ScoreEvent[];
  /** Idle empty-state gate line (daemon state, in calm words). */
  gateNote?: string;
  zoomed: Zoomed | null;
  onOpen: (directionIndex: number, label: string) => void;
  onCloseZoom: () => void;
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
      {(direction.voice || direction.texture || direction.motifs || direction.audience) && (
        <dl className="ph-moodboard">
          {direction.voice && (
            <div>
              <dt>voice</dt>
              <dd>{direction.voice}</dd>
            </div>
          )}
          {direction.texture && (
            <div>
              <dt>texture</dt>
              <dd>{direction.texture}</dd>
            </div>
          )}
          {direction.motifs && (
            <div>
              <dt>motifs</dt>
              <dd>{direction.motifs}</dd>
            </div>
          )}
          {direction.audience && (
            <div>
              <dt>audience</dt>
              <dd>{direction.audience}</dd>
            </div>
          )}
        </dl>
      )}
      <p className="ph-card-type">{direction.typography}</p>
    </article>
  );
}

/**
 * One cell. `sandbox=""` — the empty allow-list — is what makes rendering
 * model-authored markup safe: no scripts, no forms, opaque origin.
 */
function ArtboardImpl({
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
      <span className="ph-artboard-note">
        {phase === "pending" && "Queued"}
        {status?.phase === "generating" && "Generating…"}
        {status?.phase === "failed" && status.reason}
      </span>
      {status?.phase === "generating" && <span className="ph-artboard-pulse" aria-hidden="true" />}
    </div>
  );
}

function sameStatus(a: CellStatus | undefined, b: CellStatus | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.phase !== b.phase) return false;
  if (a.phase === "done" && b.phase === "done") return a.html === b.html;
  if (a.phase === "failed" && b.phase === "failed") return a.reason === b.reason;
  return true; // pending/generating carry nothing the render uses
}

const Artboard = memo(
  ArtboardImpl,
  (prev, next) =>
    prev.label === next.label &&
    prev.directionName === next.directionName &&
    sameStatus(prev.status, next.status),
);

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

export default function Board({
  title,
  caption,
  statusChip,
  statusTone,
  invention,
  cells,
  scores,
  gateNote,
  zoomed,
  onOpen,
  onCloseZoom,
}: BoardProps) {
  return (
    <main className="ph-center">
      <header className="ph-center-head">
        <div className="ph-center-title">
          <h2>{title}</h2>
          <span>{caption}</span>
        </div>
        <span className={`ph-status-chip ph-status-chip--${statusTone}`}>{statusChip}</span>
      </header>

      <div className="ph-center-scroll">
        {!invention && (
          <div className="ph-board-empty">
            <span className="ph-turn-mark" aria-hidden="true">
              ✦
            </span>
            <strong>Start exploring</strong>
            <p>
              Describe a brief in the rail. Independent agents invent contrasting directions and
              render each across shared states — name judge models and their judgment appears
              beside the board.
            </p>
            {gateNote && <p className="ph-board-gate">{gateNote}</p>}
          </div>
        )}

        {invention && invention.states.length > 0 && (
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
                    onOpen={() => onOpen(i, label)}
                  />
                ))}
              </Fragment>
            ))}
          </div>
        )}

        {/* Direction cards + per-direction verdicts live below the board until
            the Inspector takes them over (Phase B of the design adoption). */}
        {invention && (
          <div className="ph-grid">
            {invention.directions.map((d, i) => (
              <DirectionCard key={`${d.name}-${i}`} direction={d} />
            ))}
          </div>
        )}

        {scores.length > 0 &&
          invention?.directions.map((d, i) => {
            const forDirection = scores.filter((s) => s.directionIndex === i);
            if (forDirection.length === 0) return null;
            return (
              <div key={`scores-${i}`} className="ph-direction-scores">
                <h3 className="ph-results-title">{d.name} — judged</h3>
                <ScorePanel scores={forDirection} />
              </div>
            );
          })}
      </div>

      {zoomed && (
        <div
          className="ph-zoom"
          role="dialog"
          aria-modal="true"
          aria-label={`${zoomed.direction.name} — ${zoomed.label}`}
          onClick={onCloseZoom}
        >
          <div className="ph-zoom-panel" onClick={(e) => e.stopPropagation()}>
            <header className="ph-zoom-head">
              <strong className="ph-zoom-name">{zoomed.direction.name}</strong>
              <span className="ph-zoom-state">{zoomed.label}</span>
              <button type="button" className="ph-zoom-close" onClick={onCloseZoom}>
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
    </main>
  );
}
