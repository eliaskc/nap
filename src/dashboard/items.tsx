import * as React from "react";
import { ItemMenu, useActions } from "~/dashboard/actions";
import { EmptyState, LoadingRows } from "~/dashboard/chrome";
import type { Item, ItemView } from "~/dashboard/data";
import { formatCount } from "~/dashboard/format";
import { AccessIcon, KindIcon, KindTile, Preview, SourceIcon } from "~/dashboard/kinds";
import { cn } from "~/lib/utils";

/** Drop files on an item you own to publish a new version of it. */
function useDropTarget(item: Item) {
  const actions = useActions();
  const [over, setOver] = React.useState(false);
  const site = item.site;
  if (!site || !item.mine || site.hasSource) return { over: false, props: {} };
  const stop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    over,
    props: {
      onDragEnter: (event: React.DragEvent) => {
        stop(event);
        setOver(true);
      },
      onDragOver: stop,
      onDragLeave: (event: React.DragEvent) => {
        stop(event);
        setOver(false);
      },
      onDrop: (event: React.DragEvent) => {
        stop(event);
        setOver(false);
        actions.drop(event.dataTransfer.files, site);
      },
    },
  };
}

function Meta({ item }: { item: Item }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <AccessIcon item={item} />
      <span className="truncate">
        {item.label}
        {!item.mine && ` · ${item.ownerName}`}
      </span>
      <SourceIcon item={item} />
    </span>
  );
}

export function ItemRow({ item }: { item: Item }) {
  const actions = useActions();
  const drop = useDropTarget(item);
  return (
    <li>
      <ItemMenu item={item}>
        <div
          {...drop.props}
          className={cn(
            "relative flex items-center gap-3.5 px-3.5 py-2.5 transition-colors hover:bg-muted/50",
            drop.over && "bg-primary/5 ring-2 ring-primary/30 ring-inset",
          )}
        >
          <button
            type="button"
            aria-label={`Open ${item.title}`}
            onClick={() => actions.open(item)}
            className="absolute inset-0 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
          <KindTile kind={item.kind} className="pointer-events-none relative" />
          <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">
              {item.title}
            </span>
            <Meta item={item} />
          </div>
          {item.kind !== "app" && (
            <span className="pointer-events-none relative w-20 shrink-0 text-right text-[13px] text-muted-foreground tabular-nums">
              {formatCount(item.views)} {item.views === 1 ? "view" : "views"}
            </span>
          )}
        </div>
      </ItemMenu>
    </li>
  );
}

export function ItemCard({ item }: { item: Item }) {
  const actions = useActions();
  const drop = useDropTarget(item);
  return (
    <ItemMenu item={item}>
      <div {...drop.props} className="group/card relative flex flex-col gap-2.5">
        <button
          type="button"
          aria-label={`Open ${item.title}`}
          onClick={() => actions.open(item)}
          className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div
          className={cn(
            "grid place-items-center rounded-xl p-0 transition-transform duration-200 group-hover/card:-translate-y-0.5",
            item.kind === "artifact" && "bg-kind-artifact-soft/40 px-4 py-2.5",
            item.kind === "app" && "bg-transparent",
            drop.over && "ring-2 ring-primary/40",
          )}
        >
          <Preview item={item} className="w-full" />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <KindIcon kind={item.kind} className="size-3.5" />
          <span className="flex-1 truncate text-sm font-semibold">{item.title}</span>
          {!item.mine && (
            <span className="max-w-24 truncate text-xs text-muted-foreground">
              {item.ownerName}
            </span>
          )}
          {item.kind !== "app" && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatCount(item.views)}
            </span>
          )}
        </div>
      </div>
    </ItemMenu>
  );
}

/** The items as a list or as cards, whichever the person picked. */
export function ItemCollection({
  view,
  loading,
  columns = 3,
}: {
  view: ItemView;
  loading: boolean;
  columns?: 2 | 3 | 4;
}) {
  if (loading)
    return (
      <div className="overflow-hidden rounded-2xl border bg-card/80">
        <LoadingRows />
      </div>
    );
  if (view.visible.length === 0)
    return (
      <div className="rounded-2xl border bg-card/80">
        <EmptyState view={view} />
      </div>
    );
  if (view.look === "cards")
    return (
      <div
        className={cn(
          "grid gap-x-[18px] gap-y-6",
          columns === 2 && "grid-cols-1 sm:grid-cols-2",
          columns === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
          columns === 4 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4",
        )}
      >
        {view.visible.map((item) => (
          <ItemCard key={item.key} item={item} />
        ))}
      </div>
    );
  return (
    <ul className="divide-y overflow-hidden rounded-2xl border bg-card/80 backdrop-blur-sm">
      {view.visible.map((item) => (
        <ItemRow key={item.key} item={item} />
      ))}
    </ul>
  );
}
