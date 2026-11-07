import { napConfig } from "~/nap.config";

/**
 * The starting point of an app's source repo: a folder per platform (ios/: a Tuist project with a
 * launcher and one app in it).
 * The files are in templates/app and bundled into the Worker. `node publish.mjs app init` writes
 * them, fills in the placeholders, and pushes the first commit.
 */
const files = import.meta.glob("/templates/app/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RENAMES: Record<string, string> = { gitignore: ".gitignore" };

/**
 * Binary files, such as the app icon, are kept as <name>.base64 and sent with encoding "base64":
 * the template is bundled as text.
 */
export function appTemplateFiles() {
  return Object.entries(files)
    .map(([path, content]) => {
      const relative = path.replace(/^\/templates\/app\//, "");
      if (relative.endsWith(".base64")) {
        return {
          path: relative.slice(0, -".base64".length),
          content: content.replace(/\s+/g, ""),
          encoding: "base64" as const,
          executable: false,
        };
      }
      return {
        path: RENAMES[relative] ?? relative,
        content: content.replaceAll("{{rootDomain}}", napConfig.rootDomain),
        encoding: "utf8" as const,
        executable: /(^|\/)scripts\//.test(relative),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
