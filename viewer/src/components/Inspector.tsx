/**
 * The right panel — judgment made visible (docs/scoring.md: "judgment as a
 * surface, not a number"; review 01, P1). For the selected direction it
 * shows, per dimension: every judge's point on a track, the spread band, a
 * median needle, the numeric values, and every written why — plus the
 * measured facts that ride on each verdict and were never rendered before.
 * No combined number exists anywhere on this surface.
 */
import { useEffect, useState } from "react";
import type { Direction } from "../lib/directions";
import type { JudgeFailure, ScoreEvent } from "../lib/orchestrator";
import {
  CONTRAST_AA,
  DIMENSIONS,
  DIMENSION_LABELS,
  normalizeFacts,
  scoreTone,
  type Dimension,
  type DirectionRank,
} from "../lib/scores";

export interface InspectorSelection {
  direction: Direction;
  directionIndex: number;
  stateLabel?: string;
}

interface InspectorProps {
  selection: InspectorSelection | null;
  /** This direction's score events, arrival order. */
  scores: ScoreEvent[];
  failures: JudgeFailure[];
  rank?: DirectionRank;
  scoredCount: number;
  rankDimension: Dimension;
  statesTotal: number;
  preferred: boolean;
  complete: boolean;
  cellHtml?: string;
  onPrefer: () => void;
  onIterate: () => void;
  onClose: () => void;
}

const shortJudge = (judge: string) => judge.split("/").pop() ?? judge;

function DimensionBlock({
  dimension,
  rank,
  scores,
}: {
  dimension: Dimension;
  rank?: DirectionRank;
  scores: ScoreEvent[];
}) {
  const stat = rank?.byDimension[dimension];
  if (!stat) return null;
  const [lo, hi] = stat.range;
  const tone = scoreTone(stat.median);
  return (
    <div className="ph-dim">
      <div className="ph-dim-head">
        <span className="ph-dim-label">{DIMENSION_LABELS[dimension]}</span>
        <span className={`ph-dim-median ph-tone-text--${tone}`}>{stat.median.toFixed(2)}</span>
      </div>
      <div className="ph-dim-track" aria-hidden="true">
        <span
          className="ph-dim-band"
          style={{ left: `${lo * 100}%`, width: `${Math.max((hi - lo) * 100, 0.5)}%` }}
        />
        {stat.points.map((p, i) => (
          <span
            key={`${p.judge}-${i}`}
            className={`ph-dim-dot ph-tone-bg--${scoreTone(p.value)}`}
            style={{ left: `${p.value * 100}%` }}
            title={`${shortJudge(p.judge)} · ${p.value.toFixed(2)}`}
          />
        ))}
        <span className="ph-dim-needle" style={{ left: `${stat.median * 100}%` }} />
      </div>
      {lo !== hi && (
        <span className="ph-dim-range">
          spread {lo.toFixed(2)}–{hi.toFixed(2)} across {stat.points.length} judge
          {stat.points.length === 1 ? "" : "s"}
        </span>
      )}
      {stat.points.map((p, i) => {
        // Latest note wins if a judge scored this direction more than once.
        const note = [...scores]
          .reverse()
          .find((s) => s.judge === p.judge && s.notes[dimension])?.notes[dimension];
        return (
          <details className="ph-why" key={`why-${p.judge}-${i}`}>
            <summary>
              <span className="ph-why-caret" aria-hidden="true">
                ▸
              </span>
              why this score · {shortJudge(p.judge)} · {p.value.toFixed(2)}
            </summary>
            {note ? <p>{note}</p> : <p className="ph-why-none">no written reason arrived.</p>}
          </details>
        );
      })}
    </div>
  );
}

function FactRow({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={`ph-fact${bad ? " ph-fact--bad" : ""}`}>
      <span className="ph-fact-label">{label}</span>
      <span className="ph-fact-value">{value}</span>
    </div>
  );
}

function FactsBlock({ score, statesTotal }: { score: ScoreEvent; statesTotal: number }) {
  const facts = normalizeFacts(score.facts);
  if (!facts) return null;
  const contrastRows = [
    ["text on bg", facts.contrast.text_on_bg],
    ["text on surface", facts.contrast.text_on_surface],
    ["muted on bg", facts.contrast.muted_on_bg],
    ["accent on bg", facts.contrast.accent_on_bg],
  ] as const;
  const check = (v: boolean | null, yes: string, no: string) =>
    v === null ? "—" : v ? yes : no;
  return (
    <div className="ph-facts">
      <span className="ph-facts-judge">{shortJudge(score.judge)}</span>
      {contrastRows.map(([label, v]) => (
        <FactRow
          key={label}
          label={`contrast · ${label}`}
          value={v === null ? "—" : `${v.toFixed(1)}:1${v < CONTRAST_AA ? " · below AA" : ""}`}
          bad={v !== null && v < CONTRAST_AA}
        />
      ))}
      <FactRow
        label="palette"
        value={`${facts.palette.declared_used}/5 used · ${facts.palette.foreign_colours} foreign · ${Math.round(facts.palette.adherence * 100)}% adherence`}
        bad={facts.palette.foreign_colours > 0}
      />
      <FactRow label="declared fonts" value={check(facts.fonts_declared_used, "used", "not used")} bad={facts.fonts_declared_used === false} />
      <FactRow label="javascript" value={check(facts.javascript_free, "none", "PRESENT")} bad={facts.javascript_free === false} />
      <FactRow label="external resources" value={check(facts.external_free, "none", "PRESENT")} bad={facts.external_free === false} />
      {score.statesSeen.length > 0 && score.statesSeen.length < statesTotal && (
        <span className="ph-facts-note">
          saw {score.statesSeen.length} of {statesTotal} states — coherence judged from a
          partial board
        </span>
      )}
    </div>
  );
}

