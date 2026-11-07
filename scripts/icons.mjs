#!/usr/bin/env node
/**
 * Renders an Icon Composer icon (AppIcon.icon) into the web icons Nap serves: favicons, the
 * Apple touch icon, the web manifest icons, and the app icon the dashboard shows.
 *
 *   node scripts/icons.mjs                       Nap's own icon: brand/AppIcon.icon → public/
 *   node scripts/icons.mjs <instance>/icon       an instance's: <dir>/AppIcon.icon → <dir>/web/
 *
 * macOS only: it uses ictool from Xcode's Icon Composer (set ICTOOL to use another one). The PNGs
 * are committed, because deploys build on Linux.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = process.argv[2];
const source = arg ? join(resolve(arg), "AppIcon.icon") : resolve("brand/AppIcon.icon");
const out = arg ? join(resolve(arg), "web") : resolve("public");
if (!existsSync(join(source, "icon.json"))) {
  console.error(`No Icon Composer icon at ${source}`);
  process.exit(1);
}

function ictool() {
  if (process.env.ICTOOL) return process.env.ICTOOL;
  const developer = execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
  const path = join(developer, "../Applications/Icon Composer.app/Contents/Executables/ictool");
  if (!existsSync(path)) {
    console.error("ictool not found: install Xcode 26 or later, or set ICTOOL.");
    process.exit(1);
  }
  return path;
}

const tool = ictool();
const scratch = join(tmpdir(), `nap-icons-${process.pid}`);
mkdirSync(scratch, { recursive: true });

/** The icon as iOS draws it (rounded, transparent corners), as PNG bytes. */
function render(size, rendition = "Default") {
  const file = join(scratch, `${rendition}-${size}.png`);
  execFileSync(tool, [
    source,
    "--export-image",
    "--output-file",
    file,
    "--platform",
    "iOS",
    "--rendition",
    rendition,
    "--width",
    String(size),
    "--height",
    String(size),
    "--scale",
    "1",
  ]);
  return readFileSync(file);
}

/** An .ico that holds PNGs, which every browser reads. */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map(({ data }) => data)]);
}

const dataUrl = (png) => `data:image/png;base64,${png.toString("base64")}`;

/** The light and the dark icon in one SVG, which follows the system appearance. */
function svg(light, dark, badge = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
<style>.dark{display:none}@media (prefers-color-scheme: dark){.light{display:none}.dark{display:inline}}</style>
<image class="light" width="128" height="128" href="${dataUrl(light)}"/>
<image class="dark" width="128" height="128" href="${dataUrl(dark)}"/>${badge}
</svg>
`;
}

mkdirSync(out, { recursive: true });
const light128 = render(128);
const dark128 = render(128, "Dark");
const files = {
  "favicon.svg": svg(light128, dark128),
  // Local dev: the same icon with a yellow dot, to tell the tabs apart.
  "favicon-dev.svg": svg(
    light128,
    dark128,
    `\n<circle cx="104" cy="104" r="22" fill="#f6c453" stroke="#111" stroke-width="6"/>`,
  ),
  "favicon.ico": ico([16, 32, 48].map((size) => ({ size, data: render(size) }))),
  "favicon-16x16.png": render(16),
  "favicon-32x32.png": render(32),
  "favicon.png": render(64),
  "apple-touch-icon.png": render(180),
  "android-chrome-192x192.png": render(192),
  "android-chrome-512x512.png": render(512),
  "app-icon.png": render(384),
  "app-icon-dark.png": render(384, "Dark"),
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);
rmSync(scratch, { recursive: true, force: true });
console.log(`Wrote ${Object.keys(files).length} icons to ${out}`);
