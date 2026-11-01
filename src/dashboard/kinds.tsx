import {
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  LockIcon,
  SmartphoneIcon,
  UsersIcon,
} from "lucide-react";
import * as React from "react";
import type { Item, Kind } from "~/dashboard/data";
import { EVERYONE_LABEL } from "~/lib/deployment-text";
import { cn } from "~/lib/utils";

const KIND_ICON = { site: GlobeIcon, artifact: FileTextIcon, app: SmartphoneIcon } as const;

export const KIND_TEXT: Record<Kind, string> = {
  site: "text-kind-site",
  artifact: "text-kind-artifact",
  app: "text-kind-app",
};

export const KIND_SOFT: Record<Kind, string> = {
  site: "bg-kind-site-soft",
  artifact: "bg-kind-artifact-soft",
  app: "bg-kind-app-soft",
};

/** Sites are a globe, artifacts a page, apps a phone. Each in its kind's colour. */
export function KindIcon({
  kind,
  className,
  muted,
}: {
  kind: Kind;
  className?: string;
  muted?: boolean;
}) {
  const Icon = KIND_ICON[kind];
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4 shrink-0", !muted && KIND_TEXT[kind], className)}
    />
  );
}

/** The kind as a small tinted tile, for list rows. Each kind has its own corner shape too. */
export function KindTile({ kind, className }: { kind: Kind; className?: string }) {
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center",
        KIND_SOFT[kind],
        kind === "artifact"
          ? "rounded-[5px_13px_5px_5px]"
          : kind === "app"
            ? "rounded-xl"
            : "rounded-lg",
        className,
      )}
    >
      <KindIcon kind={kind} className="size-[18px]" />
    </span>
  );
}

export function AccessIcon({ item, className }: { item: Item; className?: string }) {
  const visibility = item.site?.visibility ?? "everyone";
  const [Icon, label] =
    visibility === "everyone"
      ? [GlobeIcon, EVERYONE_LABEL]
      : visibility === "selected"
        ? [UsersIcon, "Only people invited"]
        : [LockIcon, "Only you"];
  return (
    <span title={label} className="inline-flex shrink-0">
      <Icon className={cn("size-3", className)} aria-label={label} />
    </span>
  );
}

export function SourceIcon({ item }: { item: Item }) {
  if (!item.site?.hasSource) return null;
  return (
    <span title="Source in Nap. Ask an agent to change it." className="inline-flex shrink-0">
      <GitBranchIcon className="size-3" aria-label="Source in Nap" />
    </span>
  );
}

