import { motion } from "motion/react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { cn } from "~/lib/utils";

/**
 * Every row of controls on the dashboard is a group: a fully rounded, muted pill, 40px tall, with
 * the controls inside it as smaller pills. Tabs, buttons, and menus share it, so the bar, the
 * filters, and the playful overlays all look the same.
 */
export const GROUP =
  "inline-flex h-10 shrink-0 items-center gap-0.5 rounded-full bg-muted p-1 text-muted-foreground";

/** Added to a group that floats over the page, with nothing behind it. */
export const FLOATING = "pointer-events-auto shadow-sm ring-1 ring-foreground/10";

/**
 * A flat group: the same shape and spacing, but no surface of its own. Its controls show the
 * muted surface instead, on hover and when selected.
 */
const FLAT = "bg-transparent shadow-none ring-0";

/** A control inside a group. Hover shows the same surface as a selected tab. */
const ITEM =
  "h-8 rounded-full border-transparent text-foreground/60 hover:bg-background hover:text-foreground aria-expanded:bg-background aria-expanded:text-foreground dark:text-muted-foreground dark:hover:bg-input/30 dark:hover:text-foreground dark:aria-expanded:bg-input/30 in-data-flat:hover:bg-muted in-data-flat:aria-expanded:bg-muted";

/**
 * A tab draws no surface of its own when selected; the pill behind it does. `isolate` lets the pill
 * sit behind the label but in front of the group.
 */
const TAB =
  "isolate rounded-full data-active:border-transparent data-active:bg-transparent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent";

/** The selected tab's surface. In a flat group it's the muted surface, with no shadow. */
const PILL =
  "absolute inset-0 -z-10 rounded-full bg-background shadow-sm dark:border dark:border-input dark:bg-input/30 in-data-flat:bg-muted in-data-flat:shadow-none dark:in-data-flat:border-transparent dark:in-data-flat:bg-muted";

/**
 * The value selected in the surrounding GroupTabs, so its tab can show the pill, and the pill's
 * layout id, unique to the group so pills only slide within their own tabs.
 */
const SelectedContext = React.createContext<{ value?: string; pill?: string }>({});

export function Group({
  floating,
  flat,
  className,
  ...props
}: React.ComponentProps<"div"> & { floating?: boolean; flat?: boolean }) {
  return (
    <div
      data-flat={flat || undefined}
      className={cn(GROUP, floating && FLOATING, flat && FLAT, className)}
      {...props}
    />
  );
}

/** A button inside a group. `icon` makes it round. */
export function GroupButton({
  icon,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { icon?: boolean }) {
  return (
    <Button
      variant="ghost"
      size={icon ? "icon" : "default"}
      className={cn(ITEM, !icon && "px-3", className)}
      {...props}
    />
  );
}

/** Tabs as a group: one of a few options. */
export function GroupTabs<Value extends string>({
  value,
  onValueChange,
  floating,
  flat,
  className,
  listRef,
  label,
  children,
}: {
  value: Value;
  onValueChange: (value: Value) => void;
  floating?: boolean;
  flat?: boolean;
  className?: string;
  listRef?: React.Ref<HTMLDivElement>;
  label?: string;
  children: React.ReactNode;
}) {
  const pill = `pill-${React.useId()}`;
  const selected = React.useMemo(() => ({ value, pill }), [value, pill]);
  return (
    <SelectedContext value={selected}>
      <Tabs value={value} onValueChange={(next) => onValueChange(next as Value)}>
        <TabsList
          ref={listRef}
          aria-label={label}
          data-flat={flat || undefined}
          className={cn(
            GROUP,
            "group-data-horizontal/tabs:h-10",
            floating && FLOATING,
            flat && FLAT,
            className,
          )}
        >
          {children}
        </TabsList>
      </Tabs>
    </SelectedContext>
  );
}

export function GroupTab({
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<typeof TabsTrigger> & { icon?: boolean }) {
  const group = React.use(SelectedContext);
  return (
    <TabsTrigger className={cn(TAB, icon ? "w-8 flex-none px-0" : "px-3", className)} {...props}>
      {/* One pill per group: Motion slides it from the old tab to the new one. */}
      {group.value === props.value && (
        <motion.span
          layoutId={group.pill}
          className={PILL}
          transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
        />
      )}
      {children}
    </TabsTrigger>
  );
}
