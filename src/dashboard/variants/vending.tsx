import * as React from "react";
import { ItemMenu, useActions } from "~/dashboard/actions";
import type { Item } from "~/dashboard/data";
import { formatCount } from "~/dashboard/format";
import { Preview, seeded } from "~/dashboard/kinds";
import { isShortcut, PlayfulShell } from "~/dashboard/variants/playful-shell";
import type { VariantProps } from "~/dashboard/variants/types";
import { cn } from "~/lib/utils";

const COLUMNS = 5;
const ROW_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function codeFor(index: number) {
  return `${ROW_LETTERS[Math.floor(index / COLUMNS)] ?? "Z"}${(index % COLUMNS) + 1}`;
}

/**
 * Playful: every slot in the machine is something on Nap. Click a slot (or type its code) to
 * vend it into the tray, then push the tray to open it. The coin slot uploads.
 */
export function VendingLayout({ view, bar }: VariantProps) {
  const actions = useActions();
  const slots = view.visible;
  const [selected, setSelected] = React.useState<number | null>(null);
  const [typed, setTyped] = React.useState("");
  const [vendKey, setVendKey] = React.useState(0);
  const current = selected === null ? null : (slots[selected] ?? null);

  const vend = React.useCallback((index: number) => {
    setSelected(index);
    setVendKey((key) => key + 1);
    setTyped("");
  }, []);

  const press = React.useCallback(
    (key: string) => {
      if (key === "↵") {
        if (current) actions.open(current);
        return;
      }
      setTyped((value) => {
        const next = /[A-Z]/.test(key) ? key : value.length === 1 ? value + key : "";
        if (next.length === 2) {
          const row = ROW_LETTERS.indexOf(next[0]);
          const index = row * COLUMNS + Number(next[1]) - 1;
          if (index >= 0 && index < slots.length) {
            vend(index);
            return "";
          }
        }
        return next;
      });
    },
    [actions, current, slots.length, vend],
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isShortcut(event)) return;
      const key = event.key.toUpperCase();
      if (key === "ENTER") press("↵");
      else if (
        /^[A-Z]$/.test(key) &&
        key !== "H" &&
        ROW_LETTERS.indexOf(key) * COLUMNS < slots.length
      )
        press(key);
      else if (/^[1-5]$/.test(key)) press(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, slots.length]);

  const rowCount = Math.max(1, Math.ceil(slots.length / COLUMNS));
  const letters = ROW_LETTERS.slice(0, Math.min(rowCount, 6)).split("");

  return (
    <PlayfulShell
      view={view}
      bar={bar}
      connect="bottom-right"
      hint="type a code to vend"
      background="linear-gradient(oklch(0.92 0.004 60), oklch(0.86 0.006 60))"
    >
      <div className="absolute inset-x-0 bottom-0 h-[13vh] bg-[oklch(0.72_0.01_60)]" />
      <div className="absolute inset-0 flex items-center justify-center pt-[132px] pb-6 lg:justify-start lg:pl-[max(2rem,9vw)]">
        <div className="flex h-full max-h-[820px] w-[min(880px,calc(100vw-2rem))] gap-[22px] rounded-[26px] bg-[linear-gradient(90deg,#b91c1c,#dc2626_40%,#b91c1c)] p-[clamp(14px,2vw,26px)] shadow-[0_50px_80px_-30px_rgb(0_0_0/0.5)]">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="grid h-12 shrink-0 place-items-center rounded-xl bg-[#7f1d1d] text-2xl font-extrabold tracking-[0.3em] text-[#fde68a]">
              N · A · P
            </div>
            <div className="relative min-h-0 flex-1 overflow-y-auto rounded-[14px] bg-[#1c1917] bg-[linear-gradient(135deg,rgb(255_255_255/0.3),rgb(255_255_255/0.04)_40%,transparent)] p-3.5 shadow-[inset_0_0_0_6px_#292524]">
              <div className="grid grid-cols-5 gap-x-2.5 gap-y-5">
                {slots.map((item, index) => (
                  <Slot
                    key={item.key}
                    item={item}
                    code={codeFor(index)}
                    tilt={(seeded(index) - 0.5) * 4}
                    active={selected === index}
                    onSelect={() => vend(index)}
                    onOpen={() => actions.open(item)}
                  />
                ))}
              </div>
              {slots.length === 0 && (
                <p className="py-16 text-center font-mono text-sm text-stone-400">
                  SOLD OUT. Ask your agent to restock.
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={!current}
              onClick={() => current && actions.open(current)}
              className="relative h-24 shrink-0 overflow-hidden rounded-xl bg-[#1c1917] shadow-[inset_0_10px_20px_rgb(0_0_0/0.6)] enabled:hover:bg-[#292524]"
              aria-label={current ? `Open ${current.title}` : "The tray is empty"}
            >
              {current && (
                <div key={vendKey} className="nap-vend absolute top-5 left-1/3 w-28 -rotate-6">
                  <Preview item={current} />
                </div>
              )}
              <span className="absolute right-3.5 bottom-2.5 font-mono text-[11px] text-stone-400">
                {current ? "PUSH TO OPEN" : "TRAY"}
              </span>
            </button>
          </div>
          <div className="flex w-[clamp(150px,22%,210px)] shrink-0 flex-col gap-4">
            <div className="h-[120px] rounded-[10px] bg-[#052e16] p-3 font-mono text-[13px] leading-[1.4] text-[#4ade80] shadow-[inset_0_0_0_4px_#14532d] [text-shadow:0_0_8px_#22c55e]">
              {current ? (
                <>
                  {codeFor(selected!)} · {current.title.toUpperCase()}
                  <br />
                  <span className="opacity-70">
                    {current.mine ? "by you" : `by ${current.ownerName}`}
                    {current.kind !== "app" && ` · ${formatCount(current.views)} views`}
                  </span>
                  <br />
                  <span className="opacity-70">&gt; ENTER TO OPEN</span>
                </>
              ) : (
                <>
                  {typed ? `${typed}_` : "MAKE A SELECTION"}
                  <br />
                  <span className="opacity-70">{slots.length} IN STOCK</span>
                </>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[...letters, "1", "2", "3", "4", "5", "↵"].map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  className="h-11 rounded-[10px] bg-[linear-gradient(#f5f5f4,#d6d3d1)] font-bold text-stone-700 shadow-[0_3px_0_#78716c] hover:brightness-105 active:translate-y-[3px] active:shadow-none"
                >
                  {key}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => actions.pickFiles()}
              className="flex flex-col items-center gap-2 rounded-xl bg-[#7f1d1d] p-3.5 text-[#fecaca] hover:bg-[#8f2020]"
            >
              <span className="h-14 w-3 rounded-md bg-[#1c1917] shadow-[inset_0_0_0_2px_#450a0a]" />
              <span className="text-center font-mono text-[11px] tracking-[0.1em]">
                INSERT FILES
                <br />
                <span className="opacity-70">(upload)</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </PlayfulShell>
  );
}

function Slot({
  item,
  code,
  tilt,
  active,
  onSelect,
  onOpen,
}: {
  item: Item;
  code: string;
  tilt: number;
  active: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <ItemMenu item={item} className="block">
      <button
        type="button"
        title={item.title}
        onClick={onSelect}
        onDoubleClick={onOpen}
        className={cn(
          "flex w-full flex-col items-center gap-1.5 border-b-4 border-stone-600 pb-1.5 outline-none",
          active && "border-[#4ade80]",
        )}
      >
        <span className="block w-full px-1" style={{ transform: `rotate(${tilt}deg)` }}>
          <Preview item={item} className={cn(active && "opacity-30")} />
        </span>
        <svg viewBox="0 0 100 14" className="h-3 w-[90%]" aria-hidden="true">
          <path
            d="M0 7 Q 6 0 12 7 T 24 7 T 36 7 T 48 7 T 60 7 T 72 7 T 84 7 T 96 7"
            fill="none"
            stroke="#a8a29e"
            strokeWidth="2"
          />
        </svg>
        <span className="max-w-full truncate rounded bg-stone-700 px-1.5 font-mono text-[11px] text-stone-50">
          {code} · {item.title}
        </span>
      </button>
    </ItemMenu>
  );
}
