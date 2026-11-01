import type { NapDocument } from "./api";

/** A failed Nap call. A 409 carries the current document (null if it is gone). */
export class NapError extends Error {
  override readonly name = "NapError";
  readonly status: number;
  declare readonly document?: NapDocument | null;

  constructor(message: string, status: number, document?: NapDocument | null) {
    super(message);
    this.status = status;
    // A 409 carries the current document (null if it is gone), so the app can merge or ask.
    if (document !== undefined) this.document = document;
  }
}

/** A NapError for anything thrown: NapErrors stay as they are. */
export function toNapError(error: unknown, status = 500) {
  if (error instanceof NapError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NapError(message, status);
}
