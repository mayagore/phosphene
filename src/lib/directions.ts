/**
 * Design-direction invention — the first real thing phosphene does.
 *
 * ARCHITECTURE (see HANDOFF §"ARCHITECTURE CHANGED"): all work goes through the
 * daemon as AGENT COMPLETIONS. No functions — that layer is being replaced by a
 * provider spec. The viewer's job is to spawn the work and display it, not to
 * be the thing doing it.
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
import { agentsSpawnExecuteStreaming, type CommandExecutor } from "@objectiveai/sdk";

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

/** Cheap and reliable at structured output. Tunable — quality work later. */
const MODEL = "openai/gpt-4o-mini";

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

/**
 * Recover a JSON object from a model's prose.
 *
 * Agent completions cannot constrain output shape — `output_mode` is documented
 * "Vector completions only. Ignored for agent completions", and the openrouter
 * agent schema carries no `response_format`. So the contract is prose, and this
 * is the cost of that. Three layers, deliberately: the legacy app grew a
 * four-layer salvage ladder because it deleted its schemas, and this is the
 * smallest honest version of the same job.
 */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  try {
    return JSON.parse(fenced);
  } catch {
    // Fall through to brace matching.
  }
  const start = fenced.search(/[{[]/);
  if (start === -1) throw new Error("no JSON found in the model's response");
  const open = fenced[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < fenced.length; i++) {
    const ch = fenced[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(fenced.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON in the model's response");
}

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
export interface InventProgress {
  /** The agent instance hierarchy, once the daemon has minted it. */
  aih?: string;
  /** Characters of assistant output so far. */
  streamed: number;
}

/**
 * Spawn the invention agent and fold its stream into one assistant string.
 *
 * The stream's first item is a bare string (the agent instance hierarchy);
 * every later item is an `agent.completion.chunk` whose `messages[].content`
 * are DELTAS accumulated by `index`. Verified against a live capture.
 */
export async function inventDirections(
  executor: CommandExecutor,
  brief: string,
  onProgress?: (p: InventProgress) => void,
  signal?: { aborted: boolean },
): Promise<Invention> {
  const request = {
    agent: {
      by: "ref",
      agent: {
        Resolved: {
          upstream: "openrouter",
          model: MODEL,
          temperature: 0.9,
          max_tokens: 2000,
          plugins: [],
          // `system_prompt` is {role, content}, NOT a bare string — a string
          // fails deserialization with the untagged-enum error that names the
          // whole agent union and points nowhere useful. Role is
          // "system" | "developer" (agent.openrouter.SystemPromptRole).
          system_prompt: { role: "system", content: PROMPT },
        },
      },
    },
    message: { Simple: brief },
    timeout_seconds: 180,
  };

  const parts = new Map<number, string>();
  let aih: string | undefined;

  const stream = agentsSpawnExecuteStreaming(executor, request as never);
  for await (const item of stream as AsyncIterable<unknown>) {
    if (signal?.aborted) break;
    if (typeof item === "string") {
      aih = item;
      onProgress?.({ aih, streamed: 0 });
      continue;
    }
    const chunk = item as {
      type?: string;
      message?: unknown;
      object?: string;
      messages?: Array<{ role?: string; index?: number; content?: unknown }>;
    };
    if (chunk?.type === "error") {
      throw new Error(
        `the agent failed: ${JSON.stringify(chunk.message).slice(0, 200)}`,
      );
    }
    for (const m of chunk.messages ?? []) {
      if (m.role !== "assistant" || typeof m.content !== "string") continue;
      const i = m.index ?? 0;
      parts.set(i, (parts.get(i) ?? "") + m.content);
    }
    onProgress?.({
      aih,
      streamed: [...parts.values()].reduce((n, s) => n + s.length, 0),
    });
  }

  const text = [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => s)
    .join("");
  if (text.trim().length === 0) {
    // Distinguish "model said nothing" from "we cannot parse" — the legacy app
    // reported the former as a parser bug for weeks.
    throw new Error("the agent returned an empty response");
  }
  return normalizeInvention(parseJsonLoose(text));
}
