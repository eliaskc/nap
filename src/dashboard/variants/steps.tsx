import type * as React from "react";
import { PanelLeftIcon } from "lucide-react";
import { Group, GroupButton } from "~/dashboard/controls";
import { FilterBar, NapMark, UploadError } from "~/dashboard/chrome";
import { ExampleDots, ExampleText, PromptButtons, useExample } from "~/dashboard/connect";
import { useStored } from "~/dashboard/data";
import { PhoneInstallBanner, SidebarInstallCard } from "~/dashboard/install";
import { ItemCollection } from "~/dashboard/items";
import type { VariantProps } from "~/dashboard/variants/types";
import { cn } from "~/lib/utils";

/** Tidy: how it works on a dark sidebar you can fold away, and your things beside it. */
export function StepsLayout({ view, loading, bar }: VariantProps) {
  const [collapsed, setCollapsed] = useStored<boolean>(
    "nap:sidebar-collapsed",
    false,
    (value) => typeof value === "boolean",
  );
  const index = useExample();
  const toggle = (
    <GroupButton
      icon
      aria-label={collapsed ? "Show the sidebar" : "Hide the sidebar"}
      title={collapsed ? "Show the sidebar" : "Hide the sidebar"}
      onClick={() => setCollapsed(!collapsed)}
    >
      <PanelLeftIcon />
    </GroupButton>
  );

  return (
    <div className="flex min-h-dvh overflow-x-clip">
      {!collapsed && (
        // A dark panel in light and dark mode: `dark` switches the theme tokens inside it.
        <aside className="dark sticky top-0 flex h-dvh w-[min(560px,42vw)] shrink-0 flex-col gap-9 overflow-y-auto border-r bg-sidebar px-8 pb-10 text-sidebar-foreground max-md:hidden lg:px-12">
          {/* The same group as in the bar when the sidebar is folded, in the same place. */}
          <div className="-mx-3 flex h-15 shrink-0 items-center lg:-mx-7">
            <Group className="pl-1 text-foreground">
              {toggle}
              <NapMark className="pr-2" />
            </Group>
          </div>
          <h1 className="text-[2rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance">
            You describe it.
            <br />
            <span className="text-muted-foreground">Your agent builds and publishes it.</span>
          </h1>
          <Step number={1} title="Give your agent the instructions">
            <PromptButtons promptClassName="max-w-[min(380px,calc(42vw-8rem))]" />
          </Step>
          <Step number={2} title="Ask for anything, like">
            <ExampleText
              index={index}
              className="pt-1 text-[1.35rem] leading-[1.3] tracking-[-0.02em]"
              restClassName="text-foreground/75"
            >
              <ExampleDots index={index} className="mt-3.5 flex text-foreground" />
            </ExampleText>
          </Step>
          <Step number={3} title="It shows up here, ready to share" />
          <SidebarInstallCard />
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {bar({
          className: "sticky top-0",
          left: collapsed ? (
            <>
              {toggle}
              <NapMark className="pr-2" />
            </>
          ) : (
            <NapMark />
          ),
          // With the sidebar open, Nap is already on it.
          leftClassName: collapsed ? "pr-1 pl-1" : "md:hidden",
        })}
        <main
          className={cn(
            "flex w-full flex-col gap-5 px-4 pt-4 pb-16 sm:px-5",
            collapsed && "mx-auto max-w-4xl",
          )}
        >
          <PhoneInstallBanner />
          {collapsed || (
            <div className="md:hidden">
              <PromptButtons />
            </div>
          )}
          <FilterBar view={view} showLook />
          <UploadError />
          <ItemCollection view={view} loading={loading} columns={3} />
        </main>
      </div>
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[28px_1fr] gap-x-3.5 gap-y-3">
      <span className="grid size-[26px] place-items-center rounded-full border text-xs text-muted-foreground">
        {number}
      </span>
      <b className="self-center text-[15px] font-medium">{title}</b>
      {children && <div className="col-start-2">{children}</div>}
    </div>
  );
}
