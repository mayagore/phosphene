/**
 * The center panel — the board, now a pan/zoom canvas. Directions across in
 * rank order, shared states down; cells are the artboard's TRUE 400×720 and
 * the viewport transform does all scaling — a design is never reflowed.
 *
 * Rank ordering NEVER moves a cell in the DOM: JSX order stays invention
 * order with stable keys, and rank only changes each shape's x/y. Moving an
 * iframe re-parses its srcdoc — a white flash per reorder — so position is
 * style, not structure.
 *
 * `Artboard` is memoized BY VALUE (phase + html/reason), ignoring function
 * props: the board re-derives on every stream tick and fresh cell objects
 * would defeat a shallow memo — and an unmemoized iframe re-parses its
 * srcDoc on every tick, which is the most expensive thing on the page.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Direction, Invention } from "../lib/directions";
import { ARTBOARD_HEIGHT, ARTBOARD_WIDTH, cellKey, type CellStatus } from "../lib/board";
import { attachKit } from "../lib/fontkit";
import { DIMENSIONS, scoreTone, type Dimension, type DirectionRank } from "../lib/scores";
import { computeBoard, type BoardShape } from "../lib/layoutGrid";
import { copyPng, rasterizeBoard, savePng } from "../lib/rasterize";
import Canvas, { type CanvasHandle } from "./Canvas";

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
  /** Why there is no board, when the reason is a failure rather than "not
   * started". Replaces the invitation — telling someone to "start exploring"
   * after their run died is the blank-board lie. */
  inventionError?: string;
  zoomed: Zoomed | null;
  onOpen: (directionIndex: number, label: string) => void;
  onCloseZoom: () => void;
  /** Fixed initial framing — harness/tests only. */
  initialViewport?: { x: number; y: number; zoom: number };
}

