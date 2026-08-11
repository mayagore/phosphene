/**
 * The pan/zoom canvas — ported from the legacy Canvas (design-legacy/),
 * trimmed to what this viewer needs: pan, anchored wheel-zoom, zoom-to-fit,
 * the zoom pill, positioned headers. The legacy shape-drag, region-draw and
 * annotation subsystems have no consumers here and were dropped.
 *
 * Interaction contract:
 *   drag anywhere        → pan (buttons and links are exempt and keep their clicks)
 *   unmoved release      → select the shape under the pointer, or clear on background
 *   double-click shape   → open it; double-click background → zoom to fit
 *   wheel / pinch        → zoom anchored at the cursor (non-passive listener:
 *                          React's synthetic onWheel is passive and would scroll)
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import type { BoardLayout, BoardShape } from "../lib/layoutGrid";

export interface CanvasHandle {
  zoomToFit: () => void;
}

interface PositionedNode {
  key: string;
  x: number;
  y: number;
  /** CSS transform applied to the node (e.g. centering translates). */
  translate?: string;
  node: ReactNode;
  /** Headers with buttons need pointer events; default none. */
  interactive?: boolean;
}

interface CanvasProps {
  layout: BoardLayout;
  renderShape: (shape: BoardShape) => ReactNode;
  shapeClassName: (shape: BoardShape) => string;
  positioned: PositionedNode[];
  onShapeClick: (shape: BoardShape) => void;
  onShapeDoubleClick: (shape: BoardShape) => void;
  onBackgroundClick: () => void;
  handleRef?: Ref<CanvasHandle>;
  /** Start at a fixed framing instead of auto-fit — harness/tests only. */
  initialViewport?: Viewport;
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const ZOOM_FRICTION = 0.45;

export default function Canvas({
  layout,
  renderShape,
  shapeClassName,
  positioned,
  onShapeClick,
  onShapeDoubleClick,
  onBackgroundClick,
  handleRef,
  initialViewport,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>(
    initialViewport ?? { x: 0, y: 0, zoom: 0.4 },
  );
  const [panning, setPanning] = useState(false);
  const targetRef = useRef<Viewport>(initialViewport ?? { x: 0, y: 0, zoom: 0.4 });
  const rafRef = useRef(0);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const hadShapesRef = useRef(initialViewport !== undefined);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const animateToTarget = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const step = () => {
      setViewport((v) => {
        const t = targetRef.current;
        const dx = t.x - v.x;
        const dy = t.y - v.y;
        const dz = t.zoom - v.zoom;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.001) return t;
        rafRef.current = requestAnimationFrame(step);
        return {
          x: v.x + dx * ZOOM_FRICTION,
          y: v.y + dy * ZOOM_FRICTION,
          zoom: v.zoom + dz * ZOOM_FRICTION,
        };
      });
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const current = targetRef.current;
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      if (e.deltaMode === 2) delta *= 100;
      const factor = Math.max(0.5, Math.min(2, 1 - delta * 0.002));
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor));
      const ratio = newZoom / current.zoom;
      targetRef.current = {
        x: mouseX - (mouseX - current.x) * ratio,
        y: mouseY - (mouseY - current.y) * ratio,
        zoom: newZoom,
      };
      animateToTarget();
    },
    [animateToTarget],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const shapeFromTarget = useCallback(
    (target: EventTarget | null): BoardShape | undefined => {
      const id = (target as HTMLElement | null)
        ?.closest("[data-shape-id]")
        ?.getAttribute("data-shape-id");
      return id ? layout.shapes.find((s) => s.id === id) : undefined;
    },
    [layout.shapes],
  );

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    // Buttons keep their own clicks — pan starts anywhere else.
    if ((e.target as HTMLElement).closest("button, a")) return;
    cancelAnimationFrame(rafRef.current);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: targetRef.current.x,
      originY: targetRef.current.y,
      moved: false,
    };
    setPanning(true);
    containerRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    const next = { ...targetRef.current, x: drag.originX + dx, y: drag.originY + dy };
    targetRef.current = next;
    setViewport(next);
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setPanning(false);
      if (!drag || drag.moved) return;
      const shape = shapeFromTarget(e.target);
      if (shape) onShapeClick(shape);
      else onBackgroundClick();
    },
    [shapeFromTarget, onShapeClick, onBackgroundClick],
  );

  const zoomToFit = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { minX, minY, maxX, maxY } = layout.bounds;
    const contentW = Math.max(maxX - minX, 1);
    const contentH = Math.max(maxY - minY, 1);
    const pad = 48;
    const zoom = Math.max(
      MIN_ZOOM,
      Math.min((rect.width - pad * 2) / contentW, (rect.height - pad * 2) / contentH, 1),
    );
    targetRef.current = {
      x: (rect.width - contentW * zoom) / 2 - minX * zoom,
      y: (rect.height - contentH * zoom) / 2 - minY * zoom,
      zoom,
    };
    animateToTarget();
  }, [layout.bounds, animateToTarget]);

  useImperativeHandle(handleRef, () => ({ zoomToFit }), [zoomToFit]);

  // First board in → frame it. (Rank reorders later only move gridded x/y.)
  useEffect(() => {
    if (layout.shapes.length > 0 && !hadShapesRef.current) zoomToFit();
    hadShapesRef.current = layout.shapes.length > 0;
  }, [layout.shapes.length, zoomToFit]);

  const zoomBy = useCallback(
    (factor: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const cx = rect ? rect.width / 2 : 0;
      const cy = rect ? rect.height / 2 : 0;
      const cur = targetRef.current;
      const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cur.zoom * factor));
      const ratio = nz / cur.zoom;
      targetRef.current = { x: cx - (cx - cur.x) * ratio, y: cy - (cy - cur.y) * ratio, zoom: nz };
      animateToTarget();
    },
    [animateToTarget],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("button, a")) return;
      const shape = shapeFromTarget(e.target);
      if (shape) onShapeDoubleClick(shape);
      else zoomToFit();
    },
    [shapeFromTarget, onShapeDoubleClick, zoomToFit],
  );

  return (
    <div
      ref={containerRef}
      className={`ph-canvas${panning ? " ph-canvas--panning" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="ph-canvas-stage"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        {/* Shapes FIRST, chrome after. The stage's transform makes it a
            stacking context, so nothing inside can be raised by z-index alone
            — paint order is DOM order, and the labels have to come last or a
            board that grows into them wins. */}
        {layout.shapes.map((shape) => (
          <div
            key={shape.id}
            data-shape-id={shape.id}
            className={`ph-shape ${shapeClassName(shape)}`}
            style={{ left: shape.x, top: shape.y, width: shape.width, height: shape.height }}
          >
            {renderShape(shape)}
          </div>
        ))}
        {positioned.map((p) => (
          <div
            key={p.key}
            className={`ph-canvas-node${p.interactive ? " ph-canvas-node--interactive" : ""}`}
            style={{ left: p.x, top: p.y, transform: p.translate }}
          >
            {p.node}
          </div>
        ))}
      </div>

      {layout.shapes.length > 0 && (
        <div className="ph-zoom-pill">
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
            −
          </button>
          <button
            type="button"
            className="ph-zoom-pill-pct"
            onClick={zoomToFit}
            aria-label="Zoom to fit"
            title="Zoom to fit"
          >
            {Math.round(viewport.zoom * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
            +
          </button>
        </div>
      )}
    </div>
  );
}
