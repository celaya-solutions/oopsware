import { useEffect, useRef, useState } from "react";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "../components/ui/button";

type Camera = { x: number; y: number; scale: number };

/**
 * Shows one graph SVG (built by src/domain/graph/graphSvg.ts, values already
 * escaped) with drag to pan, wheel or buttons to zoom, and fit to view.
 * A click on a node reports its id; the List view is the keyboard path.
 */
export function GraphCanvas({
  svg,
  width,
  height,
  onSelect,
}: {
  svg: string;
  width: number;
  height: number;
  onSelect: (id: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });

  const fit = () => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !width || !height) return;
    const scale = Math.min(1, box.width / width, box.height / height);
    setCamera({
      scale,
      x: (box.width - width * scale) / 2,
      y: Math.max(0, (box.height - height * scale) / 2),
    });
  };
  useEffect(fit, [width, height]);

  const zoom = (factor: number, at?: { x: number; y: number }) =>
    setCamera((c) => {
      const scale = Math.min(4, Math.max(0.1, c.scale * factor));
      const box = frame.current?.getBoundingClientRect();
      const px = at?.x ?? (box ? box.width / 2 : 0);
      const py = at?.y ?? (box ? box.height / 2 : 0);
      return {
        scale,
        x: px - ((px - c.x) * scale) / c.scale,
        y: py - ((py - c.y) * scale) / c.scale,
      };
    });

  // React's onWheel is passive; zooming needs preventDefault.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  return (
    <div className="graph-canvas-wrap">
      <div className="graph-zoom" role="group" aria-label="Zoom">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Zoom in"
          onClick={() => zoom(1.25)}
        >
          <ZoomIn />
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Zoom out"
          onClick={() => zoom(0.8)}
        >
          <ZoomOut />
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Fit to view"
          onClick={fit}
        >
          <Maximize />
        </Button>
      </div>
      <div
        ref={frame}
        className="graph-canvas"
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          if (event.buttons === 0) {
            drag.current = null;
            return;
          }
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.moved && Math.hypot(dx, dy) < 4) return;
          start.moved = true;
          start.x = event.clientX;
          start.y = event.clientY;
          setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
        }}
        onPointerCancel={() => (drag.current = null)}
        onPointerUp={(event) => {
          const start = drag.current;
          drag.current = null;
          if (start?.moved) return;
          // Pointer capture retargets the event; find the node under the pointer.
          const hit = document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest("[data-node-id]");
          const id = hit?.getAttribute("data-node-id");
          if (id) onSelect(id);
        }}
      >
        <div
          className="graph-stage"
          style={{
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
