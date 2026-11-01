/**
 * Turns the welcome screen into pixels the transition can take apart.
 * 1. HTML-in-Canvas (Chrome with the flag): the browser paints a copy of the real DOM.
 * 2. Everywhere else: a small rasteriser redraws our own, known UI from its live layout
 *    (backgrounds, borders, text word by word, input values, avatars). Good enough for a screen
 *    we design ourselves, and it never taints the canvas, so WebGL can read it.
 */
import { SHAPE_PATHS, isShape } from "~/lib/looks";

export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: string,
  fill: string,
  letters: string,
  cx: number,
  cy: number,
  size: number,
  textColor = "#fff",
  font = "ui-sans-serif, system-ui, sans-serif",
) {
  if (!isShape(shape)) return;
  const { d, text } = SHAPE_PATHS[shape];
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = fill;
  ctx.fill(new Path2D(d));
  if (letters) {
    const [y, fontSize] = text;
    ctx.fillStyle = textColor;
    ctx.font = `700 ${letters.length > 1 ? fontSize : fontSize * 1.2}px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letters, 50, y);
  }
  ctx.restore();
}

export async function captureScreen(element: HTMLElement, dpr: number) {
  if (htmlInCanvasAvailable()) {
    try {
      const canvas = await viaHtmlInCanvas(element, dpr);
      if (canvas) return canvas;
    } catch (error) {
      console.warn("HTML-in-Canvas capture failed, redrawing instead", error);
    }
  }
  return rasterize(element, dpr);
}

function htmlInCanvasAvailable() {
  try {
    const ctx = document.createElement("canvas").getContext("2d") as unknown as {
      drawElementImage?: unknown;
    } | null;
    return typeof ctx?.drawElementImage === "function";
  } catch {
    return false;
  }
}

function viaHtmlInCanvas(element: HTMLElement, dpr: number): Promise<HTMLCanvasElement | null> {
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const host = document.createElement("canvas") as HTMLCanvasElement & { requestPaint?: () => void };
  host.setAttribute("layoutsubtree", "");
  host.setAttribute("content", "drawable");
  host.width = Math.round(width * dpr);
  host.height = Math.round(height * dpr);
  host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;opacity:0.001;pointer-events:none;z-index:-1`;
  const clone = element.cloneNode(true) as HTMLElement;
  const inputs = element.querySelectorAll("input");
  clone.querySelectorAll("input").forEach((input, i) => input.setAttribute("value", inputs[i]?.value ?? ""));
  // A clone replays entrance animations from frame 0; freeze everything as it is now.
  for (const node of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))]) {
    node.style.animation = "none";
    node.style.transition = "none";
  }
  clone.setAttribute("drawable", "");
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.inert = true;
  host.appendChild(clone);
  document.body.appendChild(host);
  const out = document.createElement("canvas");
  out.width = host.width;
  out.height = host.height;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      host.remove();
      resolve(ok ? out : null);
    };
    const ctx = host.getContext("2d") as unknown as CanvasRenderingContext2D & {
      drawElementImage: (el: Element, x: number, y: number, w: number, h: number) => void;
    };
    host.addEventListener("paint", () => {
      try {
        ctx.reset?.();
        ctx.drawElementImage(clone, 0, 0, host.width, host.height);
        out.getContext("2d")!.drawImage(host, 0, 0);
        finish(true);
      } catch (error) {
        console.warn(error);
        finish(false);
      }
    });
    host.requestPaint?.();
    setTimeout(() => finish(false), 400);
  });
}

const transparent = (color: string) =>
  !color || color === "transparent" || /rgba?\(.*,\s*0\)$/.test(color) || color.endsWith(" / 0)");

