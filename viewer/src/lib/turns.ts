/**
 * The chat concept: the rail is an agent transcript where everything is a
 * Turn. Turns are DERIVED from run state on every stream tick — the same
 * pure-fold pattern as deriveExploration, never stored — so the transcript
 * always reflects the current run. Lifted from the legacy app's lib/turns.ts
 * (design-legacy/README.md); adapted to this architecture's data.
 *
 * Honesty rules (docs/scoring.md, docs/design.md): plan steps state only what
 * observed events prove; the judge step exists only once a verdict arrives
 * (judging happens only when the user named models — the transcript must not
 * promise otherwise); no combined scores, no cost, no target language.
 */
import type { Exploration } from "./orchestrator";
import type { ToolEvent } from "./agent";

export type RunMode = "explore" | "refine" | "resume";
export type RunPhase = "idle" | "exploring" | "done" | "failed";

export type Turn =
  | { kind: "user"; id: string; text: string }
  | { kind: "message"; id: string; text: string }
  | { kind: "plan"; id: string; steps: PlanStep[]; activity: ToolEvent[] }
  /* ranked + judges land in Phase B — the union carries them now so the
   * renderer is written once. */
  | { kind: "ranked"; id: string; label: string; items: RankedItem[] }
  | { kind: "judges"; id: string; failures: JudgeFailure[] }
  | { kind: "error"; id: string; text: string };

export interface PlanStep {
  label: string;
  done: boolean;
  /** Live progress, e.g. "7/9" or "3 verdicts" — real counts only. */
  detail?: string;
}

export interface RankedItem {
  directionIndex: number;
  name: string;
  /** Median across judges within ONE dimension — never across dimensions. */
  median: number | null;
  range: [number, number] | null;
  judges: number;
  leading: boolean;
}

export interface JudgeFailure {
  directionIndex?: number;
  model?: string;
  reason: string;
}

export interface TurnsInput {
  phase: RunPhase;
  mode: RunMode;
  /** The brief, then each refine feedback, in send order. */
  prompts: string[];
  /** The merged exploration the board renders — same object, same truth. */
  exploration?: Exploration;
  /** Failure reason when phase === "failed". */
  failure?: string;
}

const GREETING =
  "What should we design? Describe a brief — I'll invent contrasting directions and render each across shared states. Name judge models and every verdict lands here too.";

export function deriveTurns(input: TurnsInput): Turn[] {
  const { phase, mode, prompts, exploration, failure } = input;
  const turns: Turn[] = [];

  if (phase === "idle") {
    turns.push({ kind: "message", id: "greeting", text: GREETING });
    return turns;
  }

  if (prompts[0]) turns.push({ kind: "user", id: "user-0", text: prompts[0] });

  const invention = exploration?.invention;
  const cells = exploration?.cells ?? {};
  const scores = exploration?.scores ?? [];
  const tools = exploration?.tools ?? [];
  const doneCells = Object.values(cells).filter((c) => c.phase === "done").length;
  const failedCells = Object.values(cells).filter((c) => c.phase === "failed").length;
  const totalCells = invention
    ? invention.directions.length * invention.states.length
    : 0;

  turns.push({
    kind: "message",
    id: "working",
    text:
      mode === "resume"
        ? "Replaying the stored board — every call is an instant read, nothing regenerates."
        : mode === "refine"
          ? "Applying your feedback — only the cells it names are revised, in place."
          : invention
            ? `Exploring ${invention.directions.length} directions across ${invention.states.length} shared states.`
            : "Exploring the brief — inventing contrasting directions first.",
  });

  const renderDetail =
    totalCells > 0
      ? `${doneCells + failedCells}/${totalCells}${failedCells > 0 ? ` · ${failedCells} failed` : ""}`
      : undefined;

  const steps: PlanStep[] =
    mode === "resume"
      ? [
          { label: "Read the stored exploration", done: Boolean(invention) },
          {
            label: "Load every artboard",
            done: totalCells > 0 && doneCells + failedCells >= totalCells,
            detail: renderDetail,
          },
        ]
      : [
          {
            label: "Invent directions",
            done: Boolean(invention),
            detail: invention
              ? `${invention.directions.length} directions · ${invention.states.length} states`
              : undefined,
          },
          {
            label:
              mode === "refine"
                ? "Revise the cells the feedback names"
                : "Render direction × state artboards",
            done: totalCells > 0 && doneCells + failedCells >= totalCells && phase !== "exploring",
            detail: renderDetail,
          },
          // Only once a verdict exists — judging happens only when models were named.
          ...(scores.length > 0
            ? [
                {
                  label: "Judge with vision agents",
                  done: phase !== "exploring",
                  detail: `${scores.length} verdict${scores.length === 1 ? "" : "s"}`,
                },
              ]
            : []),
        ];

  turns.push({
    kind: "plan",
    id: "plan",
    steps,
    activity: phase === "exploring" ? tools.slice(-8) : [],
  });

  // Refine feedbacks after the first prompt, in order.
  for (let i = 1; i < prompts.length; i++) {
    turns.push({ kind: "user", id: `user-${i}`, text: prompts[i]! });
  }

  if (phase === "failed" && failure) {
    turns.push({ kind: "error", id: "error", text: failure });
  }

  if (phase === "done" && exploration?.summary) {
    turns.push({ kind: "message", id: "summary", text: exploration.summary });
  }

  return turns;
}
