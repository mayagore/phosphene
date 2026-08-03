/**
 * The architecture Ronald described, from the viewer's side.
 *
 * The tab does NOT do the work. It spawns ONE agent that declares phosphene's
 * plugin, and that agent calls phosphene's tools — `phosphene_invent_directions`,
 * `phosphene_render_state` — inside a container, each of which spawns its own
 * agent completion back through the host. The tab's whole job is to render what
 * that agent is doing.
 *
 * Verified from the CLI on 2026-08-02: agent → tool → nested agent → structured
 * result, 11s, zero errors (docs/spikes/02-plugin-authoring.md §4b). What this
 * module tests is the part that CLI run could not: whether the same call works
 * over the VIEWER transport, where commands ride `daemon_execute` through Tauri.
 *
 * The one thing that could stop it: an agent declaring `plugins` needs a
 * reverse-attached CLI, or the API fails it `ClientObjectiveaiMcpUnavailable`
 * (objectiveai-api/src/agent/completions/client.rs:1044-1057). A CLI-spawned
 * agent qualifies. Whether a viewer tab does is the open question.
 */
import type { CommandExecutor } from "@objectiveai/sdk";
import {
  runAgent,
  type AbortFlag,
  type AgentProgress,
  type ToolEvent,
} from "./agent";
import { normalizeInvention, type Invention } from "./directions";

/** The trio must match the registration BYTE FOR BYTE. `v0.1.0` and `0.1.0`
 * are different keys, and a mismatch is silent — the plugin simply builds from
 * GitHub as though nothing were registered. */
export const PHOSPHENE_PLUGIN = {
  owner: "mayagore",
  name: "phosphene",
  version: "v0.1.0",
} as const;

const ORCHESTRATOR_PROMPT = `You explore design briefs using your phosphene tools.

Call phosphene_invent_directions exactly once, with the user's brief. Then report, in plain prose, the name and mood of each direction it returned. Do not invent directions yourself and do not call the tool more than once.`;

export interface OrchestratedInvention {
  invention: Invention;
  /** What the agent said after its tools came back. */
  summary: string;
  tools: ToolEvent[];
}

/**
 * Ask an agent to invent directions BY CALLING PHOSPHENE'S TOOL, and return
 * both the structured result and the agent's own account of it.
 *
 * The structured value is read out of the tool's own reply rather than parsed
 * from the agent's prose: the tool already returned typed JSON, and asking a
 * model to relay it faithfully is a step that can only lose information.
 */
export async function inventViaTools(
  executor: CommandExecutor,
  brief: string,
  onProgress?: (p: AgentProgress) => void,
  signal?: AbortFlag,
): Promise<OrchestratedInvention> {
  let latest: ToolEvent[] = [];

  const summary = await runAgent(
    executor,
    {
      system: ORCHESTRATOR_PROMPT,
      user: `Brief: ${brief}`,
      // The orchestrator only routes and reports — the design judgement all
      // happens inside the tools, so this can be cheap and near-deterministic.
      model: "openai/gpt-4o-mini",
      temperature: 0.2,
      maxTokens: 1500,
      plugins: [{ ...PHOSPHENE_PLUGIN }],
      // A cold plugin image build runs minutes before the first call returns,
      // and a build that OOMs takes ~4 minutes to say so.
      timeoutSeconds: 1800,
      stallSeconds: 600,
    },
    (progress) => {
      latest = progress.tools;
      onProgress?.(progress);
    },
    signal,
  );

  const invented = latest.find(
    (tool) => tool.name.endsWith("invent_directions") && tool.result,
  );
  if (!invented?.result) {
    throw new Error(
      latest.length === 0
        ? "the agent never called a tool"
        : `no invent_directions result — the agent called ${latest
            .map((t) => t.name)
            .join(", ")}`,
    );
  }

  return {
    invention: normalizeInvention(JSON.parse(invented.result)),
    summary,
    tools: latest,
  };
}
