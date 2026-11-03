import { extensions } from "virtual:nap-extensions";
import type { ExtensionEntry } from "~/lib/extensions";

/** The deployment's extensions, bundled from instance/extensions (see nap.extension.ts). */
export const EXTENSIONS: ReadonlyArray<ExtensionEntry> = extensions;
