/**
 * One agent completion through the daemon, folded into one string.
 *
 * ARCHITECTURE (HANDOFF §"ARCHITECTURE CHANGED"): every unit of work phosphene
 * does is an AGENT COMPLETION spawned through the daemon. No functions — that
 * layer is being replaced by a provider spec. The viewer spawns and displays;
 * it never reaches an upstream itself.
 *
 * This module is the single place that knows the request shape and the stream
 * shape, because both have sharp edges (see `system_prompt` and the delta
 * accumulation below) and two copies would grow apart.
 */
import { agentsSpawnExecuteStreaming, type CommandExecutor } from "@objectiveai/sdk";

/** Cheap and reliable at structured output. Tunable — quality work later. */
export const DEFAULT_MODEL = "openai/gpt-4o-mini";

/**
 * Which upstream runs the completion.
 *
 * `claude_agent_sdk` runs on the machine's own Claude Code login — no key, BYOK
 * explicitly rejected — and reports ZERO cost and ZERO tokens through
 * ObjectiveAI. Measured 2026-08-03 on a real artboard: 9,280 chars in 33s at
 * no charge, against 6,179 chars for the same direction and state on
 * openrouter. Denser output, free.
 *
 * The trade: no token metering on that path either, so a spend ceiling cannot
 * be enforced from usage. And it needs a live `claude` login — when the OAuth
 * token lapses ObjectiveAI reports it as the nonsense string "Claude Code
 * returned an error result: success" (it surfaces the SDK's `subtype` rather
 * than its 401).
 */
export type Upstream = "openrouter" | "claude_agent_sdk";

export interface AgentRun {
  system: string;
  user: string;
  upstream?: Upstream;
  model?: string;
  /** openrouter only — the field does not exist on claude_agent_sdk. */
  temperature?: number;
  /** openrouter only — the field does not exist on claude_agent_sdk. */
  maxTokens?: number;
  /**
   * claude_agent_sdk only. Defaults to OFF, because thinking tokens are drawn
   * from the same budget as output and that is precisely what hit the legacy
   * app's 32K ceiling — and this upstream has no `max_tokens` to raise instead.
   * Turn it on where the task needs deliberation more than length.
   */
  thinking?: boolean;
  /** Hard ceiling handed to the daemon. */
  timeoutSeconds?: number;
  /**
   * Hard cap on tool CALLS in one run. The 2026-08-03 incident: an
   * open-ended "verify" instruction sent the orchestrator into 18+ minutes
   * of post-completion churn that only the 30-minute daemon timeout ended.
   * A run that exceeds its budget is aborted with a NAMED error instead.
   */
  maxToolCalls?: number;
  /**
   * Abort if no chunk arrives for this long. This is the lesson legacy paid
   * seven commits for (docs/legacy §5): hang detection belongs on the GAP
   * BETWEEN CHUNKS, not on total duration, because a healthy generation
   * legitimately runs for many minutes while a wedged one goes silent
   * immediately. `timeoutSeconds` is the labelled backstop and must strictly
   * outlast this.
   */
  stallSeconds?: number;
  /**
   * Plugins whose tools this agent may call. ONE plugin IS ONE MCP server, and
   * the trio must match a registration BYTE FOR BYTE — `v0.1.0` and `0.1.0`
   * are different keys and a mismatch is silent.
   *
   * Declaring any plugin requires a running laboratory host
   * (`objectiveai laboratories spawn`), which is never auto-started.
   */
  plugins?: Array<{ owner: string; name: string; version: string }>;
}

/** One tool call the agent made, and its answer once it arrives. */
export interface ToolEvent {
  /** Prefixed by the plugin's name — e.g. `phosphene_invent_directions`. */
  name: string;
  /** Raw JSON arguments, streamed as a string and reassembled. */
  arguments: string;
  /** The tool's reply, once the run loop has dispatched it. */
  result?: string;
}

