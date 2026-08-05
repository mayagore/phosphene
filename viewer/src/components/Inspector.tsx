/**
 * The right panel — judgment made visible. Phase A ships the empty state
 * only; the full surface (per-dimension judge dots + spread + every written
 * why + the measured facts) lands with the judgment slice.
 */
export default function Inspector() {
  return (
    <aside className="ph-inspector">
      <div className="ph-eyebrow">Inspector</div>
      <div className="ph-insp-empty">
        <strong>No selection</strong>
        <span>
          Generate a board, then select a direction — every judge's scores, reasoning, and the
          measured facts appear here.
        </span>
      </div>
    </aside>
  );
}
