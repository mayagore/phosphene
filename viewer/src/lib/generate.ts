/**
 * Generation — turning a direction into artboards you can actually look at.
 *
 * Every cell of the board is one agent completion through the daemon
 * (`runAgent`), producing one self-contained HTML document for one
 * (direction × state) pair.
 *
 * ── Anchor-then-parallel ──────────────────────────────────────────────────
 * Within a direction, state 1 renders alone; states 2–3 then fan out with
 * state 1's LITERAL HTML inlined as input. This is the one strategy worth
 * carrying over from the legacy app, and the reason is precise
 * (docs/legacy §2): colour and type are already pinned by the palette and
 * typography spec, so what actually drifts across independently-generated
 * screens is the SHARED CHROME — nav, spacing scale, component styling.
 * Pinning the anchor's real markup rather than a description of it is what
 * makes three states read as one product.
 *
 * We keep it for that coherence, NOT as tribute to an output-token ceiling.
 * The 32K cap that forced the legacy split was Claude Code's, inherited from
 * `upstream: "claude_agent_sdk"`, and we are not under it (docs/legacy §4).
 *
 * Directions do not depend on each other, so all three run concurrently — the
 * single-in-flight constraint the old bridge had is gone, measured at 3.5×
 * (docs/spikes/01-calibration.md §B).
 */
import type { CommandExecutor } from "@objectiveai/sdk";
import { parseJsonLoose, runAgent, type AbortFlag } from "./agent";
import type { Direction, Invention } from "./directions";

/** Artboards are a fixed portrait viewport so columns compare like with like. */
export const ARTBOARD_WIDTH = 400;
export const ARTBOARD_HEIGHT = 720;

/**
 * Generation gets its own model, deliberately larger than invention's.
 *
 * Measured on this exact prompt, one direction, the "onboarding" state:
 * `openai/gpt-4o-mini` returned a 1.6 KB document — valid, correctly sized,
 * palette used properly, and a placeholder: one centred card, one heading, one
 * button. Adding an explicit density clause to the prompt moved it to 1.57 KB,
 * i.e. not at all. `anthropic/claude-sonnet-4.5` on the same prompt returned
 * 5.3 KB with real furniture. Invention is a paragraph of JSON and stays cheap;
 * this step is the one the whole product is judged on.
 */
export const GENERATION_MODEL = "anthropic/claude-sonnet-4.5";

const SLOT_NAMES = ["bg", "surface", "accent", "text", "muted"];

/**
 * Carried verbatim from the legacy app, with one clause worth defending:
 * **valid XHTML**. It costs the model nothing and it is what makes the
 * SVG-`foreignObject` → canvas rasterization path work — the round trip Spike D
 * proved is available to us in-page and untainted, and the one that puts
 * vision-based judging back on the table. The "no external resources" clause
 * serves the same end: `foreignObject` rasterizing is exactly where remote
 * fonts and images fall down.
 */
const REQUIREMENTS = `Technical requirements:
- Complete HTML document with xmlns="http://www.w3.org/1999/xhtml" on the <html> tag
- Set html and body to width: ${ARTBOARD_WIDTH}px; height: ${ARTBOARD_HEIGHT}px; margin: 0; overflow: hidden
- All styles in a <style> tag — no inline styles except where unavoidable
- CSS flexbox and grid are both allowed. No media queries, no animations, no JavaScript
- No external resources (no Google Fonts, no images, no CDN links)
- Valid XHTML: self-closing tags (<meta/>, <br/>), quoted attributes, no bare ampersands
- Use the font stacks from the typography field (they are system fonts)

Design quality:
- Use the palette semantically: bg= for page background, surface= for cards/panels, accent= for buttons and interactive highlights, text= for body copy, muted= for secondary text and borders
- Visual density, whitespace, and copy tone should reflect the mood
- Use realistic placeholder content — real-looking names, dollar amounts, dates, titles — not "Lorem ipsum" or "John Doe"
- Typography hierarchy: clear distinction between headings, subheadings, body, and labels
- Composition: consider visual weight distribution, focal points, and reading flow

Completeness — this is a finished screen, not a wireframe:
- Fill the full ${ARTBOARD_WIDTH}×${ARTBOARD_HEIGHT} frame. Deliberate empty space is fine; an unfinished screen is not
- Include the furniture a real screen of this kind has: header or nav, the primary content at real density (a list has several rows, a feed has several cards, a form has all its fields), and the supporting detail around it — labels, metadata, secondary actions, status
- Design the details rather than defaulting: borders, corner radii, dividers, iconography drawn in CSS, considered type sizes
- A single centered card with one heading and one button is a placeholder. Do better than that.`;

/** An anchor rides in as INPUT on every sibling state, so its size is paid for
 * twice per direction. Generous, but bounded — a runaway document should not
 * quietly become the whole prompt. */
const MAX_ANCHOR_CHARS = 24_000;

/** Exported so the exact shipping prompt can be probed against a model without
 * a second copy drifting out of sync with this one. */
