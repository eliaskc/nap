import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { withInstanceText } from "./instance-text.ts";

/**
 * The kit: the project agents start a page from (kit/), as this deployment serves it. An
 * instance changes it without changing Nap:
 *
 *   instance/kit/<path>            replaces or adds the file at kit/<path>. Themes go in
 *                                  src/theme/instance.css and theme.json, their fonts in
 *                                  src/assets/fonts/, and components of its own anywhere in src/.
 *   instance/instructions/kit.md   is added to the end of KIT.md, below "On this Nap": what the
 *                                  instance's themes and components are.
 *   instance/instructions/<topic>.md
 *                                  is added to the end of that instructions topic the same way,
 *                                  or is a topic of its own when Nap has none by that name. Its
 *                                  first heading is its line in the index.
 *
 * The build reads all of it into `virtual:nap-instance-content`.
 */

export type KitFile = { path: string; content: string; encoding: "utf8" | "base64" };

/** Folders that are not part of the kit: what installing and building it leaves behind. */
const SKIPPED = new Set(["node_modules", "dist", "dist-kitchen", ".DS_Store"]);
const BINARY = new Set([
  ".woff2",
  ".woff",
  ".ttf",
  ".otf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
]);
/** Files that cannot be in the repository under their own name. */
const RENAMES: Record<string, string> = { gitignore: ".gitignore" };

/** Every file below a folder, as paths relative to it, sorted. */
function walk(root: string, folder = ""): Array<string> {
  if (!existsSync(join(root, folder))) return [];
  const found: Array<string> = [];
  for (const name of readdirSync(join(root, folder)).sort()) {
    if (SKIPPED.has(name)) continue;
    const path = folder ? `${folder}/${name}` : name;
    if (statSync(join(root, path)).isDirectory()) found.push(...walk(root, path));
    else found.push(path);
  }
  return found;
}

/** The folders the kit and the instance's additions are read from. */
export function kitSources(root = process.cwd()) {
  return {
    kit: resolve(root, "kit"),
    overlay: resolve(root, "instance/kit"),
    instructions: resolve(root, "instance/instructions"),
  };
}

/** Every file the kit is built from, for the dev server to watch. */
export function kitWatchFiles(root = process.cwd()) {
  const sources = kitSources(root);
  return Object.values(sources).flatMap((folder) => walk(folder).map((path) => join(folder, path)));
}

/** instance/instructions/<topic>.md, by topic. */
export function instanceInstructions(root = process.cwd()): Record<string, string> {
  const { instructions } = kitSources(root);
  const topics: Record<string, string> = {};
  for (const path of walk(instructions)) {
    const topic = /^([a-z]+)\.md$/.exec(path)?.[1];
    if (!topic) {
      throw new Error(`instance/instructions/${path}: topics are <name>.md, in lowercase letters`);
    }
    topics[topic] = readFileSync(join(instructions, path), "utf8");
  }
  return topics;
}

/** The kit's files with the instance's over them, and KIT.md with the instance's kit.md. */
export function kitFiles(root = process.cwd()): Array<KitFile> {
  const { kit, overlay } = kitSources(root);
  const files = new Map<string, string>();
  for (const path of walk(kit)) files.set(path, join(kit, path));
  for (const path of walk(overlay)) files.set(path, join(overlay, path));
  const added = instanceInstructions(root).kit;
  return [...files]
    .map(([path, file]): KitFile => {
      const name = path.replace(
        /(^|\/)([^/]+)$/,
        (_, slash: string, base: string) => slash + (RENAMES[base] ?? base),
      );
      if (BINARY.has(extname(path).toLowerCase())) {
        return { path: name, content: readFileSync(file, "base64"), encoding: "base64" };
      }
      const text = readFileSync(file, "utf8");
      return {
        path: name,
        content: path === "KIT.md" ? withInstanceText(text, added) : text,
        encoding: "utf8",
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** `virtual:nap-instance-content` for the Worker. */
export function instanceContentModuleSource(root = process.cwd()) {
  // kit.md is already in the kit's KIT.md, which is the kit topic.
  const { kit: _kit, ...instructions } = instanceInstructions(root);
  return [
    `export const kitFiles = ${JSON.stringify(kitFiles(root))};`,
    `export const instructions = ${JSON.stringify(instructions)};`,
  ].join("\n");
}
