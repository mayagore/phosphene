/**
 * Canvas-space board geometry — pure math, no React.
 *
 * Ported from the legacy layoutGrid (design-legacy/) and TRANSPOSED: the
 * legacy grid ran directions as rows sorted by score; this board runs
 * directions as COLUMNS in the caller's display order (rank order once
 * judgment exists — see lib/scores.ts) with the shared states as rows,
 * matching the Phase B grid the canvas replaces.
 *
 * Cells are the artboard's true 400×720 — on the canvas the viewport
 * transform does the scaling, so a design is never reflowed.
 */
import { ARTBOARD_HEIGHT, ARTBOARD_WIDTH, cellKey } from "./board";

export interface GridConfig {
  cellWidth: number;
  cellHeight: number;
  gapX: number;
  gapY: number;
  originX: number;
  originY: number;
}

const DEFAULT_CONFIG: GridConfig = {
  cellWidth: ARTBOARD_WIDTH,
  cellHeight: ARTBOARD_HEIGHT,
  gapX: 60,
  gapY: 80,
  originX: 240,
  originY: 100,
};

export interface BoardShape {
  /** `${directionIndex}:${label}` — the cell key the board already uses. */
  id: string;
  directionIndex: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ColumnAnchor {
  directionIndex: number;
  /** Top-left of the header block, sitting above the column. */
  x: number;
  y: number;
  width: number;
}

export interface RowAnchor {
  label: string;
  /** Right edge of the label, vertically centered on the row. */
  x: number;
  y: number;
}

export interface BoardLayout {
  shapes: BoardShape[];
  cols: ColumnAnchor[];
  rows: RowAnchor[];
  /** Content bounds including header room — what zoomToFit frames. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const COL_HEAD_H = 64;
const ROW_HEAD_W = 200;

/**
 * @param directionOrder direction indices in DISPLAY order (rank or invention)
 * @param states shared state labels, row order
 */
export function computeBoard(
  directionOrder: number[],
  states: string[],
  config?: Partial<GridConfig>,
): BoardLayout {
  const c = { ...DEFAULT_CONFIG, ...config };
  const shapes: BoardShape[] = [];
  const cols: ColumnAnchor[] = [];
  const rows: RowAnchor[] = [];

  directionOrder.forEach((directionIndex, pos) => {
    const x = c.originX + pos * (c.cellWidth + c.gapX);
    cols.push({ directionIndex, x, y: c.originY - COL_HEAD_H, width: c.cellWidth });
    states.forEach((label, row) => {
      shapes.push({
        id: cellKey(directionIndex, label),
        directionIndex,
        label,
        x,
        y: c.originY + row * (c.cellHeight + c.gapY),
        width: c.cellWidth,
        height: c.cellHeight,
      });
    });
  });

  states.forEach((label, row) => {
    rows.push({
      label,
      x: c.originX - 28,
      y: c.originY + row * (c.cellHeight + c.gapY) + c.cellHeight / 2,
    });
  });

  const colCount = Math.max(directionOrder.length, 1);
  const rowCount = Math.max(states.length, 1);
  const bounds = {
    minX: c.originX - ROW_HEAD_W,
    minY: c.originY - COL_HEAD_H,
    maxX: c.originX + colCount * c.cellWidth + (colCount - 1) * c.gapX,
    maxY: c.originY + rowCount * c.cellHeight + (rowCount - 1) * c.gapY,
  };

  return { shapes, cols, rows, bounds };
}
