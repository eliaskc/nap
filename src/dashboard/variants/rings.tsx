import * as React from "react";
import { ItemMenu, useActions } from "~/dashboard/actions";
import { ExampleText, PROMPT_PILL, PromptButtons, useExample } from "~/dashboard/connect";
import type { Item } from "~/dashboard/data";
import { Preview } from "~/dashboard/kinds";
import { PlayfulShell } from "~/dashboard/variants/playful-shell";
import type { VariantProps } from "~/dashboard/variants/types";
import { napConfig } from "~/nap.config";

/** Radius (of the shorter side), tile width, how many tiles fit, and the idle speed (deg/s). */
const RINGS = [
  { r: 0.42, w: 132, n: 9, speed: 1.6 },
  { r: 0.6, w: 112, n: 14, speed: -1.1 },
  { r: 0.78, w: 96, n: 19, speed: 0.8 },
  { r: 0.96, w: 84, n: 25, speed: -0.55 },
];

function useViewport() {
  const [size, setSize] = React.useState({ width: 1440, height: 900 });
  React.useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}

/**
 * Playful: everything orbits the prompt, the most popular things on the inner ring. Scroll turns
 * the rings; they keep drifting on their own.
 */
export function RingsLayout({ view, bar, items }: VariantProps) {
  const { width, height } = useViewport();
  const unit = Math.min(width * 0.62, height * 1.05);
  const ringRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const spin = React.useRef({ angle: 0, velocity: 0 });
  const index = useExample();
  const shown = view.visible;

  // Fill the rings from the inside, most popular first. Repeat when there are few things.
  const rings = React.useMemo(() => {
    let next = 0;
    return RINGS.map((ring) => {
      const count = shown.length === 0 ? 0 : Math.min(ring.n, Math.max(6, shown.length));
      return {
        ...ring,
        tiles: Array.from({ length: count }, () => shown[next++ % shown.length]),
      };
    });
  }, [shown]);

  React.useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const state = spin.current;
      state.angle += (reduced ? 0 : 6 * dt) + state.velocity * dt;
      state.velocity *= Math.pow(0.04, dt);
      ringRefs.current.forEach((element, ring) => {
        if (element)
          element.style.transform = `rotate(${state.angle * RINGS[ring].speed + ring * 11}deg)`;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const onWheel = (event: WheelEvent) => {
      spin.current.velocity += (event.deltaY + event.deltaX) * 0.6;
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <PlayfulShell
      view={view}
      bar={bar}
      connect="none"
      background="radial-gradient(circle at 50% 52%, var(--background) 0 22%, color-mix(in oklch, var(--muted) 80%, var(--background)) 70%)"
    >
      <div className="absolute inset-0 [perspective:1800px]">
        <div
          className="absolute [transform-style:preserve-3d] [transform:rotateX(38deg)]"
          style={{ left: width / 2, top: height / 2 + 20 }}
        >
          {rings.map((ring, ringIndex) => {
            const radius = ring.r * unit;
            return (
              <div
                key={ringIndex}
                ref={(element) => {
                  ringRefs.current[ringIndex] = element;
                }}
                className="absolute top-0 left-0"
              >
                <div
                  className="pointer-events-none absolute rounded-full border border-dashed border-foreground/8"
                  style={{ left: -radius, top: -radius, width: radius * 2, height: radius * 2 }}
                />
                {ring.tiles.map((item, tileIndex) => (
                  <RingTile
                    key={`${item.key}-${tileIndex}`}
                    item={item}
                    width={ring.w * Math.min(1.2, Math.max(0.75, unit / 900))}
                    angle={(tileIndex / ring.tiles.length) * 360}
                    radius={radius}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-32 bg-gradient-to-b from-background to-transparent" />
      <div className="absolute top-1/2 left-1/2 z-20 w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2">
        <div className="flex flex-col items-center gap-4 rounded-2xl border bg-card p-6 text-center shadow-lg">
          <span className="text-[13px] font-medium text-muted-foreground">
            {napConfig.orgName} · {items.length} {items.length === 1 ? "thing" : "things"}
          </span>
          <ExampleText
            index={index}
            reserve={false}
            className="mb-1 w-full text-2xl leading-[1.15] font-semibold tracking-[-0.03em]"
          />
          <PromptButtons
            size="sm"
            className="justify-center"
            promptAlign="center"
            promptClassName={PROMPT_PILL}
          />
        </div>
      </div>
    </PlayfulShell>
  );
}

function RingTile({
  item,
  width,
  angle,
  radius,
}: {
  item: Item;
  width: number;
  angle: number;
  radius: number;
}) {
  const actions = useActions();
  return (
    <div
      className="absolute top-0 left-0"
      style={{ transform: `rotate(${angle}deg) translateY(${-radius}px)` }}
    >
      <ItemMenu item={item} className="block -translate-x-1/2 -translate-y-1/2" style={{ width }}>
        <button
          type="button"
          title={item.title}
          aria-label={`Open ${item.title}`}
          onClick={() => actions.open(item)}
          className="block w-full transition-transform duration-200 hover:scale-110 focus-visible:scale-110 focus-visible:outline-none"
        >
          <Preview item={item} />
        </button>
      </ItemMenu>
    </div>
  );
}
