/**
 * The architecture, from the viewer's side: the tab spawns ONE agent that
 * declares phosphene's plugin, and that agent does everything — invents
 * directions, renders every (direction × state) cell, and judges on request —
 * by calling phosphene's tools. The tab renders what streams back. It is a
 * window onto the agent, not the application.
 *
 * No document ever rides through the agent's context: render_state pins each
 * direction's anchor from the plugin's own cache, and score_direction reads
 * the same cache. The agent passes indices and labels — small, boring
 * arguments a model gets right.
 *
 * The board the tab shows is DERIVED from the tool-event stream (arguments
 * name the cell, results carry the document), so the display state is the
 * broadcast, not a private copy.
 */
import type { CommandExecutor } from "@objectiveai/sdk";
import { runAgent, type AbortFlag, type AgentProgress, type ToolEvent } from "./agent";
import { normalizeInvention, type Invention } from "./directions";
import { cellKey, type CellStatus } from "./board";

/** The trio must match the registration BYTE FOR BYTE. `v0.1.0` and `0.1.0`
 * are different keys, and a mismatch is silent — the plugin simply builds from
 * GitHub as though nothing were registered. */
export const PHOSPHENE_PLUGIN = {
  owner: "mayagore",
  name: "phosphene",
  version: "v0.1.0",
} as const;

const explorePrompt = (explorationId: string) => `You explore design briefs using your phosphene tools. A human is watching the board fill in as you work — your tool calls ARE the product; your prose is only a closing summary.

Use exploration_id "${explorationId}" on EVERY tool call, verbatim.

The procedure:
1. Call phosphene_invent_directions ONCE with the user's brief. It returns 3 directions and 3 shared states.
2. Call phosphene_render_state once per (direction × state) — 9 calls, no more, no fewer. For each direction, render states[0] BEFORE its other two states (the tool pins the shared chrome from stored state; you never pass HTML). Pass direction_index (0, 1 or 2), the full states array, and the label. If one render fails, continue with the rest. Before summarizing, verify all 9 (direction, state) pairs were rendered — if any is missing, render it.
3. If — and only if — the user named judge models, call phosphene_score_direction once per (direction × judge model) after that direction's states are rendered. Report every judge's scores separately; never average across judges.

Then write a 2-3 sentence closing summary. Do not restate the documents or scores — the human already watched them arrive.`;

const refinePrompt = (
  explorationId: string,
  directions: string[],
  states: string[],
) => `You revise an already-rendered design exploration by applying the user's feedback with your phosphene_refine_state tool. A human is watching the board update.

Use exploration_id "${explorationId}" on EVERY call, verbatim. The exploration's directions, by direction_index: ${directions.map((n, i) => `${i}="${n}"`).join(", ")}. Its states: ${states.map((s) => `"${s}"`).join(", ")}.

Read the user's feedback and call phosphene_refine_state once per (direction_index, label) the feedback targets — pass the relevant part of the feedback verbatim as \`feedback\`. If it names one direction, revise that direction's affected states (all three only if the feedback is about the direction as a whole). If it clearly targets everything, revise every state of every direction. At least 1 call, at most 9. If one call fails, continue with the rest.

Then one closing sentence. Do not restate the documents.`;

export interface Exploration {
  invention?: Invention;
  /** `${directionIndex}:${label}` → cell state, derived from tool events. */
  cells: Record<string, CellStatus>;
  /** Score results in arrival order, verbatim from the tool. */
  scores: ScoreEvent[];
  /** The agent's closing prose. */
  summary?: string;
  tools: ToolEvent[];
}

export interface ScoreEvent {
  directionIndex: number;
  judge: string;
  scores: Record<string, number>;
  notes: Record<string, string>;
  facts: unknown;
  statesSeen: string[];
}

/** Parse a streamed-then-complete JSON argument string. Undefined while the
 * deltas are still arriving — callers treat that as "not yet", never an error. */
function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold the tool-event stream into board state. Pure — called on every progress
 * tick and once at the end, same answer both times for the same events.
 */
