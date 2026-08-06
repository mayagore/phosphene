/**
 * Judgment math and shapes — pure, display-side.
 *
 * The one law (docs/scoring.md §1): the four dimensions are scored
 * SEPARATELY and never combined. Everything here honors that — medians and
 * ranges are taken across JUDGES within one dimension, rankings follow one
 * caller-selected dimension, and nothing in this file produces a number that
 * mixes two dimensions.
 */
import type { ScoreEvent } from "./orchestrator";

export const DIMENSIONS = ["craft", "distinctiveness", "fitness", "coherence"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Long-form labels for prose surfaces; chips use the raw key. */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  craft: "craft",
  distinctiveness: "distinctiveness",
  fitness: "fitness to brief",
  coherence: "coherence across states",
};

/** Mirrors mcp/src/main.rs `Facts` (396–431). Wire-typed `unknown` until here;
 * a malformed field costs that field, never the panel. */
export interface ScoreFacts {
  contrast: {
    text_on_bg: number | null;
    text_on_surface: number | null;
    muted_on_bg: number | null;
    accent_on_bg: number | null;
  };
  palette: { declared_used: number; foreign_colours: number; adherence: number };
  fonts_declared_used: boolean | null;
  /** Kit families whose embedded payload is actually in the documents. */
  fonts_embedded: string[];
  /** Inline <svg> elements across the states — drawn matter, measured. */
  svg_used: number | null;
  javascript_free: boolean | null;
  external_free: boolean | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function normalizeFacts(raw: unknown): ScoreFacts | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const c = (r.contrast ?? {}) as Record<string, unknown>;
  const p = (r.palette ?? {}) as Record<string, unknown>;
  return {
    contrast: {
      text_on_bg: num(c.text_on_bg),
      text_on_surface: num(c.text_on_surface),
      muted_on_bg: num(c.muted_on_bg),
      accent_on_bg: num(c.accent_on_bg),
    },
    palette: {
      declared_used: num(p.declared_used) ?? 0,
      foreign_colours: num(p.foreign_colours) ?? 0,
      adherence: num(p.adherence) ?? 0,
    },
    fonts_declared_used: bool(r.fonts_declared_used),
    fonts_embedded: Array.isArray(r.fonts_embedded)
      ? (r.fonts_embedded as unknown[]).filter((f): f is string => typeof f === "string")
      : [],
    svg_used: num(r.svg_used),
    javascript_free: bool(r.javascript_free),
    external_free: bool(r.external_free),
  };
}

/** WCAG AA threshold the facts are judged against. */
export const CONTRAST_AA = 4.5;

export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The legacy tonal thresholds, ported verbatim: ≥0.85 high, ≥0.7 mid. */
export function scoreTone(v: number): "low" | "mid" | "high" {
  return v >= 0.85 ? "high" : v >= 0.7 ? "mid" : "low";
}

export interface JudgePoint {
  judge: string;
  value: number;
}

export interface DimensionStat {
  median: number;
  range: [number, number];
  points: JudgePoint[];
}

export interface DirectionRank {
  directionIndex: number;
  /** Distinct judges that reported on this direction. */
  judges: number;
  byDimension: Partial<Record<Dimension, DimensionStat>>;
  /** 1-based position among SCORED directions in the selected dimension;
   * null when this direction has no score in that dimension. */
  rank: number | null;
}

/**
 * Per-direction judgment stats, ordered for display by the selected
 * dimension's median (descending); unscored directions follow in invention
 * order. Rank is assigned within the scored set only.
 */
export function rankDirections(
  scores: ScoreEvent[],
  directionCount: number,
  dimension: Dimension,
): DirectionRank[] {
  const perDirection: DirectionRank[] = Array.from({ length: directionCount }, (_, i) => ({
    directionIndex: i,
    judges: 0,
    byDimension: {},
    rank: null,
  }));

  const judgeSets = perDirection.map(() => new Set<string>());
  const raw: Partial<Record<Dimension, JudgePoint[]>>[] = perDirection.map(() => ({}));

  for (const event of scores) {
    const slot = perDirection[event.directionIndex];
    if (!slot) continue;
    judgeSets[event.directionIndex]!.add(event.judge);
    for (const d of DIMENSIONS) {
      const value = event.scores[d];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      (raw[event.directionIndex]![d] ??= []).push({ judge: event.judge, value });
    }
  }

  perDirection.forEach((slot, i) => {
    slot.judges = judgeSets[i]!.size;
    for (const d of DIMENSIONS) {
      const points = raw[i]![d];
      if (!points || points.length === 0) continue;
      const values = points.map((p) => p.value);
      slot.byDimension[d] = {
        median: medianOf(values),
        range: [Math.min(...values), Math.max(...values)],
        points,
      };
    }
  });

  const scored = perDirection.filter((s) => s.byDimension[dimension]);
  const unscored = perDirection.filter((s) => !s.byDimension[dimension]);
  scored.sort(
    (a, b) => b.byDimension[dimension]!.median - a.byDimension[dimension]!.median,
  );
  scored.forEach((s, i) => {
    s.rank = i + 1;
  });

  return [...scored, ...unscored];
}
