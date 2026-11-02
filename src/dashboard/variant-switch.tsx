import {
  AlignLeftIcon,
  CircleDotDashedIcon,
  LayoutPanelLeftIcon,
  ListIcon,
  OrbitIcon,
  Rows3Icon,
  ShuffleIcon,
} from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { GroupTab, GroupTabs } from "~/dashboard/controls";
import { cn } from "~/lib/utils";

export type Mode = "tidy" | "playful";
export type Variant = "headline" | "steps" | "rings" | "canvas" | "vending";

export const VARIANTS: Record<
  Variant,
  { mode: Mode; name: string; hint: string; icon: React.ComponentType<{ className?: string }> }
> = {
  headline: { mode: "tidy", name: "Headline", hint: "Prompt on top", icon: AlignLeftIcon },
  steps: { mode: "tidy", name: "Steps", hint: "Sidebar + cards", icon: LayoutPanelLeftIcon },
  rings: { mode: "playful", name: "Rings", hint: "Orbit the prompt", icon: OrbitIcon },
  canvas: { mode: "playful", name: "Canvas", hint: "Pan and fling", icon: ShuffleIcon },
  vending: { mode: "playful", name: "Vending", hint: "Pick a slot", icon: Rows3Icon },
};

export const VARIANT_IDS = Object.keys(VARIANTS) as Array<Variant>;

const GROUPS: Array<{ mode: Mode; label: string; variants: Array<Variant> }> = [
  { mode: "tidy", label: "Tidy", variants: ["headline", "steps"] },
  { mode: "playful", label: "Playful", variants: ["rings", "canvas", "vending"] },
];

const HOLD_MS = 450;
const PANEL_WIDTH = 420;

/** The look the expanded panel and other Nap popovers share. */
export const PANEL_CLASS = "rounded-2xl border bg-popover text-popover-foreground shadow-2xl";

/** A small mono heading, for groups in panels. */
export function PanelHeading({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "px-1 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Tidy or Playful. Hold it, or click it three times, and it grows into the list of layouts in
 * each mode. Escape or a click outside folds it back.
 */
export function VariantSwitch({
  variant,
  onModeChange,
  onVariantChange,
}: {
  variant: Variant;
  onModeChange: (mode: Mode) => void;
  onVariantChange: (variant: Variant) => void;
}) {
  const mode = VARIANTS[variant].mode;
  const [open, setOpen] = React.useState(false);
  const [pill, setPill] = React.useState({ width: 190, height: 40 });
  const [panelHeight, setPanelHeight] = React.useState(240);
  const pillRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const hold = React.useRef<number | null>(null);
  const held = React.useRef(false);

  React.useLayoutEffect(() => {
    const element = pillRef.current;
    if (!element) return;
    const measure = () => setPill({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    if (open && panelRef.current) setPanelHeight(panelRef.current.offsetHeight);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const cancelHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      style={{ width: pill.width, height: pill.height }}
      onPointerDown={(event) => {
        if (open || event.button !== 0) return;
        held.current = false;
        cancelHold();
        hold.current = window.setTimeout(() => {
          held.current = true;
          setOpen(true);
        }, HOLD_MS);
      }}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onContextMenu={(event) => {
        // On touch screens a long press opens the context menu otherwise.
        if (held.current) event.preventDefault();
      }}
    >
      {/* The surface grows from the pill's size to the panel's: the same element, morphing. */}
      <div
        className={cn(
          "absolute top-0 left-1/2 z-50 -translate-x-1/2 overflow-hidden transition-[width,height,border-radius,box-shadow,background-color,border-color] duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          open ? PANEL_CLASS : "rounded-full",
        )}
        style={{
          width: open ? PANEL_WIDTH : pill.width,
          height: open ? panelHeight : pill.height,
          // Half the pill's height is fully round, and doesn't go oval on the way to 18.
          borderRadius: open ? 18 : pill.height / 2,
        }}
      >
        <div
          className={cn(
            "absolute top-0 left-1/2 -translate-x-1/2 transition-opacity duration-200",
            open && "pointer-events-none opacity-0",
          )}
        >
          <GroupTabs
            value={mode}
            onValueChange={onModeChange}
            floating
            listRef={pillRef}
            label="Dashboard mode. Hold or triple-click for layouts."
          >
            {GROUPS.map((group) => (
              <GroupTab
                key={group.mode}
                value={group.mode}
                onClick={(event) => {
                  if (held.current) {
                    held.current = false;
                    event.preventDefault();
                    return;
                  }
                  if (event.detail >= 3) setOpen(true);
                }}
              >
                {group.mode === "tidy" ? <ListIcon /> : <CircleDotDashedIcon />}
                {group.label}
              </GroupTab>
            ))}
          </GroupTabs>
        </div>

        <div
          ref={panelRef}
          aria-hidden={!open}
          inert={!open}
          className={cn(
            "flex flex-col gap-2 p-2 transition-[opacity,translate]",
            // In after the surface has started to grow; out quickly, before the tabs are back.
            open
              ? "translate-y-0 opacity-100 delay-100 duration-300"
              : "-translate-y-1 opacity-0 duration-100",
          )}
          style={{ width: PANEL_WIDTH }}
        >
          {GROUPS.map((group, groupIndex) => (
            <React.Fragment key={group.mode}>
              {groupIndex > 0 && <div className="mx-2 h-px bg-border" />}
              <div
                className="flex flex-col gap-1.5 px-1 pt-1"
                role="group"
                aria-label={group.label}
              >
                <PanelHeading>{group.label}</PanelHeading>
                <div className="grid grid-cols-3 gap-1.5">
                  {group.variants.map((id) => {
                    const meta = VARIANTS[id];
                    const Icon = meta.icon;
                    const active = id === variant;
                    return (
                      <Button
                        key={id}
                        variant={active ? "outline" : "ghost"}
                        aria-pressed={active}
                        onClick={() => {
                          onVariantChange(id);
                          setOpen(false);
                        }}
                        className={cn(
                          "h-auto flex-col items-start gap-2 rounded-xl p-2.5 text-left whitespace-normal",
                          active && "border-foreground/30 shadow-xs",
                        )}
                      >
                        <Icon
                          className={cn("text-muted-foreground", active && "text-foreground")}
                        />
                        <span className="flex flex-col">
                          <span className="text-sm font-semibold">{meta.name}</span>
                          <span className="font-mono text-[9.5px] font-normal tracking-[0.06em] text-muted-foreground uppercase">
                            {meta.hint}
                          </span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
