import { napConfig } from "~/nap.config";

/**
 * The starting point of an app's source repo: a Tuist project with a launcher and one prototype.
 * The files are in templates/app and bundled into the Worker. `node publish.mjs app init` writes
 * them, fills in the placeholders, and pushes the first commit.
 */
const files = import.meta.glob("/templates/app/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RENAMES: Record<string, string> = { gitignore: ".gitignore" };

export function appTemplateFiles() {
  return Object.entries(files)
    .map(([path, content]) => {
      const relative = path.replace(/^\/templates\/app\//, "");
      return {
        path: RENAMES[relative] ?? relative,
        content: content.replaceAll("{{rootDomain}}", napConfig.rootDomain),
        executable: relative.startsWith("scripts/"),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
