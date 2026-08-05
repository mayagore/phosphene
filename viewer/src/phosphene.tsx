/**
 * Phosphene's boot tab — declared in `objectiveai.json` as `viewer.tabs[0]`.
 *
 * ARCHITECTURE. The tab is a DISPLAY. One composer spawns ONE agent that
 * declares phosphene's plugin and does all the work — inventing, rendering,
 * judging — by calling phosphene's tools. Everything on screen is DERIVED
 * from that agent's tool-event stream: the arguments name the cell, the
 * results carry the documents and verdicts. The tab holds no work of its own;
 * it is the human's window onto the agent.
 *
 * SHAPE. The chat concept (design-legacy/, docs/design.md): three panels —
 * the rail is an agent transcript where everything is a Turn, the center is
 * the board, the inspector is where judgment becomes visible. One composer;
 * its action follows the run's phase (explore → refine → retry).
 *
 * Host contracts this file lives under (docs/platform/01-viewer.md):
 *   1. It receives ONE prop, `arguments`, and a manifest-declared boot tab is
 *      always opened with none — so at boot it is undefined.
 *   2. Everything else comes from the harness: the daemon transport and the
 *      window's zoom. No theme (we own our own), no router, no host state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Client, functionsListExecute } from "@objectiveai/sdk";
import { transport } from "./transport";
import { cellKey } from "./lib/board";
import {
  MAX_TOOL_CALLS,
  deriveExploration,
  explore,
  refine,
  resume,
  type Exploration,
} from "./lib/orchestrator";
import { deriveTurns, type RunMode } from "./lib/turns";
import { rankDirections, type Dimension } from "./lib/scores";
import { loadHistory, recordHistory, type HistoryEntry } from "./lib/history";
import Rail, { type RailBudget, type RailComposer, type RailHealth } from "./components/Rail";
import Board, { type BoardSelection, type StatusTone, type Zoomed } from "./components/Board";
import Inspector from "./components/Inspector";

interface TabProps {
  arguments?: unknown;
}

type Health =
  | { state: "connecting" }
  | { state: "ready"; roundTripMs: number }
  | { state: "unavailable"; reason: string };

type Run =
  | { phase: "idle" }
  | {
      phase: "exploring";
      mode: RunMode;
      startedAt: number;
      /** The brief, then each refine feedback, in send order — the transcript's
       * user turns. */
      prompts: string[];
      brief: string;
      explorationId: string;
      aih?: string;
      exploration: Exploration;
      /** Prior rounds' merged board, kept under the live run so a refine
       * round updates cells in place instead of blanking the board. */
      base?: Exploration;
    }
  | {
      phase: "done";
      mode: RunMode;
      startedAt: number;
      endedAt: number;
      prompts: string[];
      brief: string;
      explorationId: string;
      exploration: Exploration;
    }
  | {
      phase: "failed";
      mode: RunMode;
      startedAt: number;
      endedAt: number;
      prompts: string[];
      brief: string;
      explorationId?: string;
      reason: string;
      exploration?: Exploration;
    };

/** Later rounds win cell-by-cell; scores and judge failures accumulate;
 * invention persists. */
function mergeExploration(base: Exploration | undefined, current: Exploration): Exploration {
  if (!base) return current;
  return {
    invention: current.invention ?? base.invention,
    cells: { ...base.cells, ...current.cells },
    scores: [...base.scores, ...current.scores],
    judgeFailures: [...base.judgeFailures, ...current.judgeFailures],
    summary: current.summary ?? base.summary,
    tools: current.tools,
  };
}

/** localStorage keys live under `phosphene.*` — the origin is shared by every
 * tab in the viewer (spikes/01 §E), so exclusivity is never assumed. History
 * itself lives in lib/history.ts. */
const THEME_KEY = "phosphene.theme";
const preferredKey = (explorationId: string) => `phosphene.preferred.${explorationId}`;

type Theme = "dark" | "light";

function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Prove the daemon is REACHABLE, not merely that a client object constructed:
 * `functions list` is the cheapest read-only round trip through the whole
 * SDK → Tauri IPC → daemon path. An empty result is healthy.
 */