export function deriveExploration(tools: ToolEvent[], summary?: string): Exploration {
  const out: Exploration = { cells: {}, scores: [], tools, summary };

  for (const event of tools) {
    if (event.name.endsWith("invent_directions")) {
      if (event.result) {
        try {
          out.invention = normalizeInvention(JSON.parse(event.result));
        } catch {
          // A malformed invention result will surface as the run failing to
          // produce directions — not silently as an empty board.
        }
      }
      continue;
    }

    if (event.name.endsWith("render_state") || event.name.endsWith("refine_state")) {
      const args = parseArgs(event.arguments);
      const index = typeof args?.direction_index === "number" ? args.direction_index : undefined;
      const label = typeof args?.label === "string" ? args.label : undefined;
      if (index === undefined || label === undefined) continue; // args still streaming
      const key = cellKey(index, label);
      if (!event.result) {
        out.cells[key] = { phase: "generating", streamed: 0 };
      } else if (event.result.startsWith("tool call failed")) {
        out.cells[key] = { phase: "failed", reason: event.result.slice(0, 240) };
      } else {
        try {
          const rendered = JSON.parse(event.result) as { html?: string };
          out.cells[key] =
            typeof rendered.html === "string" && rendered.html.trim()
              ? { phase: "done", html: rendered.html }
              : { phase: "failed", reason: "render returned no html" };
        } catch {
          out.cells[key] = { phase: "failed", reason: "render result was not JSON" };
        }
      }
      continue;
    }

    if (event.name.endsWith("score_direction") && event.result) {
      if (event.result.startsWith("tool call failed")) continue; // judge died; panel survives
      const args = parseArgs(event.arguments);
      try {
        const r = JSON.parse(event.result) as {
          judge?: string;
          scores?: Record<string, number>;
          notes?: Record<string, string>;
          facts?: unknown;
          states_seen?: string[];
        };
        if (r.scores && r.judge) {
          out.scores.push({
            directionIndex:
              typeof args?.direction_index === "number" ? args.direction_index : 0,
            judge: r.judge,
            scores: r.scores,
            notes: r.notes ?? {},
            facts: r.facts,
            statesSeen: r.states_seen ?? [],
          });
        }
      } catch {
        // Same policy as cells: a bad result costs that result.
      }
    }
  }

  return out;
}

/**
 * Spawn the exploration agent and stream derived board state to the caller.
 * The caller mints `explorationId` (any unique string) and keeps it: refine
 * rounds and reattach both key off it — it is the name of the work, not of
 * the run.
 */
export async function explore(
  executor: CommandExecutor,
  explorationId: string,
  brief: string,
  onProgress?: (p: AgentProgress) => void,
  signal?: AbortFlag,
): Promise<Exploration> {
  let latest: ToolEvent[] = [];
  const summary = await runAgent(
    executor,
    {
      system: explorePrompt(explorationId),
      user: `Brief: ${brief}`,
      // The orchestrator routes and reports; the design judgement happens
      // inside the tools. Cheap and near-deterministic is right.
      model: "openai/gpt-4o-mini",
      temperature: 0.1,
      // ~12 small tool calls plus a short summary. Arguments are indices and
      // labels — the cache keeps documents out of this budget entirely.
      maxTokens: 6000,
      plugins: [{ ...PHOSPHENE_PLUGIN }],
      // Nine sequential renders at ~40-60s each is the honest baseline, plus
      // a cold image build on first run. Stall covers the longest single
      // render; the timeout covers the whole exploration.
      timeoutSeconds: 1800,
      stallSeconds: 660,
    },
    (progress) => {
      latest = progress.tools;
      onProgress?.(progress);
    },
    signal,
  );

  return deriveExploration(latest, summary);
}

/**
 * Spawn a refine agent: one round of feedback applied to an existing
 * exploration. Same display contract as explore — the board updates as
 * refine_state results stream back.
 */
export async function refine(
  executor: CommandExecutor,
  explorationId: string,
  directionNames: string[],
  states: string[],
  feedback: string,
  onProgress?: (p: AgentProgress) => void,
  signal?: AbortFlag,
): Promise<Exploration> {
  let latest: ToolEvent[] = [];
  const summary = await runAgent(
    executor,
    {
      system: refinePrompt(explorationId, directionNames, states),
      user: `Feedback: ${feedback}`,
      model: "openai/gpt-4o-mini",
      temperature: 0.1,
      maxTokens: 4000,
      plugins: [{ ...PHOSPHENE_PLUGIN }],
      // At most 9 revisions at ~40-60s each, sequential.
      timeoutSeconds: 1200,
      stallSeconds: 660,
    },
    (progress) => {
      latest = progress.tools;
      onProgress?.(progress);
    },
    signal,
  );
  return deriveExploration(latest, summary);
}
