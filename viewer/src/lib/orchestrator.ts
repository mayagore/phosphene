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
  version: "v1.0.1",
} as const;

const explorePrompt = (explorationId: string) => `You explore design briefs using your phosphene tools. A human is watching the board fill in as you work — your tool calls ARE the product; your prose is only a closing summary.

Use exploration_id "${explorationId}" on EVERY tool call, verbatim.

The procedure:
1. Call phosphene_invent_directions ONCE with the user's brief. It returns 3 directions and 3 shared states.
2. Call phosphene_render_state once per (direction × state) — 9 calls, no more, no fewer, and NEVER the same (direction_index, label) twice. ONE CALL AT A TIME, always: issue a single tool call and wait for its result before the next — never batch tool calls in one turn. (Parallel renders contend for one runner; measured, they take 25–50 minutes each instead of ~2.) For each direction, render states[0] BEFORE its other two states (the tool pins the shared chrome from stored state; you never pass HTML — never pass anchor_html). Pass direction_index (0, 1 or 2), the full states array, and the label. If one render fails, continue with the rest — do NOT retry it.
3. If — and only if — the user named judge models, call phosphene_score_direction once per (direction × judge model) after that direction's states are rendered. Report every judge's scores separately; never average across judges.
4. TASTE PASS — only if step 3 ran. Same discipline: one call at a time, everywhere below. For each direction, read its judges' notes. SKIP any direction whose declared composition is a restraint strategy (centred-column, single-stack, or any strategy whose argument IS restraint) — measured twice, refinement sands exactly what restraint is made of, and both times two of three judges marked the refined board DOWN. For each remaining direction: if at least one note names a CONCRETE gap between what the direction declared and what the markup delivers (an arrangement not achieved, a named selector, a missing treatment), call phosphene_refine_state ONCE — states[0] only, direction_index and label, and the single most actionable note passed VERBATIM as feedback. At most one refine per direction, ever: refining twice sands off the direction's character (measured). A direction whose notes name no concrete gap gets NO refine — praise is not feedback. If a refine fails, continue; do NOT retry.
5. Re-judge ONLY the directions you refined, once per (refined direction × judge model) — same jury as step 3. The human sees the before and after verdicts; never average them.

After the final result, STOP CALLING TOOLS and write a closing summary of AT MOST 2 sentences. Do not restate the documents or scores — the human already watched them arrive.`;

const listPrompt = () => `You list this daemon's stored design explorations into the display. One instant read, no generation.

Call phosphene_list_explorations ONCE, with no arguments. Then say exactly "listed" and stop.`;

const resumePrompt = (
  explorationId: string,
) => `You replay an already-stored design exploration into the display. No generation — every call is an instant read. Use exploration_id "${explorationId}" on every call.

1. Call phosphene_get_exploration ONCE. It returns the directions and states.
2. Call phosphene_get_state once per (direction_index, label) — one call for every combination, never the same pair twice, direction_index 0 to N-1 in order. If one read fails, continue.

Then say exactly "resumed" and stop.`;

const refinePrompt = (
  explorationId: string,
  directions: string[],
  states: string[],
) => `You revise an already-rendered design exploration by applying the user's feedback with your phosphene_refine_state tool. A human is watching the board update.

Use exploration_id "${explorationId}" on EVERY call, verbatim. The exploration's directions, by direction_index: ${directions.map((n, i) => `${i}="${n}"`).join(", ")}. Its states: ${states.map((s) => `"${s}"`).join(", ")}.

Read the user's feedback and call phosphene_refine_state once per (direction_index, label) the feedback targets — never the same pair twice, ONE CALL AT A TIME (issue a single tool call, wait for its result) — passing the relevant part of the feedback verbatim as \`feedback\`. If it names one direction, revise that direction's affected states (all three only if the feedback is about the direction as a whole). If it clearly targets everything, revise every state of every direction. At least 1 call, at most 9. If one call fails, continue with the rest — do NOT retry it. After the last result, STOP CALLING TOOLS.

Then one closing sentence. Do not restate the documents.`;

