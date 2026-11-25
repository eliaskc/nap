/**
 * A nap's type: how Nap shows and counts it, and which instructions the agent reads. The agent
 * writes the code for every type; Nap renders nothing from a spec.
 *
 * - page: anything. The default.
 * - dashboard: charts and numbers people look at again and again, sometimes left open on a wall
 *   screen. Repeat opens are not counted as visits (visits.ts).
 * - slides: a deck. Its page holds one <section> per slide and loads Nap's slides shell
 *   (src/slides, /_nap/slides.js), which shows and presents them.
 *
 * The type is a column, `sites.type`, never a flag per type.
 * Runs on the server and in the browser.
 */
export const NAP_TYPES = ["page", "dashboard", "slides"] as const;

export type NapType = (typeof NAP_TYPES)[number];

export const DEFAULT_NAP_TYPE: NapType = "page";

export function isNapType(value: unknown): value is NapType {
  return typeof value === "string" && (NAP_TYPES as ReadonlyArray<string>).includes(value);
}

/** The refusal for anything else, with the values Nap takes. */
export const NAP_TYPE_ERROR = `type must be ${NAP_TYPES.map((type) => `"${type}"`)
  .join(", ")
  .replace(/, ([^,]+)$/, " or $1")}`;

/**
 * A type from an agent or a form: undefined when none was sent (old clients), else the type, or
 * an error for anything Nap does not know.
 */
export function parseNapType(value: unknown): NapType | undefined | { error: string } {
  if (value === undefined || value === null || value === "") return undefined;
  const type = typeof value === "string" ? value.trim().toLowerCase() : value;
  return isNapType(type) ? type : { error: NAP_TYPE_ERROR };
}

/** Rows from before a type, or with a value this code does not know, are pages. */
export function napTypeOf(value: unknown): NapType {
  return isNapType(value) ? value : DEFAULT_NAP_TYPE;
}