/**
 * One cell's content. `sandbox=""` — the empty allow-list — is what makes
 * rendering model-authored markup safe: no scripts, no forms, opaque origin.
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
    // Recomputed only when the memo admits a re-render (html changed) — an
    // unstable srcDoc string would re-parse the iframe on every tick.
    return (
      <>
        <iframe
          className="ph-frame"
          sandbox=""
          srcDoc={attachKit(status.html)}
          title={`${directionName} — ${label}`}
          width={ARTBOARD_WIDTH}
          height={ARTBOARD_HEIGHT}
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

type ExportState = "idle" | "working" | "saved" | "copied" | "failed";

function ZoomModal({ zoomed, onClose }: { zoomed: Zoomed; onClose: () => void }) {
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exportState, setExportState] = useState<ExportState>("idle");
  // Kit re-attached once per board — the modal re-renders on its own state
  // toggles and the iframe must not re-parse for those. The source view and
  // copy-html stay LEAN on purpose: readable markup, no 30 KB of base64.
  const fonted = useMemo(() => attachKit(zoomed.html), [zoomed.html]);
  useEffect(() => {
    setShowSource(false);
    setCopied(false);
    setExportState("idle");
  }, [zoomed]);

  const copySource = () => {
    navigator.clipboard
      .writeText(zoomed.html)
      .then(() => setCopied(true))
      .catch((error) => console.error("phosphene: clipboard write failed", error));
  };

  const exportPng = async (how: "save" | "copy") => {
    setExportState("working");
    try {
      const blob = await rasterizeBoard(fonted);
      if (how === "copy") {
        await copyPng(blob);
        setExportState("copied");
      } else {
        savePng(blob, `phosphene-${zoomed.direction.name}-${zoomed.label}.png`.replaceAll(" ", "-"));
        setExportState("saved");
      }
    } catch (error) {
      console.error("phosphene: png export failed", error);
      setExportState("failed");
    }
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
          <button type="button" className="ph-zoom-close" onClick={() => setShowSource((s) => !s)}>
            {showSource ? "board" : "source"}
          </button>
          <button type="button" className="ph-zoom-close" onClick={copySource}>
            {copied ? "copied ✓" : "copy html"}
          </button>
          <button
            type="button"
            className="ph-zoom-close"
            disabled={exportState === "working"}
            onClick={() => void exportPng("save")}
          >
            {exportState === "saved" ? "saved ✓" : "save png"}
          </button>
          <button
            type="button"
            className="ph-zoom-close"
            disabled={exportState === "working"}
            onClick={() => void exportPng("copy")}
          >
            {exportState === "copied" ? "copied ✓" : exportState === "failed" ? "png failed" : "copy png"}
          </button>
          <button type="button" className="ph-zoom-close" onClick={onClose}>
            close
          </button>
        </header>
        {showSource ? (
          <pre className="ph-zoom-source">{zoomed.html}</pre>
        ) : (
          <iframe
            className="ph-zoom-frame"
            sandbox=""
            srcDoc={fonted}
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
  inventionError,
  zoomed,
  onOpen,
  onCloseZoom,
  initialViewport,
}: BoardProps) {
  const canvasRef = useRef<CanvasHandle | null>(null);

  const isSelected = (i: number, label?: string) =>
    selection !== null &&
    selection.index === i &&
    (selection.kind === "direction" ? label === undefined : selection.label === label);

  const rankFor = (i: number) => ranks?.find((r) => r.directionIndex === i);
  const scoredCount = ranks?.filter((r) => r.rank !== null).length ?? 0;

  // Display order: rank order once judged, invention order before.
  const order = invention
    ? ranks
      ? ranks.map((r) => r.directionIndex)
      : invention.directions.map((_, i) => i)
    : [];
  const layout = computeBoard(order, invention?.states ?? []);

  const positioned = [
    ...layout.cols.map((col) => {
      const d = invention!.directions[col.directionIndex]!;
      const r = rankFor(col.directionIndex);
      const stat = r?.byDimension[rankDimension];
      return {
        key: `col-${col.directionIndex}`,
        x: col.x,
        y: col.y,
        // Drawn UPWARD from the grid's top edge, so the head's own height —
        // which changes when the meta row appears with judgment — can never
        // desync from a reserved constant and be painted over by the boards.
        translate: "translate(0, -100%)",
        interactive: true,
        node: (
          <button
            type="button"
            className={`ph-col-head${isSelected(col.directionIndex) ? " ph-col-head--selected" : ""}`}
            style={{ width: col.width }}
            onClick={() => onSelect({ kind: "direction", index: col.directionIndex })}
          >
            <span className="ph-board-col-name">{d.name}</span>
            <span className="ph-board-col-meta">
              {r?.rank != null && <span className="ph-board-col-rank">#{r.rank}</span>}
              {stat && (
                <span className={`ph-cell-chip ph-tone-bg--${scoreTone(stat.median)}`}>
                  {stat.median.toFixed(2)}
                </span>
              )}
              {preferredIndex === col.directionIndex && (
                <span className="ph-preferred-mini" title="preferred — anchors the next round">
                  ★
                </span>
              )}
            </span>
          </button>
        ),
      };
    }),
    ...layout.rows.map((row) => ({
      key: `row-${row.label}`,
      x: row.x,
      y: row.y,
      translate: "translate(-100%, -50%)",
      node: <span className="ph-row-head">{row.label}</span>,
    })),
  ];

  const renderShape = (shape: BoardShape) => {
    const status = cells[shape.id];
    const stat = rankFor(shape.directionIndex)?.byDimension[rankDimension];
    const d = invention!.directions[shape.directionIndex]!;
    return (
      <>
        <Artboard
          status={status}
          label={shape.label}
          directionName={d.name}
          onOpen={() => onOpen(shape.directionIndex, shape.label)}
        />
        {status?.phase === "done" && stat && (
          <span
            className={`ph-cell-chip ph-cell-chip--overlay ph-tone-bg--${scoreTone(stat.median)}${isSelected(shape.directionIndex, shape.label) ? " ph-cell-chip--selected" : ""}`}
          >
            {stat.median.toFixed(2)}
          </span>
        )}
      </>
    );
  };

  const shapeClassName = (shape: BoardShape) => {
    const phase = cells[shape.id]?.phase ?? "pending";
    return `ph-artboard--${phase}${isSelected(shape.directionIndex, shape.label) ? " ph-shape--selected" : ""}`;
  };

  return (
    <main className="ph-center">
      <header className="ph-center-head">
        <div className="ph-center-title">
          <h2>{title}</h2>
          <span>{caption}</span>
        </div>
        {invention && (
          <button
            type="button"
            className="ph-chip ph-chip--action"
            onClick={() => canvasRef.current?.zoomToFit()}
          >
            fit
          </button>
        )}
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

      {!invention && (
        <div className="ph-center-scroll">
          {inventionError ? (
            <div className="ph-board-empty ph-board-empty--failed" role="alert">
              <span className="ph-turn-mark" aria-hidden="true">
                ⚠
              </span>
              <strong>No directions to show</strong>
              <p>{inventionError}</p>
              <p className="ph-board-gate">
                Phosphene does not invent a palette or a type stack on a model's behalf, so there is
                nothing to render. Try the brief again.
              </p>
            </div>
          ) : (
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
        </div>
      )}

      {invention && invention.states.length === 0 && (
        <div className="ph-center-scroll">
          <div className="ph-board-empty ph-board-empty--failed" role="alert">
            <span className="ph-turn-mark" aria-hidden="true">
              ⚠
            </span>
            <strong>Directions, but no states to render them across</strong>
            <p>
              The invention returned {invention.directions.length} direction
              {invention.directions.length === 1 ? "" : "s"} and zero shared states, so the grid has
              no columns. Nothing was rendered.
            </p>
          </div>
        </div>
      )}

      {invention && invention.states.length > 0 && (
        <Canvas
          layout={layout}
          renderShape={renderShape}
          shapeClassName={shapeClassName}
          positioned={positioned}
          onShapeClick={(shape) => onSelect({ kind: "cell", index: shape.directionIndex, label: shape.label })}
          onShapeDoubleClick={(shape) => onOpen(shape.directionIndex, shape.label)}
          onBackgroundClick={() => onSelect(null)}
          handleRef={canvasRef}
          initialViewport={initialViewport}
        />
      )}

      {zoomed && <ZoomModal zoomed={zoomed} onClose={onCloseZoom} />}
    </main>
  );
}
