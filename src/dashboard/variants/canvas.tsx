import * as React from "react";
import { ItemMenu, useActions } from "~/dashboard/actions";
import type { Item } from "~/dashboard/data";
import { KindIcon, Preview, seeded } from "~/dashboard/kinds";
import { PlayfulShell } from "~/dashboard/variants/playful-shell";
import type { VariantProps } from "~/dashboard/variants/types";
import { cn } from "~/lib/utils";

const CELL_W = 220;
const CELL_H = 196;
const CARD_W = 196;
/** Friction per second for flung cards and the canvas. */
const FRICTION = 0.02;

type Card = {
  item: Item;
  /** Position in the world, which repeats in both directions. */
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  lifted: boolean;
};

let topZ = 1;

const mod = (value: number, size: number) => ((value % size) + size) % size;

/**
 * Playful: a pile of cards on an endless table. Drag the table to pan forever (the pile repeats),
 * fling a card to move it, click one to open it.
 */
export function CanvasLayout({ view, bar }: VariantProps) {
  const actions = useActions();
  const [viewport, setViewport] = React.useState({ width: 1440, height: 900 });
  const cards = React.useRef<Array<Card>>([]);
  const elements = React.useRef<Array<HTMLDivElement | null>>([]);
  const pan = React.useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const drag = React.useRef<null | {
    kind: "pan" | "card";
    card?: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    lastT: number;
    moved: boolean;
  }>(null);
  const [, setVersion] = React.useState(0);

  React.useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // The world is a grid at least one card bigger than the screen on every side, so each card
  // shows once while it wraps around.
  const columns = Math.ceil(viewport.width / CELL_W) + 2;
  const rows = Math.ceil(viewport.height / CELL_H) + 2;
  const worldW = columns * CELL_W;
  const worldH = rows * CELL_H;
  const shown = view.visible;

  React.useLayoutEffect(() => {
    if (shown.length === 0) {
      cards.current = [];
    } else {
      cards.current = Array.from({ length: columns * rows }, (_, cell) => {
        const column = cell % columns;
        const row = Math.floor(cell / columns);
        // Neighbours differ: step through the items with a stride that is not a factor.
        const item = shown[(column * 3 + row * 7) % shown.length];
        return {
          item,
          x: column * CELL_W + (seeded(cell) - 0.5) * 26 + (row % 2 ? 40 : 0),
          y: row * CELL_H + (seeded(cell + 7) - 0.5) * 22,
          rotation: (seeded(cell + 3) - 0.5) * 9,
          vx: 0,
          vy: 0,
          lifted: false,
        };
      });
    }
    elements.current.length = cards.current.length;
    setVersion((value) => value + 1);
  }, [shown, columns, rows]);

  React.useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const decay = Math.pow(FRICTION, dt);
      const p = pan.current;
      if (drag.current?.kind !== "pan") {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= decay;
        p.vy *= decay;
      }
      cards.current.forEach((card, index) => {
        if (!card.lifted) {
          card.x += card.vx * dt;
          card.y += card.vy * dt;
          card.vx *= decay;
          card.vy *= decay;
        }
        const element = elements.current[index];
        if (!element) return;
        const x = mod(card.x + p.x, worldW) - CELL_W;
        const y = mod(card.y + p.y, worldH) - CELL_H;
        element.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${card.rotation}deg) scale(${card.lifted ? 1.08 : 1})`;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [worldW, worldH]);

  function start(event: React.PointerEvent, card?: number) {
    if (event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = {
      kind: card === undefined ? "pan" : "card",
      card,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastT: performance.now(),
      moved: false,
    };
    if (card === undefined) {
      pan.current.vx = 0;
      pan.current.vy = 0;
    } else {
      const target = cards.current[card];
      target.vx = 0;
      target.vy = 0;
    }
  }

  function move(event: React.PointerEvent) {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    const now = performance.now();
    const dt = Math.max(0.001, (now - state.lastT) / 1000);
    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 4)
      state.moved = true;
    if (state.kind === "pan") {
      pan.current.x += dx;
      pan.current.y += dy;
      pan.current.vx = dx / dt;
      pan.current.vy = dy / dt;
    } else if (state.card !== undefined && state.moved) {
      const card = cards.current[state.card];
      card.lifted = true;
      card.x += dx;
      card.y += dy;
      card.vx = dx / dt;
      card.vy = dy / dt;
      // Bring it to the top of the pile.
      const element = elements.current[state.card];
      if (element) element.style.zIndex = String(++topZ);
    }
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastT = now;
  }

  function end() {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    // A pause before letting go is not a fling.
    const still = performance.now() - state.lastT > 80;
    if (state.kind === "pan" && still) {
      pan.current.vx = 0;
      pan.current.vy = 0;
    }
    if (state.kind === "card" && state.card !== undefined) {
      const card = cards.current[state.card];
      card.lifted = false;
      if (still) {
        card.vx = 0;
        card.vy = 0;
      }
      if (!state.moved) actions.open(card.item);
    }
  }

  return (
    <PlayfulShell
      view={view}
      bar={bar}
      hint="fling a card"
      background="color-mix(in oklch, var(--muted) 70%, oklch(0.9 0.02 80))"
    >
      <div
        className="absolute inset-0 cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={(event) => start(event)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onWheel={(event) => {
          pan.current.x -= event.deltaX;
          pan.current.y -= event.deltaY;
        }}
      >
        {cards.current.map((card, index) => (
          <div
            key={`${card.item.key}-${index}`}
            ref={(element) => {
              elements.current[index] = element;
            }}
            className="absolute top-0 left-0 will-change-transform"
            style={{ width: CARD_W }}
          >
            <ItemMenu item={card.item} className="block">
              <PileCard
                item={card.item}
                onPointerDown={(event) => start(event, index)}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
              />
            </ItemMenu>
          </div>
        ))}
      </div>
    </PlayfulShell>
  );
}

function PileCard({ item, ...handlers }: { item: Item } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...handlers}
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title}`}
      className={cn(
        "bg-card p-2 pb-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.12),0_6px_14px_-8px_rgb(0_0_0/0.25)] transition-shadow hover:shadow-[0_18px_30px_-14px_rgb(0_0_0/0.4)]",
        item.kind === "app"
          ? "rounded-[22px]"
          : item.kind === "artifact"
            ? "rounded-[3px] bg-[oklch(0.995_0.006_95)]"
            : "rounded-[10px]",
      )}
    >
      <Preview item={item} className="pointer-events-none" />
      <div className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold">
        <KindIcon kind={item.kind} className="size-3" />
        <span className="flex-1 truncate">{item.title}</span>
        {!item.mine && (
          <span className="max-w-16 truncate font-normal text-muted-foreground">
            {item.ownerName}
          </span>
        )}
      </div>
    </div>
  );
}