/** A stable number for a string, for colours and layouts that must not jump between renders. */
export function hash(value: string) {
  let h = 2166136261;
  for (let index = 0; index < value.length; index++) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 0..1, stable for a seed. */
export function seeded(seed: number) {
  const x = Math.sin(seed * 999.13 + 1.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Colours made from the slug, until Nap has screenshots. */
export function itemColors(item: Pick<Item, "slug">) {
  const h = hash(item.slug);
  const hue = h % 360;
  const dark = (h >> 9) % 3 === 0;
  return {
    hue,
    dark,
    bg: dark ? `oklch(0.28 0.06 ${hue})` : `oklch(0.95 0.05 ${hue})`,
    fg: dark ? `oklch(0.95 0.03 ${hue})` : `oklch(0.32 0.09 ${hue})`,
    accent: `oklch(0.68 0.17 ${(hue + 25) % 360})`,
  };
}

const PATTERNS = ["bars", "grid", "rows", "hero"] as const;

/** A made-up page in the item's colours. All sizes are relative to the container (cqw). */
function FakePage({ item }: { item: Item }) {
  const { bg, fg, accent } = itemColors(item);
  const pattern = PATTERNS[hash(item.slug + "p") % PATTERNS.length];
  let body: React.ReactNode;
  if (pattern === "bars") {
    body = (
      <div className="flex h-full items-end gap-[3cqw] px-[8cqw] pt-[22cqw] pb-[8cqw]">
        {[0.4, 0.7, 0.55, 0.9, 0.62, 0.8, 0.35, 0.75].map((height, index) => (
          <span
            key={index}
            className="flex-1 rounded-t-[1.5cqw]"
            style={{ height: `${height * 100}%`, background: accent, opacity: 0.5 + height / 2 }}
          />
        ))}
      </div>
    );
  } else if (pattern === "grid") {
    body = (
      <div className="grid h-full grid-cols-3 gap-[4cqw] p-[7cqw] pt-[20cqw]">
        {Array.from({ length: 6 }, (_, index) => (
          <span
            key={index}
            className="rounded-[2.5cqw]"
            style={{
              background: index % 3 === 1 ? accent : fg,
              opacity: index % 3 === 1 ? 0.85 : 0.12,
            }}
          />
        ))}
      </div>
    );
  } else if (pattern === "rows") {
    body = (
      <div className="flex h-full flex-col justify-center gap-[4.5cqw] px-[9cqw] pt-[14cqw]">
        {[0.8, 0.65, 0.72, 0.5].map((width, index) => (
          <div key={index} className="flex items-center gap-[4cqw]">
            <span
              className="size-[5cqw] shrink-0 rounded-full"
              style={{ background: index === 0 ? accent : fg, opacity: index === 0 ? 1 : 0.25 }}
            />
            <span
              className="h-[3cqw] rounded-full"
              style={{ width: `${width * 80}%`, background: fg, opacity: 0.2 }}
            />
          </div>
        ))}
      </div>
    );
  } else {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-[4cqw] pt-[6cqw]">
        <span className="h-[3cqw] w-[40%] rounded-full" style={{ background: fg, opacity: 0.2 }} />
        <span className="h-[3cqw] w-[28%] rounded-full" style={{ background: accent }} />
      </div>
    );
  }
  return (
    <div
      className="@container relative size-full overflow-hidden"
      style={{ background: bg, color: fg }}
    >
      <span
        className="absolute top-[6cqw] left-[7cqw] right-[7cqw] truncate text-[9cqw] leading-none font-semibold tracking-tight"
        style={{ color: fg }}
      >
        {item.title}
      </span>
      {body}
    </div>
  );
}

/**
 * A preview of an item, framed by its kind: sites are browser windows, artifacts are sheets of
 * paper, apps are app icons. Until Nap takes screenshots, the page is made up from the slug.
 * It fills its container, which sets the size (aspect 1.6).
 */
export function Preview({ item, className }: { item: Item; className?: string }) {
  if (item.kind === "app") {
    const { hue } = itemColors(item);
    return (
      <div
        className={cn(
          "@container grid aspect-[1.6] place-items-center rounded-[min(14px,8cqw)] border border-dashed border-kind-app/30 bg-kind-app-soft/50",
          className,
        )}
      >
        <span
          className="grid size-[30cqw] place-items-center rounded-[22%] text-[14cqw] font-bold text-white shadow-[0_6px_14px_-6px_rgb(0_0_0/0.4),inset_0_1px_0_rgb(255_255_255/0.3)]"
          style={{
            background: `linear-gradient(145deg, oklch(0.62 0.2 ${hue}), oklch(0.5 0.22 ${(hue + 40) % 360}))`,
          }}
        >
          {item.title.charAt(0).toUpperCase()}
        </span>
      </div>
    );
  }
  if (item.kind === "artifact") {
    return (
      <div className={cn("@container flex aspect-[1.6] items-center justify-center", className)}>
        <div className="relative h-full w-[84%] rounded-[3px] bg-white p-[4%] shadow-[0_1px_2px_rgb(0_0_0/0.1),0_6px_14px_-8px_rgb(0_0_0/0.3)] [clip-path:polygon(0_0,86%_0,100%_14%,100%_100%,0_100%)]">
          <div className="size-full overflow-hidden rounded-[2px]">
            <FakePage item={item} />
          </div>
          <span className="absolute top-0 right-0 size-[14%] bg-[linear-gradient(225deg,transparent_50%,oklch(0.92_0.005_80)_50%)]" />
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "@container flex aspect-[1.6] flex-col overflow-hidden rounded-[min(10px,4cqw)] border border-foreground/12 bg-white shadow-xs",
        className,
      )}
    >
      <div className="flex h-[7cqw] max-h-4 min-h-1.5 shrink-0 items-center gap-[1.4cqw] border-b border-foreground/7 bg-muted px-[4cqw]">
        <i className="size-[1.6cqw] max-h-1.5 max-w-1.5 rounded-full bg-foreground/15" />
        <i className="size-[1.6cqw] max-h-1.5 max-w-1.5 rounded-full bg-foreground/15" />
        <i className="size-[1.6cqw] max-h-1.5 max-w-1.5 rounded-full bg-foreground/15" />
      </div>
      <div className="min-h-0 flex-1">
        <FakePage item={item} />
      </div>
    </div>
  );
}