export function systemPrompt(states: string[], label: string, anchorHtml?: string): string {
  const consistency = anchorHtml
    ? `The "${states[0]}" state of this direction is already rendered — match its visual language exactly: reuse the same header/nav markup, the same spacing scale and CSS, and the same component styling and palette usage. Only the content differs for this state. Here is that state's HTML to match:

${anchorHtml.slice(0, MAX_ANCHOR_CHARS)}`
    : `Keep this direction's visual language consistent across the set (same header/nav treatment, spacing scale, and component styling) so the states read as one product.`;

  return `You are a visual designer rendering design concepts as self-contained HTML documents.

This exploration renders ${states.length} states (views/screens/compositions) per direction, using these EXACT labels shared across every direction so results compare side by side: ${states.map((s) => `"${s}"`).join(", ")}. Generate ONLY the "${label}" state now — the other states are generated separately. ${consistency}

Keep planning brief — put the design effort into the HTML itself, not extended deliberation.

${REQUIREMENTS}

Respond with a JSON object: {"label": "${label}", "html": "..."}.`;
}

export function directionPrompt(direction: Direction, label: string): string {
  const p = direction.palette;
  return `Direction: "${direction.name}" — ${direction.description}
Palette: ${SLOT_NAMES.map((n, i) => `${n}=${p[i]}`).join(", ")}
Typography: ${direction.typography}
Mood: ${direction.mood}
State to render: "${label}"`;
}

/**
 * Pull the document out of a generation response.
 *
 * Layer 1 is the contract: `{"label", "html"}`, plus the legacy wrapper shape
 * `{"states":[…]}` that a model occasionally answers with anyway. Layer 2 is
 * the far more common miss — the model ignores the JSON envelope and simply
 * writes the document. Taking it is strictly better than failing the cell.
 */
export function extractHtml(text: string, label: string): string {
  try {
    const o = parseJsonLoose(text) as {
      html?: unknown;
      states?: Array<{ label?: unknown; html?: unknown }>;
    };
    if (typeof o?.html === "string" && o.html.trim()) return o.html;
    const match = Array.isArray(o?.states)
      ? (o.states.find((s) => s?.label === label) ?? o.states[0])
      : undefined;
    if (typeof match?.html === "string" && match.html.trim()) return match.html;
  } catch {
    // Fall through — the model probably answered with the document itself.
  }
  const start = text.search(/<!doctype\s+html|<html[\s>]/i);
  if (start !== -1) return text.slice(start).replace(/\s*```[\s\S]*$/, "").trim();
  throw new Error(`no HTML document in the "${label}" response`);
}

export async function generateState(
  executor: CommandExecutor,
  direction: Direction,
  states: string[],
  label: string,
  anchorHtml: string | undefined,
  onProgress?: (streamed: number) => void,
  signal?: AbortFlag,
): Promise<string> {
  const text = await runAgent(
    executor,
    {
      system: systemPrompt(states, label, anchorHtml),
      user: directionPrompt(direction, label),
      model: GENERATION_MODEL,
      // Lower than invention's 0.9: the direction is already pinned, and this
      // step should execute the spec rather than reinterpret it.
      temperature: 0.7,
      maxTokens: 8000,
      // Every outer layer strictly outlasts every inner one (docs/legacy §5).
      timeoutSeconds: 600,
      stallSeconds: 120,
    },
    (p) => onProgress?.(p.streamed),
    signal,
  );
  return extractHtml(text, label);
}

/** One cell of the board, keyed by (direction index × state label). */
export type CellStatus =
  | { phase: "pending" }
  | { phase: "generating"; streamed: number }
  | { phase: "done"; html: string }
  | { phase: "failed"; reason: string };

export function cellKey(directionIndex: number, label: string): string {
  return `${directionIndex}:${label}`;
}

/**
 * Render every (direction × state) cell, reporting each one as it moves.
 *
 * Never rejects for a single bad cell: a state that fails costs that state.
 * A direction whose ANCHOR fails still renders its remaining states — they
 * simply lose the cross-state pinning and fall back to the prose instruction.
 */
export async function generateBoard(
  executor: CommandExecutor,
  invention: Invention,
  onCell: (key: string, status: CellStatus) => void,
  signal?: AbortFlag,
): Promise<void> {
  const states = invention.states;
  const [anchorLabel, ...rest] = states;
  if (anchorLabel === undefined) {
    throw new Error("no shared states to render — invention returned none");
  }

  const runCell = async (
    direction: Direction,
    index: number,
    label: string,
    anchorHtml: string | undefined,
  ): Promise<string | undefined> => {
    const key = cellKey(index, label);
    if (signal?.aborted) return undefined;
    onCell(key, { phase: "generating", streamed: 0 });
    // Every cell streams concurrently and every chunk would otherwise be a
    // state update in the consumer. Throttle to something a human can read.
    let reported = 0;
    try {
      const html = await generateState(
        executor,
        direction,
        states,
        label,
        anchorHtml,
        (streamed) => {
          if (streamed - reported < 512) return;
          reported = streamed;
          onCell(key, { phase: "generating", streamed });
        },
        signal,
      );
      if (signal?.aborted) return undefined;
      onCell(key, { phase: "done", html });
      return html;
    } catch (error) {
      console.error(`phosphene: ${key} failed`, error);
      if (!signal?.aborted) {
        onCell(key, { phase: "failed", reason: String(error).slice(0, 240) });
      }
      return undefined;
    }
  };

  await Promise.all(
    invention.directions.map(async (direction, index) => {
      const anchorHtml = await runCell(direction, index, anchorLabel, undefined);
      await Promise.all(
        rest.map((label) => runCell(direction, index, label, anchorHtml)),
      );
    }),
  );
}
