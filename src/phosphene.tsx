/**
 * Phosphene's boot tab — declared in `objectiveai.json` as
 * `viewer.tabs[0]`, opened by the viewer at boot.
 *
 * Two contracts this file lives under, both from docs/platform/01-viewer.md:
 *
 * 1. It receives ONE prop, `arguments`, and nothing else. A tab declared in
 *    the manifest is opened with `arguments: None` — so at boot this is
 *    always undefined. Props arrive only for tabs opened programmatically
 *    via `tabs_open`. (`arguments` is a reserved binding in strict mode;
 *    destructure it under another name.)
 *
 * 2. Everything else comes from the harness the bootstrap wraps us in —
 *    the daemon transport and the window's zoom. There is no theme, no
 *    router, and no host state beyond that.
 *
 * The tab renders inside a document that already carries the viewer's own
 * `app.css`: Tailwind preflight, a `color-scheme: dark` html, a 13px
 * flex-column body, and the viewer's `@theme` tokens. We consume those
 * tokens (they are declared, stable API-ish) but never its utility classes
 * — those exist only because the viewer happens to use them today, and a
 * refactor upstream would delete them silently. See spikes/01-calibration §C.
 */
import { useEffect, useState } from "react";
import { Client, functionsListExecute } from "@objectiveai/sdk";
import { transport } from "./transport";

/** Mirrors the host's `TabComponentProps`. */
interface TabProps {
  arguments?: unknown;
}

type Health =
  | { state: "connecting" }
  | { state: "ready"; roundTripMs: number }
  | { state: "unavailable"; reason: string };

/**
 * Prove the daemon is actually REACHABLE before any feature depends on it. A
 * failure here is the difference between "the plugin is broken" and "the
 * daemon is down", and the two look identical from a blank tab.
 *
 * This has to make a real round trip. `Client.viewer(transport)` is a
 * synchronous constructor — it succeeds whether or not anything is listening,
 * so checking it alone measures nothing. `functions list` is the cheapest
 * read-only command that proves the whole path: SDK → Tauri IPC →
 * `daemon_execute` → daemon → response stream. An empty result is a healthy
 * answer; only an error item or a throw means unreachable.
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
        const reason = JSON.stringify(chunk.message).slice(0, 160);
        console.error("phosphene: daemon returned an error", chunk.message);
        return { state: "unavailable", reason };
      }
      break; // one item is enough to prove the round trip
    }
    const roundTripMs = Math.round(performance.now() - started);
    // Boot telemetry. `console.*` is the sanctioned path to the viewer's log
    // inbox (see the note in the catch below), and "did phosphene come up, and
    // could it reach the daemon" is exactly what you want in that inbox when
    // someone reports a blank tab.
    console.info(`phosphene: ready · daemon round trip ${roundTripMs}ms`);
    return { state: "ready", roundTripMs };
  } catch (error) {
    // console.* is the sanctioned path to the viewer's log inbox — the host
    // injects a capture script into every webview, so this lands in
    // viewer-logs under this tab's TITLE with no cooperation from us.
    console.error("phosphene: daemon transport unavailable", error);
    return { state: "unavailable", reason: String(error).slice(0, 200) };
  }
}

export default function Phosphene({ arguments: _args }: TabProps) {
  const [health, setHealth] = useState<Health>({ state: "connecting" });

  useEffect(() => {
    let disposed = false;
    void checkDaemon().then((next) => {
      if (!disposed) setHealth(next);
    });
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <div className="phosphene">
      <header className="phosphene-header">
        <h1 className="phosphene-title">phosphene</h1>
        <p className="phosphene-subtitle">
          Design iteration and judgment. Describe a brief, get contrasting
          directions rendered across shared states, and let a swarm score them.
        </p>
      </header>

      <section className="phosphene-status" aria-live="polite">
        <span
          className={`phosphene-dot phosphene-dot--${health.state}`}
          aria-hidden="true"
        />
        {health.state === "connecting" && <span>connecting to the daemon…</span>}
        {health.state === "ready" && (
          <span>daemon reachable · {health.roundTripMs}ms</span>
        )}
        {health.state === "unavailable" && (
          <span>daemon unavailable — {health.reason}</span>
        )}
      </section>

      <p className="phosphene-note">
        Scaffolded and verified. The brief composer, the board, and the review
        come next.
      </p>
    </div>
  );
}
