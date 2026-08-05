/**
 * The center panel — the board. Directions across, shared states down; cells
 * are the artboard's true 400×720 scaled by transform, never reflowed.
 *
 * Rank ordering NEVER moves a cell in the DOM: JSX order stays invention
 * order with stable keys, and rank only changes each child's explicit
 * `gridColumn`. Moving an iframe re-parses its srcdoc — a white flash per
 * reorder — so position is style, not structure.
 *
 * `Artboard` is memoized BY VALUE (phase + html/reason), ignoring function
 * props: the board re-derives on every stream tick and fresh cell objects
 * would defeat a shallow memo — and an unmemoized iframe re-parses its
 * srcDoc on every tick, which is the most expensive thing on the page.
 */
import { memo, useEffect, useState } from "react";
import type { Direction, Invention } from "../lib/directions";
import { ARTBOARD_HEIGHT, ARTBOARD_WIDTH, cellKey, type CellStatus } from "../lib/board";
import { DIMENSIONS, scoreTone, type Dimension, type DirectionRank } from "../lib/scores";

/** Thumbnails are the artboard's true size scaled down, never a reflow — a
 * design judged at a different width is a different design. */
const THUMB_SCALE = 0.55;

export interface Zoomed {
  direction: Direction;
  label: string;
  html: string;
}

export type StatusTone = "idle" | "busy" | "done" | "failed";

export type BoardSelection =
  | { kind: "direction"; index: number }
  | { kind: "cell"; index: number; label: string }
  | null;

