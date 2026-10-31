import { HistoryIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { ago, useSystemDark } from "./app";

/**
 * The history button in the Nap bar on /artifact/<slug>. It lists the artifact's versions.
 * Clicking one shows it next to the live version; Restore makes it live. Nothing is deleted or
 * renumbered: Nap moves `sites.current_version`, and the next upload gets the next number.
 * The bar shows only the icon. A dot on it means an older version is live.
 *
 * Previews load from <frame prefix>/_nap/version/<id>/ with the page's frame token, so they get
 * the same sandbox. They read and write the live data.
 */

type Version = {
  id: string;
  number: number;
  createdAt: string;
  uploadedByEmail: string;
  uploadedByName: string | null;
  message: string;
  live: boolean;
};

export type HistoryConfig = {
  /** `/artifact/<slug>/_nap/versions`. */
  api: string;
  frame: HTMLIFrameElement;
  slot: HTMLElement;
  stage: HTMLElement;
  layer: HTMLElement;
};

export function HistoryApp({ api, frame, slot, stage, layer }: HistoryConfig) {
  const systemDark = useSystemDark();
  const [versions, setVersions] = useState<Array<Version> | null>(null);
  const [hasSource, setHasSource] = useState(false);
  const [open, setOpen] = useState(false);
  const [compare, setCompare] = useState<Version | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  // /_nap/frame/<token>: the frame's files. The rest of its src is the path it started on.
  const framePrefix = frame.dataset.src?.match(/^\/_nap\/frame\/[^/?#]+/)?.[0] ?? "";
  const base = frame.dataset.base ?? "";
  const live = versions?.find((version) => version.live) ?? null;
  const newest = versions?.[0] ?? null;

  const load = useCallback(async () => {
    const response = await fetch(api, { headers: { accept: "application/json" } });
    const body = (await response.json().catch(() => ({}))) as {
      versions?: Array<Version>;
      hasSource?: boolean;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error || "Could not load the history");
    setVersions(body.versions ?? []);
    setHasSource(Boolean(body.hasSource));
  }, [api]);

  useEffect(() => {
    load().catch((caught: Error) => setError(caught.message));
  }, [load]);

  useEffect(() => {
    if (!compare) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !open) setCompare(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compare, open]);

  /** The artifact path the bar shows, such as "/" or "/page.html?x=1". */
  const currentPath = () => {
    const path = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : "";
    return (path || "/") + location.search;
  };

  async function restore(version: Version) {
    setBusy(version.id);
    setError("");
    try {
      const response = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: version.id, expectedCurrentVersion: live?.id }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not restore");
      setCompare(null);
      // The frame token serves the live version, so loading the page again shows it.
      frame.src = framePrefix + currentPath() + location.hash;
      await load();
    } catch (caught) {
      setError((caught as Error).message);
      await load().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  if (!versions || versions.length < 2 || !framePrefix) return null;

  const who = (version: Version) => version.uploadedByName || version.uploadedByEmail;
  const path = compare ? currentPath() : "/";
  const behind = Boolean(live && newest && live.id !== newest.id);
  const title =
    live && newest
      ? behind
        ? `History · v${live.number} of ${newest.number} is live`
        : `History · v${live.number}`
      : "History";

  return (
    <>
      {createPortal(
        <div className={cn("contents", systemDark && "dark")}>
          <Popover
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (next) load().catch((caught: Error) => setError(caught.message));
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="relative text-inherit"
                  aria-label="Version history"
                  title={title}
                />
              }
            >
              <HistoryIcon />
              {behind && (
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-500" />
              )}
            </PopoverTrigger>
            <PopoverContent
              container={layer}
              align="end"
              collisionPadding={8}
              className="w-80 gap-0 overflow-hidden p-0"
            >
              <div className="flex h-10 items-center border-b px-3 font-medium">
                Version history
              </div>
              <ul className="flex max-h-96 flex-col overflow-y-auto">
                {versions.map((version) => (
                  <li
                    key={version.id}
                    className={cn(
                      "group flex items-start gap-2 px-3 py-2 hover:bg-muted",
                      compare?.id === version.id && "bg-muted",
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none"
                      disabled={version.live}
                      title={version.live ? undefined : "Compare with the live version"}
                      onClick={() => {
                        setCompare(version);
                        setOpen(false);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-medium tabular-nums">v{version.number}</span>
                        {version.live && <Badge>Live</Badge>}
                        <span
                          className="ml-auto text-xs text-muted-foreground"
                          title={new Date(version.createdAt).toLocaleString()}
                        >
                          {ago(version.createdAt)}
                        </span>
                      </span>
                      {version.message && (
                        <span className="line-clamp-2 break-words">{version.message}</span>
                      )}
                      <span className="truncate text-xs text-muted-foreground">{who(version)}</span>
                    </button>
                    {!version.live && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        title={`Make v${version.number} live`}
                        aria-label={`Restore v${version.number}`}
                        disabled={busy !== null}
                        onClick={() => void restore(version)}
                      >
                        <RotateCcwIcon />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {hasSource && (
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  Restoring does not change the source repo.
                </p>
              )}
              {error && <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p>}
            </PopoverContent>
          </Popover>
        </div>,
        slot,
      )}

      {compare &&
        live &&
        createPortal(
          <div
            className={cn(
              "absolute inset-0 z-30 flex flex-col bg-background text-foreground",
              systemDark && "dark",
            )}
          >
            <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">v{compare.number}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {who(compare)} · {ago(compare.createdAt)}
                </span>
              </span>
              {error && <span className="truncate text-xs text-destructive">{error}</span>}
              <Button size="sm" disabled={busy !== null} onClick={() => void restore(compare)}>
                <RotateCcwIcon />
                {busy === compare.id ? "Restoring…" : `Restore v${compare.number}`}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                title="Close (Esc)"
                onClick={() => setCompare(null)}
              >
                <XIcon />
              </Button>
            </div>
            <div className="grid min-h-0 flex-1 grid-rows-2 gap-px bg-border sm:grid-cols-2 sm:grid-rows-1">
              <Pane
                label={`v${compare.number}`}
                src={`${framePrefix}/_nap/version/${compare.id}${path}`}
                frame={frame}
              />
              <Pane label={`v${live.number} · live`} src={framePrefix + path} frame={frame} />
            </div>
          </div>,
          stage,
        )}
    </>
  );
}

function Pane({ label, src, frame }: { label: string; src: string; frame: HTMLIFrameElement }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-7 shrink-0 items-center px-3 text-xs text-muted-foreground">
        {label}
      </div>
      <iframe
        key={src}
        src={src}
        title={label}
        sandbox={frame.getAttribute("sandbox") ?? ""}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}
