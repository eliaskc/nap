import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { DashboardActions, useActions } from "~/dashboard/actions";
import { TopBar } from "~/dashboard/chrome";
import { useDashboardData, useItemView, useStored } from "~/dashboard/data";
import { InstallProvider } from "~/dashboard/install";
import { VARIANT_IDS, VARIANTS, type Mode, type Variant } from "~/dashboard/variant-switch";
import { CanvasLayout } from "~/dashboard/variants/canvas";
import { HeadlineLayout } from "~/dashboard/variants/headline";
import { RingsLayout } from "~/dashboard/variants/rings";
import { StepsLayout } from "~/dashboard/variants/steps";
import type { BarOptions, VariantProps } from "~/dashboard/variants/types";
import { VendingLayout } from "~/dashboard/variants/vending";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

const LAYOUTS: Record<Variant, React.ComponentType<VariantProps>> = {
  headline: HeadlineLayout,
  steps: StepsLayout,
  rings: RingsLayout,
  canvas: CanvasLayout,
  vending: VendingLayout,
};

const isVariant = (value: unknown) => VARIANT_IDS.includes(value as Variant);

/**
 * The dashboard. Two modes, Tidy and Playful, each with its own layouts; everyone picks their own
 * in this browser. Every layout shows the same things and the same right-click menu.
 */
function Home() {
  const data = useDashboardData();
  return (
    <DashboardActions
      refresh={data.refresh}
      onSiteChange={(slug, change) =>
        data.setSites((sites) =>
          sites.map((site) => (site.slug === slug ? { ...site, ...change } : site)),
        )
      }
    >
      <InstallProvider>
        <Dashboard data={data} />
      </InstallProvider>
    </DashboardActions>
  );
}

function Dashboard({ data }: { data: ReturnType<typeof useDashboardData> }) {
  const view = useItemView(data.items);
  const [variant, setVariant] = useStored<Variant>("nap:layout", "headline", isVariant);
  // The last layout in each mode, so switching modes goes back to it.
  const [lastTidy, setLastTidy] = useStored<Variant>("nap:layout-tidy", "headline", isVariant);
  const [lastPlayful, setLastPlayful] = useStored<Variant>(
    "nap:layout-playful",
    "rings",
    isVariant,
  );

  const pick = React.useCallback(
    (next: Variant) => {
      setVariant(next);
      if (VARIANTS[next].mode === "tidy") setLastTidy(next);
      else setLastPlayful(next);
    },
    [setVariant, setLastTidy, setLastPlayful],
  );
  const changeMode = (mode: Mode) => pick(mode === "tidy" ? lastTidy : lastPlayful);

  const bar = (options: BarOptions = {}) => (
    <TopBar
      profile={data.profile}
      variant={variant}
      onModeChange={changeMode}
      onVariantChange={pick}
      {...options}
    />
  );

  const Layout = LAYOUTS[variant];
  return (
    <DropZone>
      <Layout view={view} items={data.items} loading={data.loading} bar={bar} />
    </DropZone>
  );
}

/** Files dropped anywhere publish a new private artifact. Items take drops for new versions. */
function DropZone({ children }: { children: React.ReactNode }) {
  const actions = useActions();
  const depth = React.useRef(0);
  const [active, setActive] = React.useState(false);
  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");
  return (
    <main
      className="nap-shell relative min-h-dvh bg-background text-foreground"
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setActive(true);
      }}
      onDragOver={(event) => hasFiles(event) && event.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        setActive(false);
        actions.drop(event.dataTransfer.files);
      }}
    >
      {children}
      <div
        className={cn(
          "pointer-events-none fixed inset-3 z-[60] grid place-items-center rounded-3xl border-2 border-dashed border-foreground/30 bg-background/60 opacity-0 backdrop-blur-sm transition-opacity",
          active && "opacity-100",
        )}
      >
        <div className="text-center">
          <p className="text-2xl font-semibold tracking-tight">Drop to publish</p>
          <p className="text-sm text-muted-foreground">
            It becomes a private artifact. Drop on one of yours to replace it.
          </p>
        </div>
      </div>
    </main>
  );
}