export function rasterize(root: HTMLElement, dpr: number): HTMLCanvasElement {
  const box = root.getBoundingClientRect();
  // Client rects include CSS transforms and zoom; layout sizes do not. Map one onto the other.
  const scale = box.width / (root.offsetWidth || box.width) || 1;
  const width = box.width / scale;
  const height = box.height / scale;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const background = getComputedStyle(root).backgroundColor;
  ctx.fillStyle = transparent(background) ? getComputedStyle(document.body).backgroundColor : background;
  ctx.fillRect(0, 0, width, height);
  const local = (rect: DOMRect) => ({
    x: (rect.left - box.left) / scale,
    y: (rect.top - box.top) / scale,
    w: rect.width / scale,
    h: rect.height / scale,
  });

  const opacityOf = (element: Element) => {
    let opacity = 1;
    for (let node: Element | null = element; node && node !== root.parentElement; node = node.parentElement) {
      opacity *= parseFloat(getComputedStyle(node).opacity || "1");
    }
    return opacity;
  };

  const drawText = (node: Text, style: CSSStyleDeclaration, opacity: number) => {
    if (!node.data.trim()) return;
    const range = document.createRange();
    const words: Array<{ word: string; rect: DOMRect }> = [];
    for (const match of node.data.matchAll(/\S+/g)) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rect = range.getClientRects()[0];
      if (rect) words.push({ word: match[0], rect });
    }
    if (!words.length) return;
    ctx.globalAlpha = opacity;
    ctx.fillStyle = style.color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const size = parseFloat(style.fontSize);
    const spacing = style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing) || 0;
    const setFont = (k: number) => {
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${size * k}px ${style.fontFamily}`;
      if ("letterSpacing" in ctx) (ctx as { letterSpacing: string }).letterSpacing = `${spacing * k}px`;
    };
    // Fit the font to the longest word's measured width, so canvas and layout agree.
    const longest = words.reduce((a, b) => (b.word.length > a.word.length ? b : a));
    setFont(1);
    const measured = ctx.measureText(longest.word).width;
    setFont(measured > 0 ? local(longest.rect).w / measured : 1);
    for (const { word, rect } of words) {
      const r = local(rect);
      ctx.fillText(word, r.x, r.y + r.h / 2);
    }
  };

  const visit = (element: Element) => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return;
    const opacity = opacityOf(element);
    if (opacity <= 0.01) return;
    const r = local(element.getBoundingClientRect());
    ctx.globalAlpha = opacity;

    const avatar = (element as HTMLElement).dataset?.rasterAvatar;
    if (avatar) {
      const [shape, fill, letters] = avatar.split("|");
      drawShape(ctx, shape, fill, letters, r.x + r.w / 2, r.y + r.h / 2, r.w, "#fff", style.fontFamily);
      return;
    }
    if (element instanceof SVGElement) return;

    if (!transparent(style.backgroundColor) && r.w && r.h) {
      ctx.fillStyle = style.backgroundColor;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, parseFloat(style.borderTopLeftRadius) || 0);
      ctx.fill();
    }
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      const s = style as unknown as Record<string, string>;
      const borderWidth = parseFloat(s[`border${side}Width`]);
      const borderColor = s[`border${side}Color`];
      if (!borderWidth || transparent(borderColor) || s[`border${side}Style`] === "none") continue;
      ctx.fillStyle = borderColor;
      if (side === "Top") ctx.fillRect(r.x, r.y, r.w, borderWidth);
      if (side === "Bottom") ctx.fillRect(r.x, r.y + r.h - borderWidth, r.w, borderWidth);
      if (side === "Left") ctx.fillRect(r.x, r.y, borderWidth, r.h);
      if (side === "Right") ctx.fillRect(r.x + r.w - borderWidth, r.y, borderWidth, r.h);
    }
    if (element instanceof HTMLInputElement) {
      ctx.fillStyle = style.color;
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const top = parseFloat(style.paddingTop);
      const bottom = parseFloat(style.paddingBottom);
      ctx.fillText(element.value, r.x + parseFloat(style.paddingLeft), r.y + top + (r.h - top - bottom) / 2);
      return;
    }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) drawText(child as Text, style, opacity);
      else if (child.nodeType === Node.ELEMENT_NODE) visit(child as Element);
    }
  };

  visit(root);
  return canvas;
}
