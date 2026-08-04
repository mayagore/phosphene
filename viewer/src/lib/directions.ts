/**
 * The shape of an invention, and how to read one out of a tool result.
 *
 * This module used to own the invention PROMPT and spawn the completion
 * itself. Both moved to the MCP half (mcp/src/main.rs) when the tab became a
 * display: the agent calls `phosphene_invent_directions`, and the viewer's
 * whole job is to parse and show what came back. One prompt, one home —
 * two copies only ever drift.
 */

export interface Direction {
  name: string;
  description: string;
  /** Exactly 5 hex strings, in slot order: bg, surface, accent, text, muted. */
  palette: string[];
  typography: string;
  mood: string;
  /** Moodboard fields — optional; pre-2026-08-04 explorations lack them. */
  voice?: string;
  texture?: string;
  motifs?: string;
  audience?: string;
}

export interface Invention {
  directions: Direction[];
  /** Shared across every direction so columns compare like with like. */
  states: string[];
}

const FALLBACK_PALETTE = ["#101418", "#1b2129", "#ff6a3d", "#f2f2f2", "#7c8798"];

/** Normalize one direction, defaulting rather than throwing — a malformed
 * field should cost that field, not the whole run. */
function normalizeDirection(raw: unknown, index: number): Direction {
  const d = (raw ?? {}) as Record<string, unknown>;
  const palette = Array.isArray(d.palette)
    ? d.palette.filter((c): c is string => typeof c === "string")
    : // The live failure the MCP half's prompt shouts about: an object keyed
      // by slot.
      typeof d.palette === "object" && d.palette !== null
      ? ["background", "surface", "accent", "text", "muted"]
          .map((k) => (d.palette as Record<string, unknown>)[k])
          .filter((c): c is string => typeof c === "string")
      : [];
  return {
    name: typeof d.name === "string" ? d.name : `Direction ${index + 1}`,
    description: typeof d.description === "string" ? d.description : "",
    palette: palette.length === 5 ? palette : FALLBACK_PALETTE,
    typography: typeof d.typography === "string" ? d.typography : "system-ui, sans-serif",
    mood: typeof d.mood === "string" ? d.mood : "",
    voice: typeof d.voice === "string" && d.voice.trim() ? d.voice : undefined,
    texture: typeof d.texture === "string" && d.texture.trim() ? d.texture : undefined,
    motifs: typeof d.motifs === "string" && d.motifs.trim() ? d.motifs : undefined,
    audience: typeof d.audience === "string" && d.audience.trim() ? d.audience : undefined,
  };
}

export function normalizeInvention(parsed: unknown): Invention {
  const o = (parsed ?? {}) as Record<string, unknown>;
  const directions = Array.isArray(o.directions)
    ? o.directions.map(normalizeDirection)
    : [];
  if (directions.length === 0) {
    throw new Error("the model returned no directions");
  }
  const seen = new Set<string>();
  const states = (Array.isArray(o.states) ? o.states : [])
    .filter((s): s is string => typeof s === "string")
    .filter((s) => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3);
  return { directions, states };
}
