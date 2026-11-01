import * as React from "react";
import { FilterBar, UploadError } from "~/dashboard/chrome";
import { FLOATING, GROUP } from "~/dashboard/controls";
import { ConnectCard } from "~/dashboard/connect";
import type { VariantProps } from "~/dashboard/variants/types";
import { cn } from "~/lib/utils";

/** Typing in a field, or holding a modifier, is not a shortcut. */
export function isShortcut(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable=true]")) return false;
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * The frame around a playful layout: the bar, the filters, the connect card, and a hint line
 * with the gestures. `h` hides everything but the bar.
 */
export function PlayfulShell({
  view,
  bar,
  hint,
  connect = "bottom-left",
  background,
  children,
}: Pick<VariantProps, "view" | "bar"> & {
  /** Only what you would not find on your own. */
  hint?: string;
  connect?: "bottom-left" | "bottom-right" | "none";
  background?: string;
  children: React.ReactNode;
}) {
  const [hidden, setHidden] = React.useState(false);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "h" && isShortcut(event)) setHidden((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background }}>
      {children}
      {bar({ className: "absolute inset-x-0 top-0" })}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-30 transition-opacity duration-300",
          hidden && "opacity-0 [&_*]:!pointer-events-none",
        )}
      >
        <div className="pointer-events-auto absolute top-[72px] left-4 flex sm:left-5 flex-col gap-2">
          <FilterBar view={view} compact floating />
          <UploadError />
        </div>
        {connect !== "none" && (
          <ConnectCard
            className={cn(
              "pointer-events-auto absolute bottom-4 sm:bottom-5",
              connect === "bottom-left" ? "left-4 sm:left-5" : "right-4 sm:right-5",
            )}
          />
        )}
        <p
          className={cn(
            GROUP,
            FLOATING,
            "absolute bottom-4 px-4 font-mono text-[11.5px] tracking-[0.01em] max-md:hidden sm:bottom-5",
            connect === "bottom-right" ? "left-4 sm:left-5" : "right-4 sm:right-5",
          )}
        >
          {hint && `${hint} · `}h hides the ui
        </p>
      </div>
    </div>
  );
}
