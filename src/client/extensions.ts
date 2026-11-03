import { extensions } from "virtual:nap-extensions-client";
import type { NapExtensionKit } from "../../nap.extension.ts";
import { NapError } from "./errors";
import { napPath } from "./paths";

/**
 * The deployment's extensions (nap.extension.ts): each client.ts gets a kit for its own
 * /_nap/ext/<name>/ endpoints and returns what pages get as nap.<name>.
 */
export function extensionApis(): Record<string, object> {
  const apis: Record<string, object> = {};
  for (const [name, client] of extensions) {
    const prefix = "ext/" + name + "/";
    const request = (path: string, init?: RequestInit) =>
      fetch(napPath(prefix + path.replace(/^\/+/, "")), init);
    const kit: NapExtensionKit = {
      request,
      async json<T>(path: string, init?: RequestInit) {
        const response = await request(path, init);
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new NapError(result.error || "nap." + name + " failed", response.status);
        }
        return result as T;
      },
      NapError,
    };
    try {
      apis[name] = Object.freeze(client(kit));
    } catch (error) {
      console.error("nap." + name + " did not load", error);
    }
  }
  return apis;
}