export interface AgentProgress {
  /** The agent instance hierarchy, once the daemon has minted it. */
  aih?: string;
  /** Characters of assistant output so far. */
  streamed: number;
  /**
   * What the agent is doing with its tools — the whole reason the viewer half
   * exists. Ordered by the tool-call index the upstream assigned.
   */
  tools: ToolEvent[];
}

/** Cooperative cancellation. A plain object so a caller can flip it after the
 * fact without threading an AbortController through every layer. */
export interface AbortFlag {
  aborted: boolean;
}

/**
 * Spawn one agent and return everything it said.
 *
 * The stream's first item is a bare string (the agent instance hierarchy);
 * every later item is an `agent.completion.chunk` whose `messages[].content`
 * are DELTAS accumulated by `index`. Verified against a live capture.
 */
export async function runAgent(
  executor: CommandExecutor,
  run: AgentRun,
  onProgress?: (p: AgentProgress) => void,
  signal?: AbortFlag,
): Promise<string> {
  const stallMs = (run.stallSeconds ?? 120) * 1000;

  // The two upstreams take DIFFERENT specs, and getting it wrong is silent:
  // the agent union is untagged with no `deny_unknown_fields`, so a stray
  // `temperature` on a claude_agent_sdk agent is dropped with no error — and
  // since the agent id hashes the normalized struct, there is no signal at
  // all. Hence one branch per upstream rather than a shared object.
  const resolved =
    run.upstream === "claude_agent_sdk"
      ? {
          upstream: "claude_agent_sdk",
          // A short alias, not a dated model id — the runner passes it
          // straight to the local `claude` binary, and a dated id was
          // measured failing where "sonnet" resolved.
          model: run.model ?? "sonnet",
          // Required, and the only legal value. Documented as ignored for
          // agent completions, but omitting it fails deserialization.
          output_mode: "instruction",
          // The ONLY lever on the 32K output ceiling, and thinking tokens are
          // exactly what consumed the legacy app's output budget. There is no
          // `max_tokens` on this upstream to raise instead.
          thinking: run.thinking ?? false,
          plugins: run.plugins ?? [],
          // A bare string here. NOT {role, content} — that is openrouter's shape.
          system_prompt: run.system,
        }
      : {
          upstream: "openrouter",
          model: run.model ?? DEFAULT_MODEL,
          temperature: run.temperature ?? 0.9,
          max_tokens: run.maxTokens ?? 2000,
          plugins: run.plugins ?? [],
          // `system_prompt` is {role, content}, NOT a bare string — a string
          // fails deserialization with the untagged-enum error that names the
          // whole agent union and points nowhere useful. Role is
          // "system" | "developer" (agent.openrouter.SystemPromptRole).
          system_prompt: { role: "system", content: run.system },
        };

  const request = {
    agent: { by: "ref", agent: { Resolved: resolved } },
    message: { Simple: run.user },
    timeout_seconds: run.timeoutSeconds ?? 180,
  };

  const parts = new Map<number, string>();
  // Tool calls arrive as DELTAS on assistant messages, reassembled by their own
  // `index` — a separate space from the message index. Confirmed on the wire.
  //
  // CALL INDEXES RESTART EVERY TURN. A multi-turn run reuses index 0 for its
  // next turn's first call, so one Map keyed by index would concatenate two
  // different calls into garbage (observed live: a 30-call run produced one
  // event named "phosphene_render_statephosphene_score_direction…"). Hence
  // two structures: in-flight calls keyed by index, moved to `completed` when
  // their result lands — which is what frees the index for the next turn.
  // Results attach oldest-first because the run loop dispatches sequentially.
  const completed: ToolEvent[] = [];
  const inflight = new Map<number, ToolEvent>();
  let aih: string | undefined;
  const snapshot = (): AgentProgress => ({
    aih,
    streamed: [...parts.values()].reduce((n, s) => n + s.length, 0),
    tools: [
      ...completed,
      ...[...inflight.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t),
    ],
  });

  const stream = agentsSpawnExecuteStreaming(executor, request as never);
  // Driven by hand rather than `for await` so each `next()` can be raced
  // against the stall watchdog.
  const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal?.aborted) break;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the agent went silent for ${run.stallSeconds ?? 120}s`)),
          stallMs,
        );
      });
      let next: IteratorResult<unknown>;
      try {
        next = await Promise.race([iterator.next(), stalled]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) break;

      const item = next.value;
      if (typeof item === "string") {
        aih = item;
        onProgress?.(snapshot());
        continue;
      }
      const chunk = item as {
        type?: string;
        message?: unknown;
        messages?: Array<{
          role?: string;
          index?: number;
          content?: unknown;
          tool_calls?: Array<{
            index?: number;
            function?: { name?: string; arguments?: string };
          }>;
        }>;
      };
      if (chunk?.type === "error") {
        throw new Error(
          `the agent failed: ${JSON.stringify(chunk.message).slice(0, 200)}`,
        );
      }
      for (const m of chunk.messages ?? []) {
        // A TOOL message is not a delta: it arrives whole, and it shares the
        // assistant `index` space. Appending one to the assistant buffer would
        // silently corrupt the output — hence an exact match on `role`, and
        // never a default branch.
        if (m.role === "tool") {
          if (typeof m.content === "string") {
            // Answers come back in call order: attach to the oldest
            // unanswered call and RETIRE it, freeing its index for the
            // next turn.
            const oldest = [...inflight.entries()].sort((a, b) => a[0] - b[0])[0];
            if (oldest) {
              oldest[1].result = m.content;
              completed.push(oldest[1]);
              inflight.delete(oldest[0]);
            }
          }
          continue;
        }
        if (m.role !== "assistant") continue;
        for (const call of m.tool_calls ?? []) {
          const i = call.index ?? 0;
          if (
            run.maxToolCalls !== undefined &&
            !inflight.has(i) &&
            completed.length + inflight.size >= run.maxToolCalls
          ) {
            throw new Error(
              `the agent exceeded its ${run.maxToolCalls} tool-call budget — ` +
                `aborted rather than churning to the timeout`,
            );
          }
          const event = inflight.get(i) ?? { name: "", arguments: "" };
          if (call.function?.name) event.name += call.function.name;
          if (call.function?.arguments) event.arguments += call.function.arguments;
          inflight.set(i, event);
        }
        if (typeof m.content !== "string") continue;
        const i = m.index ?? 0;
        parts.set(i, (parts.get(i) ?? "") + m.content);
      }
      onProgress?.(snapshot());
    }
  } finally {
    // Whether we stalled, threw, or were cancelled, tell the stream we are done
    // with it — an orphaned `next()` otherwise keeps the lane alive.
    await iterator.return?.(undefined).catch(() => undefined);
  }

  const text = [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => s)
    .join("");
  // An agent that only called tools and never spoke has still done work, so
  // silence is only a failure when nothing happened at all.
  if (
    text.trim().length === 0 &&
    completed.length === 0 &&
    inflight.size === 0 &&
    !signal?.aborted
  ) {
    // Distinguish "model said nothing" from "we cannot parse" — the legacy app
    // reported the former as a parser bug for weeks.
    throw new Error("the agent returned an empty response");
  }
  return text;
}

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
  const attempt = (slice: string): unknown => {
    try {
      return JSON.parse(slice);
    } catch {
      // A trailing comma before `}` or `]` is the one malformation models
      // produce often enough to be worth repairing, and the only one that is
      // unambiguous: JSON has no construct where it is meaningful, so removing
      // it cannot change what the model meant. Anything beyond this is
      // guessing, and guessing is how the legacy salvage ladder grew to four
      // layers. Observed live, on invention output.
      return JSON.parse(stripTrailingCommas(slice));
    }
  };

  try {
    return attempt(fenced);
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
      if (depth === 0) return attempt(fenced.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON in the model's response");
}

/** Remove `,` that only separates nothing from a closing brace or bracket.
 * String contents are skipped, so a comma inside a value is untouched. */
export function stripTrailingCommas(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Look past whitespace: a comma followed by a closer separates nothing.
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      if (json[j] === "}" || json[j] === "]") continue; // drop it
    }
    out += ch;
  }
  return out;
}
