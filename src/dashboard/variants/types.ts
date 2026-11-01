import type * as React from "react";
import type { Item, ItemView } from "~/dashboard/data";

export type BarOptions = {
  left?: React.ReactNode;
  leftClassName?: string;
  className?: string;
};

/** What every layout gets. `bar` renders the shared top bar wherever the layout wants it. */
export type VariantProps = {
  view: ItemView;
  items: Array<Item>;
  loading: boolean;
  bar: (options?: BarOptions) => React.ReactNode;
};
