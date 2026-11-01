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

/** A control inside a group. Hover shows the same surface as a selected tab. */
const ITEM =
  "h-8 rounded-full border-transparent text-foreground/60 hover:bg-background hover:text-foreground aria-expanded:bg-background aria-expanded:text-foreground dark:text-muted-foreground dark:hover:bg-input/30 dark:hover:text-foreground dark:aria-expanded:bg-input/30";

export function Group({
  floating,
  className,
  ...props
}: React.ComponentProps<"div"> & { floating?: boolean }) {
  return <div className={cn(GROUP, floating && FLOATING, className)} {...props} />;
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
  className,
  listRef,
  label,
  children,
}: {
  value: Value;
  onValueChange: (value: Value) => void;
  floating?: boolean;
  className?: string;
  listRef?: React.Ref<HTMLDivElement>;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(next as Value)}>
      <TabsList
        ref={listRef}
        aria-label={label}
        className={cn(GROUP, "group-data-horizontal/tabs:h-10", floating && FLOATING, className)}
      >
        {children}
      </TabsList>
    </Tabs>
  );
}

export function GroupTab({
  icon,
  className,
  ...props
}: React.ComponentProps<typeof TabsTrigger> & { icon?: boolean }) {
  return (
    <TabsTrigger
      className={cn("rounded-full", icon ? "w-8 flex-none px-0" : "px-3", className)}
      {...props}
    />
  );
}
