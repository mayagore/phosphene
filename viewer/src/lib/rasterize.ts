/**
 * In-page rasterization of a generated board — the Spike D path
 * (docs/spikes/01-calibration.md §D): SVG `foreignObject` → `Image` →
 * `canvas.drawImage` → PNG, verified untainted in the tab webview.
 *
 * It works BECAUSE the artboard contract forbids everything the technique
 * historically chokes on: no external resources, no JavaScript, one inline
 * stylesheet, declared font stacks. The generator's constraint is the
 * rasterizer's guarantee.
 */
import { ARTBOARD_HEIGHT, ARTBOARD_WIDTH } from "./board";

/** Strip the XML prolog (and any doctype): legal at document start, ILLEGAL
 * inside a foreignObject — the svg would silently fail to image. */
function embeddable(xhtml: string): string {
  return xhtml
    .replace(/^\s*<\?xml[^?]*\?>/i, "")
    .replace(/^\s*<!DOCTYPE[^>]*>/i, "")
    .trim();
}

export async function rasterizeBoard(
  html: string,
  scale = 2,
  width = ARTBOARD_WIDTH,
  height = ARTBOARD_HEIGHT,
): Promise<Blob> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject width="${width}" height="${height}">${embeddable(html)}</foreignObject>` +
    `</svg>`;
  // data: URL, deliberately NOT a blob: URL — Chromium-family engines mark a
  // canvas tainted after drawing a blob-loaded foreignObject SVG, while the
  // same markup through a data URL exports clean (measured; matches Spike D's
  // data-URL result).
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("the board's svg wrapper failed to image"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, width * scale, height * scale);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("canvas.toBlob returned null (tainted?)");
  return blob;
}

/** Best-effort save. An `<a download>` may be inert in some webviews — the
 * caller pairs this with copy-png and every failure is loud. */
export function savePng(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the click a tick before the URL dies.
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export async function copyPng(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
