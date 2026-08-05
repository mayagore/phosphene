/**
 * Local exploration history — the display side's memory of what it ran.
 *
 * localStorage under the `phosphene.*` namespace (the tauri://localhost
 * origin is shared by every tab — spikes/01 §E). Capped, oldest shed first,
 * every failure swallowed: history is a convenience, never a dependency.
 * The database remains the truth; these are just keys into it, which is why
 * resume-by-id works on any entry.
 */

export interface HistoryEntry {
  explorationId: string;
  brief: string;
  when: number;
}

const KEY = "phosphene.history";
/** The single-pointer key this list replaced; read once as a migration seed. */
const LEGACY_KEY = "phosphene.lastExploration";
const CAP = 24;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (e): e is HistoryEntry =>
              typeof e === "object" &&
              e !== null &&
              typeof (e as HistoryEntry).explorationId === "string" &&
              typeof (e as HistoryEntry).brief === "string" &&
              typeof (e as HistoryEntry).when === "number",
          )
          .sort((a, b) => b.when - a.when)
          .slice(0, CAP);
      }
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as { explorationId?: string; brief?: string };
      if (parsed.explorationId && parsed.brief) {
        return [{ explorationId: parsed.explorationId, brief: parsed.brief, when: 0 }];
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function recordHistory(entry: HistoryEntry): HistoryEntry[] {
  const next = [
    entry,
    ...loadHistory().filter((e) => e.explorationId !== entry.explorationId),
  ].slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable — the run itself is unaffected.
  }
  return next;
}
