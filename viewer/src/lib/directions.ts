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
  /** Embedded font-kit families (≤2) — the MCP half injects their
   * @font-face blocks into every rendered document. */
  families?: string[];
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

/** Normalize one direction. Flavour defaults; DESIGN DECISIONS do not.
 *
 * This used to substitute a FALLBACK_PALETTE — byte-for-byte the example in
 * the MCP half's invent prompt — and a "system-ui, sans-serif" type stack,
 * both unflagged. The user saw colours and type no model chose, and the facts
 * then measured "adherence" against them. The MCP half's twin
 * (`normalize_direction`) is gone too; this is the display-side half of the
 * same rule: if nothing generated, show the failure, not a fake. */
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
  const name = typeof d.name === "string" ? d.name : `Direction ${index + 1}`;
  if (palette.length !== 5) {
    throw new Error(
      `direction ${index} ("${name}") returned ${palette.length} usable palette colours, not 5 — ` +
        `phosphene will not invent the rest.`,
    );
  }
  const typography =
    typeof d.typography === "string" && d.typography.trim() ? d.typography : "";
  if (!typography) {
    throw new Error(
      `direction ${index} ("${name}") returned no typography — phosphene will not ` +
        `substitute a system font stack.`,
    );
  }
  return {
    name,
    description: typeof d.description === "string" ? d.description : "",
    palette,
    typography,
    families: Array.isArray(d.families)
      ? d.families.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : undefined,
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