async function checkDaemon(): Promise<Health> {
  const started = performance.now();
  try {
    const t = await transport();
    const client = Client.viewer(t);
    const stream = functionsListExecute(client, {} as never);
    for await (const item of stream as AsyncIterable<unknown>) {
      const chunk = item as { type?: string; message?: unknown };
      if (chunk?.type === "error") {
        console.error("phosphene: daemon returned an error", chunk.message);
        return {
          state: "unavailable",
          reason: JSON.stringify(chunk.message).slice(0, 160),
        };
      }
      break;
    }
    const roundTripMs = Math.round(performance.now() - started);
    // console.* is the sanctioned path to the viewer's log inbox — exactly
    // where "did phosphene come up" belongs when someone reports a blank tab.
    console.info(`phosphene: ready · daemon round trip ${roundTripMs}ms`);
    return { state: "ready", roundTripMs };
  } catch (error) {
    console.error("phosphene: daemon transport unavailable", error);
    return { state: "unavailable", reason: String(error).slice(0, 200) };
  }
}

export default function Phosphene({ arguments: _args }: TabProps) {
  const [health, setHealth] = useState<Health>({ state: "connecting" });
  const [composerText, setComposerText] = useState("");
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [zoomed, setZoomed] = useState<Zoomed | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [selection, setSelection] = useState<BoardSelection>(null);
  const [rankDimension, setRankDimension] = useState<Dimension>("fitness");
  const [preferred, setPreferred] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const abort = useRef<{ aborted: boolean }>({ aborted: false });
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let disposed = false;
    void checkDaemon().then((next) => {
      if (!disposed) setHealth(next);
    });
    return () => {
      disposed = true;
      // KNOWN LIMIT: breaking the stream cancels the daemon-side run, so
      // closing the tab kills the agent mid-work. The fix is reattach-by-AIH
      // (agentsInstancesListener) — a future slice; noted rather than hidden.
      abort.current.aborted = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A theme that doesn't persist is still a theme.
    }
  }, [theme]);

  // Escape walks outward: zoom first, then selection.
  useEffect(() => {
    if (!zoomed && !selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (zoomed) setZoomed(null);
      else setSelection(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoomed, selection]);

  // Preference is scoped to the exploration and outlives the webview.
  const explorationId = run.phase === "idle" ? undefined : run.explorationId;
  useEffect(() => {
    if (!explorationId) {
      setPreferred(null);
      return;
    }
    try {
      const raw = localStorage.getItem(preferredKey(explorationId));
      const parsed = raw === null ? NaN : Number(raw);
      setPreferred(Number.isInteger(parsed) ? parsed : null);
    } catch {
      setPreferred(null);
    }
  }, [explorationId]);

  const togglePrefer = useCallback(
    (directionIndex: number) => {
      if (!explorationId) return;
      setPreferred((prev) => {
        const next = prev === directionIndex ? null : directionIndex;
        try {
          if (next === null) localStorage.removeItem(preferredKey(explorationId));
          else localStorage.setItem(preferredKey(explorationId), String(next));
        } catch {
          // Preference that doesn't persist still steers this session.
        }
        return next;
      });
    },
    [explorationId],
  );

  const remember = useCallback((id: string, brief: string) => {
    setHistory(recordHistory({ explorationId: id, brief, when: Date.now() }));
  }, []);

  const doResume = useCallback(
    async (id: string, label: string) => {
      if (run.phase === "exploring") return;
      abort.current = { aborted: false };
      const signal = abort.current;
      const startedAt = Date.now();
      setRun({
        phase: "exploring",
        mode: "resume",
        startedAt,
        prompts: [label],
        brief: label,
        explorationId: id,
        exploration: deriveExploration([]),
      });
      try {
        const client = Client.viewer(await transport());
        const replay = await resume(
          client,
          id,
          (p) =>
            setRun((prev) =>
              prev.phase === "exploring"
                ? { ...prev, aih: p.aih, exploration: deriveExploration(p.tools) }
                : prev,
            ),
          signal,
        );
        console.info(`phosphene: resumed — ${replay.tools.length} reads`);
        if (!signal.aborted) {
          setRun({
            phase: "done",
            mode: "resume",
            startedAt,
            endedAt: Date.now(),
            prompts: [label],
            brief: label,
            explorationId: id,
            exploration: replay,
          });
          if (replay.invention) remember(id, label);
        }
      } catch (error) {
        console.error("phosphene: resume failed", error);
        if (!signal.aborted) {
          setRun({
            phase: "failed",
            mode: "resume",
            startedAt,
            endedAt: Date.now(),
            prompts: [label],
            brief: label,
            explorationId: id,
            reason: String(error).slice(0, 300),
          });
        }
      }
    },
    [run.phase, remember],
  );

  const start = useCallback(async () => {
    const text = composerText.trim();
    if (text.length === 0 || run.phase === "exploring") return;
    // Escape hatch: `resume:<exploration-id>` replays any stored board by id —
    // including boards from runs that never reached done (where history was
    // never written). The database is the truth; this is just a key.
    if (text.toLowerCase().startsWith("resume:")) {
      const id = text.slice("resume:".length).trim();
      setComposerText("");
      if (id) void doResume(id, `resumed ${id.slice(0, 8)}…`);
      return;
    }
    abort.current = { aborted: false };
    const signal = abort.current;
    // The id is the name of the WORK, not of the run — refine rounds and any
    // future reattach key off it, and every database row is scoped by it.
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    setComposerText("");
    setSelection(null);
    setRun({
      phase: "exploring",
      mode: "explore",
      startedAt,
      prompts: [text],
      brief: text,
      explorationId: id,
      exploration: deriveExploration([]),
    });
    try {
      const client = Client.viewer(await transport());
      const exploration = await explore(
        client,
        id,
        text,
        (p) =>
          setRun((prev) =>
            prev.phase === "exploring"
              ? { ...prev, aih: p.aih, exploration: deriveExploration(p.tools) }
              : prev,
          ),
        signal,
      );
      console.info(
        `phosphene: exploration done — ${exploration.tools.length} tool calls`,
      );
      if (!signal.aborted) {
        setRun({
          phase: "done",
          mode: "explore",
          startedAt,
          endedAt: Date.now(),
          prompts: [text],
          brief: text,
          explorationId: id,
          exploration,
        });
        if (exploration.invention) remember(id, text);
      }
    } catch (error) {
      console.error("phosphene: exploration failed", error);
      if (!signal.aborted) {
        // Put the brief back in the composer so retry is one keystroke.
        setComposerText((prev) => (prev.length > 0 ? prev : text));
        setRun((prev) => ({
          phase: "failed",
          mode: "explore",
          startedAt,
          endedAt: Date.now(),
          prompts: [text],
          brief: text,
          explorationId: id,
          reason: String(error).slice(0, 300),
          // Keep whatever the board had — a failed run with 7 rendered cells
          // should show 7 cells and the error, not a blank page.
          exploration: prev.phase === "exploring" ? prev.exploration : undefined,
        }));
      }
    }
  }, [composerText, run.phase, doResume, remember]);

  /** The stop control: flips the abort flag, which breaks the stream — and
   * breaking the stream cancels the daemon-side run. The formerly-undocumented
   * close-tab behaviour, promoted to a button. */
  const stop = useCallback(() => {
    if (run.phase !== "exploring") return;
    abort.current.aborted = true;
    setRun((prev) =>
      prev.phase === "exploring"
        ? {
            phase: "failed",
            mode: prev.mode,
            startedAt: prev.startedAt,
            endedAt: Date.now(),
            prompts: prev.prompts,
            brief: prev.brief,
            explorationId: prev.explorationId,
            reason: "stopped by you — the board keeps everything already rendered",
            exploration: mergeExploration(prev.base, prev.exploration),
          }
        : prev,
    );
  }, [run.phase]);

  const sendFeedback = useCallback(async () => {
    const text = composerText.trim();
    if (text.length === 0 || run.phase !== "done") return;
    const {
      explorationId: id,
      exploration: prior,
      brief: priorBrief,
      prompts: priorPrompts,
    } = run;
    const invention = prior.invention;
    if (!invention) return;
    abort.current = { aborted: false };
    const signal = abort.current;
    const startedAt = Date.now();
    const prompts = [...priorPrompts, text];
    // The preferred direction rides along as context — the agent anchors on
    // its stored boards (render_state pins anchors from the plugin's cache).
    // The transcript records only the user's own words.
    const preferredDirection = preferred !== null ? invention.directions[preferred] : undefined;
    const feedbackForAgent = preferredDirection
      ? `The user marked "${preferredDirection.name}" (direction_index ${preferred}) as preferred — keep it the anchor: do not regress it, and bias continuity toward it where the feedback is ambiguous. Feedback: ${text}`
      : text;
    setComposerText("");
    setRun({
      phase: "exploring",
      mode: "refine",
      startedAt,
      prompts,
      brief: priorBrief,
      explorationId: id,
      exploration: deriveExploration([]),
      base: prior,
    });
    try {
      const client = Client.viewer(await transport());
      const round = await refine(
        client,
        id,
        invention.directions.map((d) => d.name),
        invention.states,
        feedbackForAgent,
        (p) =>
          setRun((prev) =>
            prev.phase === "exploring"
              ? { ...prev, aih: p.aih, exploration: deriveExploration(p.tools) }
              : prev,
          ),
        signal,
      );
      console.info(`phosphene: refine done — ${round.tools.length} tool calls`);
      if (!signal.aborted) {
        const merged = mergeExploration(prior, round);
        setRun({
          phase: "done",
          mode: "refine",
          startedAt,
          endedAt: Date.now(),
          prompts,
          brief: priorBrief,
          explorationId: id,
          exploration: merged,
        });
        if (merged.invention) remember(id, priorBrief);
      }
    } catch (error) {
      console.error("phosphene: refine failed", error);
      if (!signal.aborted) {
        setComposerText((prev) => (prev.length > 0 ? prev : text));
        setRun({
          phase: "failed",
          mode: "refine",
          startedAt,
          endedAt: Date.now(),
          prompts,
          brief: priorBrief,
          explorationId: id,
          reason: String(error).slice(0, 300),
          exploration: prior,
        });
      }
    }
  }, [composerText, run, preferred, remember]);

  // ── Derived, per stream tick ─────────────────────────────────────────────

  const busy = run.phase === "exploring";
  const exploration =
    run.phase === "idle"
      ? undefined
      : run.phase === "exploring"
        ? mergeExploration(run.base, run.exploration)
        : run.exploration;
  const invention = exploration?.invention;
  const cells = exploration?.cells ?? {};
  const scores = exploration?.scores ?? [];
  const doneCount = Object.values(cells).filter((c) => c.phase === "done").length;
  const failedCount = Object.values(cells).filter((c) => c.phase === "failed").length;
  const totalCells = invention
    ? invention.directions.length * invention.states.length
    : 0;

  const ranks =
    invention && scores.length > 0
      ? rankDirections(scores, invention.directions.length, rankDimension)
      : undefined;
  const scoredCount = ranks?.filter((r) => r.rank !== null).length ?? 0;

  const turns = deriveTurns({
    phase: run.phase,
    mode: run.phase === "idle" ? "explore" : run.mode,
    prompts: run.phase === "idle" ? [] : run.prompts,
    exploration,
    failure: run.phase === "failed" ? run.reason : undefined,
    rankDimension,
  });

  // Elapsed comes from render time on stream ticks — never a timer (an
  // occluded window throttles timers to ~2/s; streams don't pace us).
  const budget: RailBudget | undefined =
    run.phase === "idle"
      ? undefined
      : {
          tools: exploration?.tools.length ?? 0,
          maxTools: MAX_TOOL_CALLS[run.mode],
          kb: (exploration?.tools ?? []).reduce((n, t) => n + (t.result?.length ?? 0), 0) / 1024,
          judges: new Set(scores.map((s) => s.judge)).size,
          elapsedSec: Math.max(
            0,
            Math.round(
              ((run.phase === "exploring" ? Date.now() : run.endedAt) - run.startedAt) / 1000,
            ),
          ),
        };

  const chips = invention
    ? [
        `${invention.directions.length} direction${invention.directions.length === 1 ? "" : "s"}`,
        `${invention.states.length} state${invention.states.length === 1 ? "" : "s"}`,
      ]
    : [];

  const railHealth: RailHealth = {
    state: health.state,
    text:
      health.state === "connecting"
        ? "connecting to the daemon…"
        : health.state === "ready"
          ? `daemon reachable · ${health.roundTripMs}ms`
          : "daemon not reachable — start the stack and this clears",
  };

  const lastRun = !busy && run.phase === "idle" ? history[0] : undefined;
  const composer: RailComposer = {
    value: composerText,
    placeholder:
      run.phase === "done"
        ? `Describe a change — e.g. make ${invention?.directions[0]?.name ?? "the first direction"}'s header calmer`
        : run.phase === "failed"
          ? "Adjust the brief and try again — or resume:<id>"
          : busy
            ? "the agent is working…"
            : "Describe a brief — e.g. a dating app where pickles match on brine compatibility",
    action: run.phase === "done" ? "refine" : run.phase === "failed" ? "retry" : "explore",
    canSubmit:
      !busy && composerText.trim().length > 0 && health.state === "ready",
    inputDisabled: busy,
    onChange: setComposerText,
    onSubmit: () => {
      if (busy) return;
      if (run.phase === "done") void sendFeedback();
      else void start();
    },
    onStop: stop,
    resume: lastRun
      ? {
          label: "resume last",
          title: `Reload "${lastRun.brief.slice(0, 60)}" from storage — no generation`,
          onClick: () => void doResume(lastRun.explorationId, lastRun.brief),
        }
      : undefined,
  };

  const statusChip =
    run.phase === "idle"
      ? "First run"
      : run.phase === "failed"
        ? "Failed"
        : run.phase === "done"
          ? "Complete"
          : run.mode === "resume"
            ? "Replaying"
            : scores.length > 0
              ? "Reviewing"
              : "Generating";
  const statusTone: StatusTone =
    run.phase === "idle"
      ? "idle"
      : run.phase === "done"
        ? "done"
        : run.phase === "failed"
          ? "failed"
          : "busy";

  const selected =
    selection && invention?.directions[selection.index]
      ? {
          direction: invention.directions[selection.index]!,
          directionIndex: selection.index,
          stateLabel: selection.kind === "cell" ? selection.label : undefined,
        }
      : null;
  const selectedCell =
    selection?.kind === "cell" ? cells[cellKey(selection.index, selection.label)] : undefined;

  return (
    <div className="ph-root" data-theme={theme} style={{ colorScheme: theme }}>
      <Rail
        turns={turns}
        aih={run.phase === "exploring" ? run.aih : undefined}
        busy={busy}
        budget={budget}
        chips={chips}
        composer={composer}
        health={railHealth}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        history={history}
        onPickHistory={(entry) => {
          if (!busy) void doResume(entry.explorationId, entry.brief);
        }}
        inputRef={composerRef}
      />
      <Board
        title={run.phase === "idle" ? "Phosphene" : run.brief}
        caption={
          invention
            ? `${invention.directions.length} directions × ${invention.states.length} states · ${doneCount}/${totalCells} artboards${failedCount > 0 ? ` · ${failedCount} failed` : ""}`
            : "no artboards yet"
        }
        statusChip={statusChip}
        statusTone={statusTone}
        invention={invention}
        cells={cells}
        ranks={ranks}
        rankDimension={rankDimension}
        onSetDimension={setRankDimension}
        preferredIndex={preferred}
        selection={selection}
        onSelect={setSelection}
        gateNote={
          health.state === "unavailable"
            ? "The daemon isn't reachable yet — start the ObjectiveAI stack and this clears on its own."
            : health.state === "connecting"
              ? "connecting to the daemon…"
              : undefined
        }
        zoomed={zoomed}
        onOpen={(directionIndex, label) => {
          const cell = cells[cellKey(directionIndex, label)];
          const direction = invention?.directions[directionIndex];
          if (cell?.phase === "done" && direction) {
            setZoomed({ direction, label, html: cell.html });
          }
        }}
        onCloseZoom={() => setZoomed(null)}
      />
      <Inspector
        selection={selected}
        scores={selected ? scores.filter((s) => s.directionIndex === selected.directionIndex) : []}
        failures={
          selected
            ? (exploration?.judgeFailures ?? []).filter(
                (f) => f.directionIndex === undefined || f.directionIndex === selected.directionIndex,
              )
            : []
        }
        rank={selected ? ranks?.find((r) => r.directionIndex === selected.directionIndex) : undefined}
        scoredCount={scoredCount}
        rankDimension={rankDimension}
        statesTotal={invention?.states.length ?? 0}
        preferred={selected !== null && preferred === selected.directionIndex}
        complete={run.phase === "done"}
        cellHtml={selectedCell?.phase === "done" ? selectedCell.html : undefined}
        onPrefer={() => selected && togglePrefer(selected.directionIndex)}
        onIterate={() => {
          if (!selected || run.phase !== "done") return;
          const scope = `${selected.direction.name}${selected.stateLabel ? ` · ${selected.stateLabel} state` : ""}: `;
          setComposerText((prev) => (prev.startsWith(scope) ? prev : scope + prev));
          composerRef.current?.focus();
        }}
        onClose={() => setSelection(null)}
      />
    </div>
  );
}
