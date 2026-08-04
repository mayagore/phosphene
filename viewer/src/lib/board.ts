/**
 * Board geometry and cell state — the display-side vocabulary.
 *
 * This file deliberately contains NO prompts and NO generation. The prompts
 * live in ONE place, the MCP half (mcp/src/main.rs), because the agent does
 * the work now and two copies of a prompt only ever drift. What the viewer
 * keeps is the shape of the thing it displays.
 */

/** Artboards are a fixed portrait viewport so columns compare like with like.
 * Must agree with the MCP half's ARTBOARD_WIDTH/HEIGHT. */
export const ARTBOARD_WIDTH = 400;
export const ARTBOARD_HEIGHT = 720;

/** One cell of the board, keyed by (direction index × state label). */
export type CellStatus =
  | { phase: "pending" }
  | { phase: "generating"; streamed: number }
  | { phase: "done"; html: string }
  | { phase: "failed"; reason: string };

export function cellKey(directionIndex: number, label: string): string {
  return `${directionIndex}:${label}`;
}
