/**
 * Re-attach the font kit to lean documents at display time.
 *
 * Boards travel with their `@font-face` payloads ELIDED (`base64,ELIDED`
 * stubs) — the lean-transit rule: full bytes live only in the plugin's
 * database and never ride an agent's context. The viewer owns the payloads
 * (fontkit.generated.ts, generated from the MCP half's kit) and splices them
 * back in where the pixels are made: the board iframes and the PNG
 * rasterizer.
 *
 * Mirrors mcp/src/fonts.rs deliberately: the elided block shapes matched
 * here are exactly what `inject` + `elide_font_payloads` emit, and the
 * injection point (first `<style>`, else `</head>`, else prepend) is the
 * same, so a document round-trips to the same place the server would have
 * put it.
 */
import { KIT_FACES } from "./fontkit.generated";

/** Kit `@font-face` blocks for these families — the server's exact format. */
export function kitCss(families: string[]): string {
  const wanted = new Set(families.map((f) => f.trim().toLowerCase()));
  return KIT_FACES.filter((face) => wanted.has(face.family.toLowerCase()))
    .map(
      (face) =>
        `@font-face{font-family:'${face.family}';font-style:normal;` +
        `font-weight:${face.weight};font-display:swap;` +
        `src:url(data:font/woff2;base64,${face.b64}) format('woff2')}`,
    )
    .join("\n");
}

/** An elided kit block: single-line, no nested braces, stub payload. */
const ELIDED_BLOCK = /@font-face\{font-family:'([^']+)';[^{}]*base64,ELIDED[^{}]*\}\n?/g;

/** Families a lean document declares but carries no payload for. */
export function elidedFamilies(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(ELIDED_BLOCK)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * Splice the kit into a lean document: drop the stub blocks (a broken
 * `src` makes the whole face unusable), then inject real ones where the
 * server would have. Documents with no stubs pass through untouched, so
 * this is idempotent and free for pre-E1 boards.
 */
export function attachKit(html: string): string {
  const families = elidedFamilies(html);
  if (families.length === 0) return html;
  const css = kitCss(families);
  const stripped = html.replace(ELIDED_BLOCK, "");
  if (!css) return stripped;

  const lower = stripped.toLowerCase();
  const styleAt = lower.indexOf("<style");
  if (styleAt !== -1) {
    const end = stripped.indexOf(">", styleAt);
    if (end !== -1) {
      const at = end + 1;
      return `${stripped.slice(0, at)}\n${css}\n${stripped.slice(at)}`;
    }
  }
  const headAt = lower.indexOf("</head>");
  if (headAt !== -1) {
    return `${stripped.slice(0, headAt)}<style>\n${css}\n</style>${stripped.slice(headAt)}`;
  }
  return `<style>\n${css}\n</style>${stripped}`;
}
