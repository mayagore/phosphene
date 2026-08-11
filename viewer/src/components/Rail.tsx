/**
 * The rail — the chat concept's left panel: an agent transcript where
 * everything is a Turn, with ONE composer at the bottom whose action follows
 * the run's phase. Purely presentational; every fact it shows arrives as a
 * prop derived from the tool-event stream.
 *
 * Idioms lifted from the legacy LeftRail (design-legacy/): the ✦ turn mark,
 * ALL-CAPS eyebrows, check-dot plan steps, chip pills. All styling is our own
 * `.ph-*` classes on `--ph-*` tokens — never the viewer's utility classes.
 */
import { useEffect, useRef, type Ref } from "react";
import type { ToolEvent } from "../lib/agent";
import type { Turn } from "../lib/turns";
import type { HistoryEntry } from "../lib/history";

export interface RailHealth {
  state: "connecting" | "ready" | "unavailable";
  text: string;
}

export interface RailBudget {
  tools: number;
  maxTools: number;
  kb: number;
  judges: number;
  elapsedSec: number;
}

export interface RailComposer {
  value: string;
  placeholder: string;
  action: string;
  canSubmit: boolean;
  inputDisabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  resume?: { label: string; title: string; onClick: () => void };
}

interface RailProps {
  turns: Turn[];
  aih?: string;
  busy: boolean;
  budget?: RailBudget;
  chips: string[];
  composer: RailComposer;
  health: RailHealth;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  history: HistoryEntry[];
  onPickHistory: (entry: HistoryEntry) => void;
  /** Present when a session is loaded: clears the tab back to First run.
   * Client-side only — every exploration stays in the database, one resume
   * away. */
  onNewSession?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}

