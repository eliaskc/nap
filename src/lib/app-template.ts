import { napConfig } from "~/nap.config";

/** Platform folders, and the markers that keep text about one, by whether the Nap has it on. */
const platformOn = (platform: string) =>
  platform === "ios" ? Boolean(napConfig.apps?.ios) : Boolean(napConfig.apps?.remarkable);
const PLATFORM_FOLDERS = ["ios", "remarkable"];
/** Drops <!-- if <platform> -->…<!-- /if --> when the platform is off, and the markers. */
const showPlatforms = (text: string) =>
  text.includes("<!-- if ")
    ? text
        .replace(
          /<!-- if (\w+) -->\n*([\s\S]*?)<!-- \/if -->\n*/g,
          (_, platform: string, inner: string) => (platformOn(platform) ? inner : ""),
        )
        .replace(/\n{3,}/g, "\n\n")
    : text;

/**
 * The starting point of an app's source repo: a folder per platform (ios/: a Tuist project with a
 * launcher and one app in it; remarkable/: an AppLoad launcher with one app in it).
 * The files are in templates/app and bundled into the Worker. `node publish.mjs app init` writes
 * them, fills in the placeholders, and pushes the first commit.
 */
const files = import.meta.glob("/templates/app/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Files that cannot be in the template under their own name, in any folder. */
const RENAMES: Record<string, string> = { gitignore: ".gitignore" };
const rename = (path: string) =>
  path.replace(
    /(^|\/)([^/]+)$/,
    (_, slash: string, name: string) => slash + (RENAMES[name] ?? name),
  );

/**
 * Binary files, such as the app icon, are kept as <name>.base64 and sent with encoding "base64":
 * the template is bundled as text.
 */
export function appTemplateFiles() {
  return Object.entries(files)
    .filter(([path]) => {
      const folder = path.replace(/^\/templates\/app\//, "").split("/")[0]!;
      return !PLATFORM_FOLDERS.includes(folder) || platformOn(folder);
    })
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
        path: rename(relative),
        content: showPlatforms(content).replaceAll("{{rootDomain}}", napConfig.rootDomain),
        encoding: "utf8" as const,
        executable: /(^|\/)scripts\//.test(relative),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
