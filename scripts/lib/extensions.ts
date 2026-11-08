import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** window.nap's own names, which extensions may not take. */
const RESERVED = new Set([
  "db",
  "channel",
  "voice",
  "fetch",
  "notify",
  "me",
  "people",
  "avatar",
  "looks",
  "NapError",
  "ext",
  "extensions",
]);

export type FoundExtension = {
  name: string;
  /** Absolute paths. client, types, and instructions are null when the extension has none. */
  server: string;
  client: string | null;
  types: string | null;
  instructions: string | null;
};

/**
 * The deployment's extensions, from instance/extensions/<name>/ (see nap.extension.ts). The
 * build reads them; a deployment without the folder has none.
 */
export function findExtensions(root = process.cwd()): Array<FoundExtension> {
  const dir = resolve(root, "instance/extensions");
  if (!existsSync(dir)) return [];
  const found: Array<FoundExtension> = [];
  for (const name of readdirSync(dir).sort()) {
    const folder = join(dir, name);
    if (name.startsWith(".") || !statSync(folder).isDirectory()) continue;
    if (!/^[a-z][a-z0-9]{0,31}$/.test(name)) {
      throw new Error(
        `Extension folder "${name}": names are lowercase letters and digits, starting with a letter`,
      );
    }
    if (RESERVED.has(name)) throw new Error(`Extension "${name}": nap.${name} is Nap's own`);
    const file = (path: string) => (existsSync(join(folder, path)) ? join(folder, path) : null);
    const server = file("server.ts");
    if (!server) throw new Error(`Extension "${name}" has no server.ts`);
    found.push({
      name,
      server,
      client: file("client.ts"),
      types: file("types.d.ts"),
      instructions: file("instructions.md"),
    });
  }
  return found;
}

/** Every file of the extensions, for the dev server to watch. */
export function extensionFiles(extensions: Array<FoundExtension>) {
  return extensions.flatMap((extension) =>
    [extension.server, extension.client, extension.types, extension.instructions].filter(
      (file): file is string => Boolean(file),
    ),
  );
}

/**
 * `virtual:nap-extensions` for the Worker: each extension's server module, types, and
 * instructions.
 */
export function serverModuleSource(extensions: Array<FoundExtension>) {
  const read = (file: string | null) =>
    file ? JSON.stringify(readFileSync(file, "utf8")) : "null";
  return [
    ...extensions.map(
      (extension, index) => `import server${index} from ${JSON.stringify(extension.server)};`,
    ),
    "export const extensions = [",
    ...extensions.map(
      (extension, index) =>
        `  { name: ${JSON.stringify(extension.name)}, server: server${index}, ` +
        `types: ${read(extension.types)}, instructions: ${read(extension.instructions)} },`,
    ),
    "];",
  ].join("\n");
}

/** `virtual:nap-extensions-client` for client.js: [name, factory] for each client.ts. */
export function clientModuleSource(extensions: Array<FoundExtension>) {
  const withClient = extensions.filter((extension) => extension.client);
  return [
    ...withClient.map(
      (extension, index) => `import client${index} from ${JSON.stringify(extension.client)};`,
    ),
    "export const extensions = [",
    ...withClient.map(
      (extension, index) => `  [${JSON.stringify(extension.name)}, client${index}],`,
    ),
    "];",
  ].join("\n");
}
