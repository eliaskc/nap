import { extensions, groups } from "virtual:nap-extensions";
import type { NapGroups } from "../../nap.extension.ts";
import type { ExtensionEntry } from "~/lib/extensions";

/** The deployment's extensions, bundled from instance/extensions (see nap.extension.ts). */
export const EXTENSIONS: ReadonlyArray<ExtensionEntry> = extensions;

/** The deployment's groups, which extensions hear of (instance/extensions/groups.ts). */
export const GROUPS: NapGroups = groups;
