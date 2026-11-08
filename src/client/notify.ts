import type { NapNotification } from "./api";
import { napJson } from "./paths";

/**
 * Sends a notification to everyone else who can see this page: their phones with the app, and
 * browsers with notifications on. Resolves with how many people it went to.
 */
/** Whether this Nap sends notifications: leave out what would call nap.notify when not. */
export async function canNotify() {
  const result = await napJson<{ enabled: boolean }>("notify").catch(() => ({ enabled: false }));
  return result.enabled;
}

export function notify(notification: NapNotification) {
  return napJson<{ sent: number }>("notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(notification),
  });
}