/** Each driver's hard tool-CALL budget, mirrored for the run-budget chip —
 * the display shows the SAME ceiling the run is actually bounded by. (A
 * budget of calls, not of tools: the toolkit below is seven.)
 *
 * explore = 1 invent + 9 renders + 9 judges (3 judges × 3 directions) +
 * 3 taste-pass refines + 9 re-judges = 31. The budget is the ONLY real
 * enforcement of "refine once per direction" — the first headless taste
 * loop was told "exactly three refines" in prose and made four (prose
 * budgets drift; structural ones do not). A 32nd call is churn: abort. */
export const MAX_TOOL_CALLS = { explore: 31, refine: 9, resume: 10, list: 1 } as const;

/** The agent's toolkit — display-side mirror of the MCP half's seven tools
 * (mcp/src/main.rs). An agent is its JSON and its tools (docs/platform/
 * 05-agent-identity.md); the viewer exists to let a human SEE that agent
 * work, so the toolkit is named on the surface, prefixed exactly as the
 * agent receives it. */
export const PHOSPHENE_TOOLKIT = [
  { name: "phosphene_invent_directions", what: "invents contrasting directions and the shared states from your brief" },
  { name: "phosphene_render_state", what: "renders one direction × state artboard at 400×720" },
  { name: "phosphene_refine_state", what: "revises one artboard from your feedback" },
  { name: "phosphene_score_direction", what: "one judge model's verdict — four dimensions, written whys, measured facts" },
  { name: "phosphene_list_explorations", what: "lists every exploration stored on this daemon" },
  { name: "phosphene_get_exploration", what: "reads a stored exploration's directions and states" },
  { name: "phosphene_get_state", what: "reads one stored artboard" },
] as const;

export interface Exploration {
  invention?: Invention;
  /** `${directionIndex}:${label}` → cell state, derived from tool events. */
  cells: Record<string, CellStatus>;
  /** Score results in arrival order, verbatim from the tool. */
  scores: ScoreEvent[];
  /** Judges that died, kept VISIBLE — a silently missing verdict reads as
   * "never judged", which is a lie (review 01, H2). */
  judgeFailures: JudgeFailure[];
  /** Why the invention could not be read, when it could not. Kept VISIBLE for
   * the same reason as `judgeFailures`: a run that produced nothing and says
   * nothing reads as "not started yet", which is a lie. */
  inventionError?: string;
  /** The agent's closing prose. */
  summary?: string;
  tools: ToolEvent[];
}

export interface JudgeFailure {
  directionIndex?: number;
  model?: string;
  reason: string;
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
  const out: Exploration = { cells: {}, scores: [], judgeFailures: [], tools, summary };

  for (const event of tools) {
    if (event.name.endsWith("invent_directions") || event.name.endsWith("get_exploration")) {
      if (event.result) {
        try {
          out.invention = normalizeInvention(JSON.parse(event.result));
          out.inventionError = undefined;
        } catch (error) {
          // Recorded, not swallowed. The old comment here claimed this would
          // "surface as the run failing to produce directions" — it did not:
          // if the invention was the only bad result the agent could stop
          // cleanly and the user got a completed run over a blank board that
          // still said "Start exploring".
          out.inventionError =
            error instanceof Error ? error.message : "the invention result could not be read";
        }
      }
      continue;
    }

    if (event.name.endsWith("_state")) {
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
      const args = parseArgs(event.arguments);
      if (event.result.startsWith("tool call failed")) {
        // The judge died. The panel survives — and says so.
        out.judgeFailures.push({
          directionIndex:
            typeof args?.direction_index === "number" ? args.direction_index : undefined,
          model: typeof args?.model === "string" ? args.model : undefined,
          reason: event.result.slice(0, 240),
        });
        continue;
      }
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
        // Not a verdict at all (an error surface without the stream's
        // "tool call failed" prefix — e.g. a raw "MCP error …" string).
        // A dead judge must be VISIBLE, never silently skipped.
        out.judgeFailures.push({
          directionIndex:
            typeof args?.direction_index === "number" ? args.direction_index : undefined,
          model: typeof args?.model === "string" ? args.model : undefined,
          reason: event.result.slice(0, 240),
        });
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
      // Claude as orchestrator, probed 2026-08-04: followed a two-call
      // instruction exactly and STOPPED — the termination discipline mini
      // failed three times (5/9 underrun, the 29-call retry loop, the
      // non-terminating verify churn). Free on the subscription; thinking
      // off because this role routes rather than deliberates.
      upstream: "claude_agent_sdk",
      thinking: false,
      plugins: [{ ...PHOSPHENE_PLUGIN }],
      // Nine sequential renders at ~90-155s each (measured, E1-size boards),
      // plus judging, plus the taste pass: up to 3 refines at render cost
      // and 9 re-judges. Stall covers the longest single call; the timeout
      // covers the whole exploration — 9×155 + 9 judges + 3×155 + 9 judges
      // ≈ 2400s of work, so 3600 leaves honest headroom without masking a
      // hang (the stall watchdog catches those long before the timeout).
      timeoutSeconds: 3600,
      stallSeconds: 660,
      // See MAX_TOOL_CALLS — the structural budget IS the refine-once rule.
      maxToolCalls: MAX_TOOL_CALLS.explore,
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
      // Same probe-backed choice as explore — see the note there.
      upstream: "claude_agent_sdk",
      thinking: false,
      plugins: [{ ...PHOSPHENE_PLUGIN }],
      // At most 9 revisions at ~40-60s each, sequential.
      timeoutSeconds: 1200,
      stallSeconds: 660,
      maxToolCalls: MAX_TOOL_CALLS.refine,
    },
    (progress) => {
      latest = progress.tools;
      onProgress?.(progress);
    },
    signal,
  );
  return deriveExploration(latest, summary);
}

