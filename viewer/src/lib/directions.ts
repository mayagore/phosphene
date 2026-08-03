/**
 * Design-direction invention — the first real thing phosphene does.
 *
 * The completion itself is `runAgent` (lib/agent.ts); this module owns the
 * prompt and the shape of what comes back.
 *
 * The prompt is carried over from the legacy app, which is the one part of it
 * worth keeping (docs/legacy/00-the-old-app.md §7). Its hard-won details:
 *   - "genuinely different… not variations on one theme" is what stops three
 *     near-identical directions;
 *   - the palette contract shouts "JSON ARRAY … Never an object" because a live
 *     model returned an object keyed by slot and crashed the old app;
 *   - `states` are chosen per brief and SHARED across directions, which is what
 *     makes a comparison grid meaningful instead of a mosaic.
 */
import type { CommandExecutor } from "@objectiveai/sdk";
import {
  parseJsonLoose,
  runAgent,
  type AbortFlag,
  type AgentProgress,
} from "./agent";

export interface Direction {
  name: string;
  description: string;
  /** Exactly 5 hex strings, in slot order: bg, surface, accent, text, muted. */
  palette: string[];
  typography: string;
  mood: string;
}

export interface Invention {
  directions: Direction[];
  /** Shared across every direction so columns compare like with like. */
  states: string[];
}

const PROMPT = `You are a senior design director exploring visual directions for a design brief. Generate exactly 3 directions that are genuinely different from each other — not variations on one theme, but contrasting approaches in mood, visual weight, cultural reference, or era.

Consider the domain implied by the intent. A fintech product demands different visual language than a music festival poster or a children's app.

For each direction provide:
- name: Two-word evocative name (e.g. "Midnight Trust", "Paper Carnival")
- description: 2-3 sentences on visual strategy and emotional target. What does the viewer feel? What design tradition does this reference?
- palette: a JSON ARRAY of exactly 5 hex color strings in this order: background, surface, accent, text, muted — e.g. ["#101418", "#1b2129", "#ff6a3d", "#f2f2f2", "#7c8798"]. Never an object. Background and text MUST have sufficient contrast for readability. Accent should be distinct from background.
- typography: A system font stack for headings and body (e.g. "Georgia, serif / system-ui, sans-serif"). No Google Fonts or custom fonts — only fonts available without loading external resources.
- mood: 2-3 word mood descriptor

Also provide "states": a JSON array of exactly 3 state names (views/screens/compositions) that make sense for this brief — a fintech app might get ["landing", "portfolio", "transactions"]; a concert poster might get ["announce", "lineup", "tickets"]. These are SHARED across all directions: every direction will render exactly these 3 states so they can be compared side by side. Do not default to "hero/dashboard/settings" unless those genuinely fit.

Respond with a JSON object: {"directions": [...], "states": ["...", "...", "..."]}.`;

const FALLBACK_PALETTE = ["#101418", "#1b2129", "#ff6a3d", "#f2f2f2", "#7c8798"];

/** Normalize one direction, defaulting rather than throwing — a malformed
 * field should cost that field, not the whole run. */
function normalizeDirection(raw: unknown, index: number): Direction {
  const d = (raw ?? {}) as Record<string, unknown>;
  const palette = Array.isArray(d.palette)
    ? d.palette.filter((c): c is string => typeof c === "string")
    : // The live failure the prompt shouts about: an object keyed by slot.
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

/** What the caller sees while the agent works — this is the "display what the
 * agent is doing" half of the architecture. */
export type InventProgress = AgentProgress;

export async function inventDirections(
  executor: CommandExecutor,
  brief: string,
  onProgress?: (p: InventProgress) => void,
  signal?: AbortFlag,
): Promise<Invention> {
  const text = await runAgent(
    executor,
    { system: PROMPT, user: brief, maxTokens: 2000, timeoutSeconds: 180 },
    onProgress,
    signal,
  );
  return normalizeInvention(parseJsonLoose(text));
}
