/**
 * A person's look on Nap: a shape and a colour, as stable keys. Each pair belongs to one person
 * on an instance (7 × 7 = 49 people), so two people never look the same. Nap owns what the keys
 * look like here; a nap with its own style may draw the same keys its own way, as long as it
 * keeps seven distinct shapes and seven distinct colours.
 *
 * No server or browser imports: the Worker, the dashboard, and /_nap/client.js all use this.
 */

export const SHAPES = ["circle", "triangle", "cloud", "pill", "drop", "clover", "diamond"] as const;
export const COLORS = ["red", "orange", "green", "violet", "pink", "brown", "blue"] as const;
export type Shape = (typeof SHAPES)[number];
export type Color = (typeof COLORS)[number];
export type Look = { shape: Shape; color: Color };

/** Fill colours, tuned to read on both a light and a dark background. Initials are white. */
export const COLOR_VALUES: Record<Color, string> = {
  red: "#e03131",
  orange: "#f76707",
  green: "#2b8a3e",
  violet: "#7048e8",
  pink: "#c2255c",
  brown: "#8d5a2b",
  blue: "#1c7ed6",
};

/** Each shape in a 100 × 100 box. `text` is where initials sit: [y, font size]. */
export const SHAPE_PATHS: Record<Shape, { d: string; text: [number, number] }> = {
  circle: { d: "M50 6A44 44 0 1 1 50 94A44 44 0 1 1 50 6Z", text: [51, 38] },
  triangle: {
    d: "M50 8C57 8 61 13 65 20L93 70C99 82 93 92 79 92H21C7 92 1 82 7 70L35 20C39 13 43 8 50 8Z",
    text: [66, 30],
  },
  cloud: {
    d: "M22 88A21 21 0 0 1 13 47A26 26 0 0 1 61 19A23 23 0 0 1 91 51A19 19 0 0 1 80 88Z",
    text: [60, 34],
  },
  pill: { d: "M30 20H70A30 30 0 0 1 70 80H30A30 30 0 0 1 30 20Z", text: [51, 36] },
  drop: { d: "M50 4C62 20 88 40 88 60A38 38 0 0 1 12 60C12 40 38 20 50 4Z", text: [62, 34] },
  clover: {
    d: "M26.1 26.1A24 24 0 1 1 73.9 26.1A24 24 0 1 1 73.9 73.9A24 24 0 1 1 26.1 73.9A24 24 0 1 1 26.1 26.1Z",
    text: [51, 36],
  },
  diamond: {
    d: "M50 4Q56 4 61 9L91 39Q96 44 96 50Q96 56 91 61L61 91Q56 96 50 96Q44 96 39 91L9 61Q4 56 4 50Q4 44 9 39L39 9Q44 4 50 4Z",
    text: [51, 32],
  },
};

export const isShape = (value: unknown): value is Shape =>
  typeof value === "string" && (SHAPES as ReadonlyArray<string>).includes(value);
export const isColor = (value: unknown): value is Color =>
  typeof value === "string" && (COLORS as ReadonlyArray<string>).includes(value);

function hash(text: string, seed: number) {
  let h = seed;
  for (const char of text.toLowerCase()) h = (Math.imul(h, 31) + char.charCodeAt(0)) >>> 0;
  return h;
}

/** The look an email gets when it is free. The same hash dle used, so people keep theirs. */
export function preferredLook(email: string): Look {
  return {
    shape: SHAPES[hash(email, 7) % SHAPES.length],
    color: COLORS[hash(email, 0) % COLORS.length],
  };
}

export const lookKey = (look: Look) => `${look.shape}/${look.color}`;

/** Every look, starting at `from` and stepping through colours, then shapes. */
export function looksFrom(from: Look): Array<Look> {
  const start = SHAPES.indexOf(from.shape) * COLORS.length + COLORS.indexOf(from.color);
  const all: Array<Look> = [];
  for (let i = 0; i < SHAPES.length * COLORS.length; i++) {
    const n = (start + i) % (SHAPES.length * COLORS.length);
    all.push({ shape: SHAPES[Math.floor(n / COLORS.length)], color: COLORS[n % COLORS.length] });
  }
  return all;
}

/** The first free look for this email, or its preferred one when all 49 are taken. */
export function firstFreeLook(email: string, taken: ReadonlySet<string>): Look {
  const preferred = preferredLook(email);
  return looksFrom(preferred).find((look) => !taken.has(lookKey(look))) ?? preferred;
}

export function initials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export const firstName = (name = "") => name.trim().split(/\s+/)[0] || name;

/** Someone without a look (a Nap without avatars): initials in a grey circle. */
export const PLAIN_FILL = "#868e96";

/**
 * The avatar as SVG markup: the shape in its colour with the initials inside, or the initials in
 * a grey circle for someone without a look.
 */
export function avatarSvg(look: Look | null, name: string, size: number, label = true) {
  const { d, text } = SHAPE_PATHS[look?.shape ?? "circle"];
  const fill = look ? COLOR_VALUES[look.color] : PLAIN_FILL;
  const [y, fontSize] = text;
  const letters = initials(name);
  const escaped = letters.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const title = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"` +
    ` role="img" aria-label="${title}" style="display:block;overflow:visible;flex:none">` +
    `<path d="${d}" fill="${fill}"/>` +
    (label
      ? `<text x="50" y="${y}" text-anchor="middle" dominant-baseline="central" fill="#fff"` +
        ` font-weight="700" font-size="${letters.length > 1 ? fontSize : fontSize * 1.2}"` +
        ` font-family="ui-sans-serif,system-ui,-apple-system,sans-serif">${escaped}</text>`
      : "") +
    `</svg>`
  );
}