export default function Inspector({
  selection,
  scores,
  failures,
  rank,
  scoredCount,
  rankDimension,
  statesTotal,
  preferred,
  complete,
  cellHtml,
  onPrefer,
  onIterate,
  onClose,
}: InspectorProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
  }, [cellHtml]);

  if (!selection) {
    return (
      <aside className="ph-inspector">
        <div className="ph-eyebrow">Inspector</div>
        <div className="ph-insp-empty">
          <strong>No selection</strong>
          <span>
            Generate a board, then select a direction — every judge's scores, reasoning, and
            the measured facts appear here.
          </span>
        </div>
      </aside>
    );
  }

  const { direction, stateLabel } = selection;
  const judged = rank?.rank != null;
  const factsScores = scores.filter((s) => normalizeFacts(s.facts));

  const copyHtml = () => {
    if (!cellHtml) return;
    navigator.clipboard
      .writeText(cellHtml)
      .then(() => setCopied(true))
      .catch((error) => console.error("phosphene: clipboard write failed", error));
  };

  return (
    <aside className="ph-inspector">
      <div className="ph-insp-head">
        <span className="ph-eyebrow">Inspector</span>
        <button type="button" className="ph-insp-close" onClick={onClose} aria-label="Clear selection">
          ×
        </button>
      </div>

      <div className="ph-insp-title">
        <h2>{direction.name}</h2>
        <span>
          {stateLabel ? `${stateLabel} state` : "all states"}
          {judged
            ? ` · #${rank!.rank} of ${scoredCount} · by ${DIMENSION_LABELS[rankDimension]}`
            : " · not yet judged"}
        </span>
        {preferred && <span className="ph-preferred-chip">★ preferred — anchors the next round</span>}
      </div>

      {judged && (
        <section className="ph-insp-section">
          <div className="ph-eyebrow">Judgment · per dimension</div>
          {DIMENSIONS.map((d) => (
            <DimensionBlock key={d} dimension={d} rank={rank} scores={scores} />
          ))}
        </section>
      )}

      {factsScores.length > 0 && (
        <section className="ph-insp-section">
          <div className="ph-eyebrow">Technical · measured</div>
          {factsScores.map((s, i) => (
            <FactsBlock key={`${s.judge}-${i}`} score={s} statesTotal={statesTotal} />
          ))}
        </section>
      )}

      {failures.length > 0 && (
        <section className="ph-insp-section">
          <div className="ph-eyebrow">Judges</div>
          {failures.map((f, i) => (
            <p className="ph-judge-failure" key={i}>
              {f.model ?? "a judge"} failed — {f.reason}
            </p>
          ))}
        </section>
      )}

      <section className="ph-insp-section">
        <div className="ph-eyebrow">Direction</div>
        <div className="ph-swatches" aria-label="palette">
          {direction.palette.map((hex, i) => (
            <span
              key={`${hex}-${i}`}
              className="ph-swatch"
              style={{ backgroundColor: hex }}
              title={["background", "surface", "accent", "text", "muted"][i] + " " + hex}
            />
          ))}
        </div>
        {direction.mood && <span className="ph-card-mood">{direction.mood}</span>}
        <p className="ph-card-desc">{direction.description}</p>
        {(direction.voice || direction.texture || direction.motifs || direction.audience) && (
          <dl className="ph-moodboard">
            {direction.voice && (
              <div>
                <dt>voice</dt>
                <dd>{direction.voice}</dd>
              </div>
            )}
            {direction.texture && (
              <div>
                <dt>texture</dt>
                <dd>{direction.texture}</dd>
              </div>
            )}
            {direction.motifs && (
              <div>
                <dt>motifs</dt>
                <dd>{direction.motifs}</dd>
              </div>
            )}
            {direction.audience && (
              <div>
                <dt>audience</dt>
                <dd>{direction.audience}</dd>
              </div>
            )}
          </dl>
        )}
        <p className="ph-card-type">{direction.typography}</p>
      </section>

      <div className="ph-insp-actions">
        <button
          type="button"
          className={`ph-button ph-button--ghost${preferred ? " ph-button--active" : ""}`}
          onClick={onPrefer}
          title="A preferred direction anchors the next refine round"
        >
          {preferred ? "★ preferred" : "☆ prefer"}
        </button>
        <button
          type="button"
          className="ph-button ph-button--ghost"
          onClick={onIterate}
          disabled={!complete}
          title="Start feedback scoped to this selection"
        >
          iterate
        </button>
        {cellHtml && (
          <button type="button" className="ph-button ph-button--ghost" onClick={copyHtml}>
            {copied ? "copied ✓" : "copy html"}
          </button>
        )}
      </div>
    </aside>
  );
}