/** Replay a stored exploration into the display — pure reads, id is enough. */
/** A stored exploration as the daemon lists it — the viewer-side mirror of
 * the MCP half's ExplorationSummary. */
export interface StoredExploration {
  exploration_id: string;
  brief: string;
  directions: string[];
  boards: number;
  created_at: string;
}

/** List the daemon's stored explorations via a one-call agent. The viewer
 * never reaches the database itself — display doctrine — so even a listing
 * is an agent doing a read with a tool. Costs one instant tool call. */
export async function listStored(
  executor: CommandExecutor,
  signal?: AbortFlag,
): Promise<{ explorations: StoredExploration[]; truncated: boolean }> {
  let latest: ToolEvent[] = [];
  await runAgent(
    executor,
    {
      system: listPrompt(),
      user: "List the stored explorations.",
      upstream: "claude_agent_sdk",
      thinking: false,
      plugins: [{ ...PHOSPHENE_PLUGIN }],
      timeoutSeconds: 120,
      stallSeconds: 90,
      maxToolCalls: MAX_TOOL_CALLS.list,
    },
    (p) => {
      latest = p.tools;
    },
    signal,
  );
  const event = latest.find((t) => t.name.endsWith("list_explorations"));
  if (!event?.result) return { explorations: [], truncated: false };
  try {
    const parsed = JSON.parse(event.result) as {
      explorations?: StoredExploration[];
      truncated?: boolean;
    };
    return {
      explorations: Array.isArray(parsed.explorations) ? parsed.explorations : [],
      truncated: parsed.truncated === true,
    };
  } catch {
    return { explorations: [], truncated: false };
  }
}

export async function resume(
  executor: CommandExecutor,
  explorationId: string,
  onProgress?: (p: AgentProgress) => void,
  signal?: AbortFlag,
): Promise<Exploration> {
  let latest: ToolEvent[] = [];
  const summary = await runAgent(
    executor,
    {
      system: resumePrompt(explorationId),
      user: "Replay the exploration.",
      // Same probe-backed choice as explore — see the note there.
      upstream: "claude_agent_sdk",
      // Replay is pure instant reads — no design judgment anywhere in the
      // run, so the smallest model that can follow the call list wins on
      // both latency and cost. Verified live: the haiku alias resolves
      // through the runner and replays 9/9 cells lean.
      model: "haiku",
      thinking: false,
      plugins: [{ ...PHOSPHENE_PLUGIN }],
      timeoutSeconds: 300,
      stallSeconds: 120,
      // 1 get_exploration + up to 9 get_state.
      maxToolCalls: MAX_TOOL_CALLS.resume,
    },
    (progress) => {
      latest = progress.tools;
      onProgress?.(progress);
    },
    signal,
  );
  return deriveExploration(latest, summary);
}