interface BoardProps {
  title: string;
  caption: string;
  statusChip: string;
  statusTone: StatusTone;
  invention?: Invention;
  cells: Record<string, CellStatus>;
  /** Display order + per-direction stats for the selected dimension;
   * undefined until judgment exists (board stays in invention order). */
  ranks?: DirectionRank[];
  rankDimension: Dimension;
  onSetDimension: (d: Dimension) => void;
  preferredIndex: number | null;
  selection: BoardSelection;
  onSelect: (selection: BoardSelection) => void;
  /** Idle empty-state gate line (daemon state, in calm words). */
  gateNote?: string;
  zoomed: Zoomed | null;
  onOpen: (directionIndex: number, label: string) => void;
  onCloseZoom: () => void;
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
      <>
        <iframe
          className="ph-frame"
          sandbox=""
          srcDoc={status.html}
          title={`${directionName} — ${label}`}
          width={ARTBOARD_WIDTH}
          height={ARTBOARD_HEIGHT}
          style={{ transform: `scale(${THUMB_SCALE})` }}
        />
        <button
          type="button"
          className="ph-artboard-open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <span>open</span>
        </button>
      </>
    );
  }

  const phase = status?.phase ?? "pending";
  return (
    <>
      <span className="ph-artboard-note">
        {phase === "pending" && "Queued"}
        {status?.phase === "generating" && "Generating…"}
        {status?.phase === "failed" && status.reason}
      </span>
      {status?.phase === "generating" && <span className="ph-artboard-pulse" aria-hidden="true" />}
    </>
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

function ZoomModal({ zoomed, onClose }: { zoomed: Zoomed; onClose: () => void }) {
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setShowSource(false);
    setCopied(false);
  }, [zoomed]);

  const copy = () => {
    navigator.clipboard
      .writeText(zoomed.html)
      .then(() => setCopied(true))
      .catch((error) => console.error("phosphene: clipboard write failed", error));
  };

  return (
    <div
      className="ph-zoom"
      role="dialog"
      aria-modal="true"
      aria-label={`${zoomed.direction.name} — ${zoomed.label}`}
      onClick={onClose}
    >
      <div className="ph-zoom-panel" onClick={(e) => e.stopPropagation()}>
        <header className="ph-zoom-head">
          <strong className="ph-zoom-name">{zoomed.direction.name}</strong>
          <span className="ph-zoom-state">{zoomed.label}</span>
          <button
            type="button"
            className="ph-zoom-close"
            onClick={() => setShowSource((s) => !s)}
          >
            {showSource ? "board" : "source"}
          </button>
          <button type="button" className="ph-zoom-close" onClick={copy}>
            {copied ? "copied ✓" : "copy html"}
          </button>
          <button type="button" className="ph-zoom-close ph-zoom-close--last" onClick={onClose}>
            close
          </button>
        </header>
        {showSource ? (
          <pre className="ph-zoom-source">{zoomed.html}</pre>
        ) : (
          <iframe
            className="ph-zoom-frame"
            sandbox=""
            srcDoc={zoomed.html}
            title={`${zoomed.direction.name} — ${zoomed.label}`}
            width={ARTBOARD_WIDTH}
            height={ARTBOARD_HEIGHT}
          />
        )}
      </div>
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
  ranks,
  rankDimension,
  onSetDimension,
  preferredIndex,
  selection,
  onSelect,
  gateNote,
  zoomed,
  onOpen,
  onCloseZoom,
}: BoardProps) {
  // Display position per direction: invention order until judgment exists.
  const positions = new Map<number, number>();
  if (invention) {
    if (ranks) {
      ranks.forEach((r, pos) => positions.set(r.directionIndex, pos));
    } else {
      invention.directions.forEach((_, i) => positions.set(i, i));
    }
  }
  const rankFor = (i: number) => ranks?.find((r) => r.directionIndex === i);
  const scoredCount = ranks?.filter((r) => r.rank !== null).length ?? 0;

  const isSelected = (i: number, label?: string) =>
    selection !== null &&
    selection.index === i &&
    (selection.kind === "direction" ? label === undefined : selection.label === label);

  return (
    <main className="ph-center">
      <header className="ph-center-head">
        <div className="ph-center-title">
          <h2>{title}</h2>
          <span>{caption}</span>
        </div>
        {scoredCount > 0 && (
          <div className="ph-dim-chips" role="group" aria-label="Rank by dimension">
            {DIMENSIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={`ph-chip ph-chip--action${d === rankDimension ? " ph-chip--active" : ""}`}
                onClick={() => onSetDimension(d)}
              >
                {d}
              </button>
            ))}
          </div>
        )}
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
            {/* JSX stays in invention order — rank only changes gridColumn. */}
            {invention.directions.map((d, i) => {
              const r = rankFor(i);
              const stat = r?.byDimension[rankDimension];
              return (
                <button
                  key={`col-${i}`}
                  type="button"
                  className={`ph-board-col${isSelected(i) ? " ph-board-col--selected" : ""}`}
                  style={{ gridColumn: (positions.get(i) ?? i) + 2, gridRow: 1 }}
                  onClick={() => onSelect({ kind: "direction", index: i })}
                >
                  <span className="ph-board-col-name">{d.name}</span>
                  <span className="ph-board-col-meta">
                    {r?.rank != null && <span className="ph-board-col-rank">#{r.rank}</span>}
                    {stat && (
                      <span className={`ph-cell-chip ph-tone-bg--${scoreTone(stat.median)}`}>
                        {stat.median.toFixed(2)}
                      </span>
                    )}
                    {preferredIndex === i && (
                      <span className="ph-preferred-mini" title="preferred — anchors the next round">
                        ★
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {invention.states.map((label, s) => (
              <div
                key={`row-${label}`}
                className="ph-board-row"
                style={{ gridColumn: 1, gridRow: s + 2 }}
              >
                {label}
              </div>
            ))}
            {invention.states.map((label, s) =>
              invention.directions.map((d, i) => {
                const status = cells[cellKey(i, label)];
                const stat = rankFor(i)?.byDimension[rankDimension];
                const phase = status?.phase ?? "pending";
                return (
                  <div
                    key={cellKey(i, label)}
                    className={`ph-artboard ph-artboard--${phase}${isSelected(i, label) ? " ph-artboard--selected" : ""}`}
                    style={{ gridColumn: (positions.get(i) ?? i) + 2, gridRow: s + 2 }}
                    onClick={() => onSelect({ kind: "cell", index: i, label })}
                  >
                    <Artboard
                      status={status}
                      label={label}
                      directionName={d.name}
                      onOpen={() => onOpen(i, label)}
                    />
                    {status?.phase === "done" && stat && (
                      <span
                        className={`ph-cell-chip ph-cell-chip--overlay ph-tone-bg--${scoreTone(stat.median)}${isSelected(i, label) ? " ph-cell-chip--selected" : ""}`}
                      >
                        {stat.median.toFixed(2)}
                      </span>
                    )}
                  </div>
                );
              }),
            )}
          </div>
        )}
      </div>

      {zoomed && <ZoomModal zoomed={zoomed} onClose={onCloseZoom} />}
    </main>
  );
}
