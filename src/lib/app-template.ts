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

/**
 * The launcher's icon, an Icon Composer icon: the instance's (instance/icon/AppIcon.icon), or
 * Nap's (brand/AppIcon.icon). It goes to ios/Launcher/Resources/AppIcon.icon. Its layers are SVG
 * or PNG; PNGs come in as data URLs and go out as base64.
 */
// Vite reads import.meta.glob options only when they are written in place.
const ICONS = {
  instance: {
    prefix: "/instance/icon/AppIcon.icon/",
    text: import.meta.glob("/instance/icon/AppIcon.icon/**/*.{json,svg}", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    images: import.meta.glob("/instance/icon/AppIcon.icon/**/*.{png,jpg,jpeg}", {
      query: "?inline",
      import: "default",
      eager: true,
    }),
  },
  brand: {
    prefix: "/brand/AppIcon.icon/",
    text: import.meta.glob("/brand/AppIcon.icon/**/*.{json,svg}", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    images: import.meta.glob("/brand/AppIcon.icon/**/*.{png,jpg,jpeg}", {
      query: "?inline",
      import: "default",
      eager: true,
    }),
  },
} as const;
const ICON_FOLDER = "ios/Launcher/Resources/AppIcon.icon/";
function iconFiles() {
  const { prefix, text, images } = Object.keys(ICONS.instance.text).length
    ? ICONS.instance
    : ICONS.brand;
  return [
    ...Object.entries(text as Record<string, string>).map(([path, content]) => ({
      path: ICON_FOLDER + path.slice(prefix.length),
      content,
      encoding: "utf8" as const,
      executable: false,
    })),
    ...Object.entries(images as Record<string, string>).map(([path, url]) => ({
      path: ICON_FOLDER + path.slice(prefix.length),
      content: url.slice(url.indexOf(",") + 1),
      encoding: "base64" as const,
      executable: false,
    })),
  ];
}

/**
 * The Swift clients of the instance's extensions (instance/extensions/<name>/client.swift), for
 * NapKit: what the web gets as nap.<name>, apps get from an extension on NapSite.
 */
const SWIFT_EXTENSIONS = import.meta.glob("/instance/extensions/*/client.swift", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const NAPKIT_FOLDER = "ios/NapKit/Sources/";
function swiftExtensionFiles() {
  return Object.entries(SWIFT_EXTENSIONS).map(([path, content]) => ({
    path: `${NAPKIT_FOLDER}Extensions/${path.split("/").at(-2)}.swift`,
    content,
    encoding: "utf8" as const,
    executable: false,
  }));
}

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
    .concat(platformOn("ios") ? [...iconFiles(), ...swiftExtensionFiles()] : [])
    .sort((a, b) => a.path.localeCompare(b.path));
}