function relativeWhen(when: number): string {
  if (when <= 0) return "earlier";
  const mins = Math.max(1, Math.round((Date.now() - when) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function CheckDot({ done }: { done: boolean }) {
  return (
    <span className={`ph-checkdot${done ? " ph-checkdot--done" : ""}`} aria-hidden="true">
      {done ? "✓" : ""}
    </span>
  );
}

function ActivityRows({ tools }: { tools: ToolEvent[] }) {
  return (
    <>
      {tools.map((tool, i) => (
        <div className="ph-activity-row" key={`${tool.name}-${i}`}>
          <span
            className={`phosphene-dot phosphene-dot--${tool.result ? "ready" : "connecting"}`}
            aria-hidden="true"
          />
          <code className="ph-activity-name">{tool.name || "…"}</code>
          <span className="ph-activity-state">
            {tool.result ? `${(tool.result.length / 1024).toFixed(1)} KB` : "calling…"}
          </span>
        </div>
      ))}
    </>
  );
}

/** Live: the last-8 feed of what the agent is doing right now. Settled: the
 * FULL call log, kept — the viewer exists so a human can see the agent's
 * work, and the work IS these calls. */
function Activity({ tools, aih, live }: { tools: ToolEvent[]; aih?: string; live: boolean }) {
  if (tools.length === 0) return null;
  if (live) {
    return (
      <div className="ph-activity" aria-live="polite">
        <ActivityRows tools={tools.slice(-8)} />
        {aih && <code className="ph-activity-aih">{aih.split("/").pop()}</code>}
      </div>
    );
  }
  const kb = tools.reduce((n, t) => n + (t.result?.length ?? 0), 0) / 1024;
  return (
    <details className="ph-activity ph-activity--log">
      <summary>
        {tools.length} tool call{tools.length === 1 ? "" : "s"} · {kb.toFixed(0)} KB — the run's
        full log
      </summary>
      <ActivityRows tools={tools} />
    </details>
  );
}

function renderTurn(turn: Turn, aih: string | undefined, busy: boolean) {
  switch (turn.kind) {
    case "user":
      return (
        <div className="ph-turn-user" key={turn.id}>
          {turn.text}
        </div>
      );
    case "message":
      return (
        <div className="ph-turn-message" key={turn.id}>
          <span className="ph-turn-mark" aria-hidden="true">
            ✦
          </span>
          <p>{turn.text}</p>
        </div>
      );
    case "toolkit":
      return (
        <div className="ph-turn-card" key={turn.id}>
          <div className="ph-eyebrow">Your agent's tools</div>
          <div className="ph-toolkit">
            {turn.tools.map((tool) => (
              <div className="ph-toolkit-tool" key={tool.name}>
                <code className="ph-toolkit-name">{tool.name}</code>
                <span className="ph-toolkit-what">{tool.what}</span>
              </div>
            ))}
          </div>
        </div>
      );
    case "plan":
      return (
        <div className="ph-turn-card" key={turn.id}>
          <div className="ph-eyebrow">Plan</div>
          <ul className="ph-plan-steps">
            {turn.steps.map((step) => (
              <li className="ph-plan-step" key={step.label}>
                <CheckDot done={step.done} />
                <span className="ph-plan-label">{step.label}</span>
                {step.detail && <span className="ph-plan-detail">{step.detail}</span>}
              </li>
            ))}
          </ul>
          <Activity tools={turn.activity} aih={aih} live={busy} />
        </div>
      );
    case "ranked":
      return (
        <div className="ph-turn-card" key={turn.id}>
          <div className="ph-eyebrow">{turn.label}</div>
          <ul className="ph-ranked-rows">
            {turn.items.map((item) => (
              <li
                className={`ph-ranked-row${item.leading ? " ph-ranked-row--leading" : ""}`}
                key={item.directionIndex}
              >
                <span className="ph-ranked-star" aria-hidden="true">
                  {item.leading ? "★" : ""}
                </span>
                <span className="ph-ranked-name">{item.name}</span>
                <span className="ph-ranked-score">
                  {item.median === null
                    ? "—"
                    : item.range && item.range[0] !== item.range[1]
                      ? `${item.median.toFixed(2)} · ${item.range[0].toFixed(2)}–${item.range[1].toFixed(2)}`
                      : item.median.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "judges":
      return (
        <div className="ph-turn-card ph-turn-card--warn" key={turn.id}>
          <div className="ph-eyebrow">Judges</div>
          {turn.failures.map((f, i) => (
            <p className="ph-judge-failure" key={i}>
              {f.model ?? "a judge"} failed
              {f.name
                ? ` on ${f.name}`
                : f.directionIndex !== undefined
                  ? ` on direction ${f.directionIndex + 1}`
                  : ""}{" "}
              — {f.reason}
            </p>
          ))}
        </div>
      );
    case "error":
      return (
        <div className="ph-turn-error" role="alert" key={turn.id}>
          <strong>run failed</strong>
          <span>{turn.text}</span>
        </div>
      );
  }
}

export default function Rail({
  turns,
  aih,
  busy,
  budget,
  chips,
  composer,
  health,
  theme,
  onToggleTheme,
  history,
  onPickHistory,
  onNewSession,
  inputRef,
}: RailProps) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDetailsElement | null>(null);

  // The history popover only ever closed by PICKING something from it, so
  // clicking anywhere else left it open — over the board, and (before the
  // z-index fix) over the full-screen zoom modal.
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      const details = historyRef.current;
      if (!details?.hasAttribute("open")) return;
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") details.removeAttribute("open");
        return;
      }
      if (!details.contains(e.target as Node)) details.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  // Follow the conversation only when already reading the tail — never yank
  // the scroll away from someone reading an earlier turn.
  const activityCount = turns.reduce(
    (n, t) => n + (t.kind === "plan" ? t.activity.length + t.steps.filter((s) => s.done).length : 0),
    0,
  );
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns.length, activityCount]);

  return (
    <div className="ph-rail">
      <header className="ph-rail-head">
        <span className="ph-rail-mark" aria-hidden="true">
          ✳
        </span>
        <div className="ph-rail-title">
          <h1>Phosphene</h1>
          <span>Agent · design transcript</span>
        </div>
        <div className="ph-rail-tools">
          {onNewSession && (
            <button
              type="button"
              className="ph-rail-new"
              onClick={onNewSession}
              title="Clear the tab back to First run — every exploration stays stored, one resume away"
            >
              new
            </button>
          )}
          {history.length > 0 && (
            <details className="ph-history" ref={historyRef}>
              <summary title="Past explorations — click one to resume it">↺</summary>
              <ul className="ph-history-list">
                {history.map((entry) => (
                  <li key={entry.explorationId}>
                    <button
                      type="button"
                      className="ph-history-entry"
                      disabled={busy}
                      onClick={() => {
                        historyRef.current?.removeAttribute("open");
                        onPickHistory(entry);
                      }}
                    >
                      <span className="ph-history-brief">{entry.brief}</span>
                      <span className="ph-history-when">{relativeWhen(entry.when)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button
            type="button"
            className="ph-theme-toggle"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      {budget && (
        <div className="ph-budget-chip">
          <span
            className={`phosphene-dot phosphene-dot--${busy ? "connecting" : "ready"}`}
            aria-hidden="true"
          />
          <span>
            {budget.tools}/{budget.maxTools} calls · {budget.kb.toFixed(0)} KB
            {budget.judges > 0 && ` · ${budget.judges} judge${budget.judges === 1 ? "" : "s"}`}
            {" · "}
            {formatElapsed(budget.elapsedSec)}
          </span>
        </div>
      )}

      <div className="ph-transcript" ref={transcriptRef}>
        {turns.map((turn) => renderTurn(turn, busy ? aih : undefined, busy))}
      </div>

      {chips.length > 0 && (
        <div className="ph-config-chips">
          {chips.map((chip) => (
            <span className="ph-chip" key={chip}>
              {chip}
            </span>
          ))}
        </div>
      )}

      <div className="ph-composer">
        <textarea
          className="ph-input"
          ref={inputRef}
          rows={3}
          value={composer.value}
          disabled={composer.inputDisabled}
          placeholder={composer.placeholder}
          onChange={(e) => composer.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) composer.onSubmit();
          }}
        />
        <div className="ph-composer-row">
          <button
            type="button"
            className="ph-button"
            onClick={composer.onSubmit}
            disabled={!composer.canSubmit}
          >
            {composer.action}
          </button>
          {busy && composer.onStop && (
            <button type="button" className="ph-button ph-button--ghost" onClick={composer.onStop}>
              stop
            </button>
          )}
          {!busy && composer.resume && (
            <button
              type="button"
              className="ph-chip ph-chip--action"
              onClick={composer.resume.onClick}
              title={composer.resume.title}
            >
              {composer.resume.label}
            </button>
          )}
          <span className="ph-hint">⌘↵ send</span>
        </div>
      </div>

      <footer className="ph-rail-health" aria-live="polite">
        <span className={`phosphene-dot phosphene-dot--${health.state}`} aria-hidden="true" />
        <span>{health.text}</span>
      </footer>
    </div>
  );
}
