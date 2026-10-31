import { buildIndex, locate, quoteSelection, type Quote, type TextIndex } from "./anchors";
import type { FrameState, FromBar, Rect } from "./protocol";

/**
 * The comments script inside an artifact. The artifact viewer adds it to every HTML page in the
 * sandboxed frame (artifact-viewer.ts). The frame has an opaque origin, so the Nap bar cannot read
 * the page; this script does the reading and tells the bar what it found:
 *
 * - where each comment's text is now (rectangles, in the frame's viewport),
 * - the selected text, when someone selects some,
 * - which comment is under the pointer, and clicks,
 * - whether the page looks dark.
 *
 * The bar sends back the quotes to look for and which one is open. This script never sees comment
 * text, authors, or the comment API. It draws highlights with the CSS Custom Highlight API and
 * does not change the page's DOM.
 */

const DRAFT = "__draft";
const HIGHLIGHT_CSS =
  "::highlight(nap-comment) { background-color: rgb(250 204 21 / 0.18); text-decoration: underline 2px rgb(234 179 8 / 0.75); text-underline-offset: 3px; }" +
  "::highlight(nap-comment-active) { background-color: rgb(250 204 21 / 0.4); text-decoration: underline 2px rgb(234 179 8); text-underline-offset: 3px; }";

const script = document.currentScript as HTMLScriptElement | null;
const viewerOrigin = script?.dataset.viewer ?? "";
const prefix = script?.dataset.prefix ?? "";

if (window.parent !== window && viewerOrigin) start();

function start() {
  let threads: Array<Quote & { id: string }> = [];
  let active: string | null = null;
  let draft: Quote | null = null;
  let index: TextIndex | null = null;
  let anchors = new Map<string, { range: Range; start: number }>();
  let selection: ReturnType<typeof quoteSelection> = null;
  let hovered: string | null = null;
  // Highlights cannot set a cursor. While a comment is under the pointer, this sheet makes it the
  // normal arrow instead of the text caret.
  let cursorSheet: CSSStyleSheet | null = null;
  let sendRequest = 0;
  let indexTimer = 0;

  const send = (message: unknown) => parent.postMessage(message, viewerOrigin);

  function path() {
    let value = location.pathname;
    if (value.startsWith(prefix)) value = value.slice(prefix.length) || "/";
    return value.replace(/index\.html?$/i, "");
  }

  function reanchor() {
    if (!document.body) return;
    index = buildIndex(document);
    anchors = new Map();
    for (const thread of draft ? [...threads, { id: DRAFT, ...draft }] : threads) {
      const found = locate(index, thread);
      if (found) anchors.set(thread.id, found);
    }
    paint();
    schedule();
  }

  function paint() {
    const registry = (window.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
    const HighlightClass = (window as { Highlight?: new (...ranges: Array<Range>) => unknown })
      .Highlight;
    if (!registry || !HighlightClass) return;
    const normal: Array<Range> = [];
    const strong: Array<Range> = [];
    anchors.forEach((anchor, id) => {
      (id === active || id === DRAFT ? strong : normal).push(anchor.range);
    });
    registry.set("nap-comment", new HighlightClass(...normal));
    registry.set("nap-comment-active", new HighlightClass(...strong));
  }

  /** Sends where everything is, once per frame at most. */
  function schedule() {
    cancelAnimationFrame(sendRequest);
    sendRequest = requestAnimationFrame(sendState);
  }

  function sendState() {
    cancelAnimationFrame(sendRequest);
    const state: FrameState = {
      type: "nap:comments:state",
      path: path(),
      dark: isDarkPage(),
      width: document.documentElement.clientWidth,
      anchors: [...anchors].map(([id, anchor]) => {
        const block = blockOf(anchor.range.startContainer);
        return {
          id,
          start: anchor.start,
          rects: Array.from(anchor.range.getClientRects(), rect),
          blockRight: block ? block.getBoundingClientRect().right : null,
        };
      }),
      selection: selection
        ? {
            quote: selection.quote,
            prefix: selection.prefix,
            suffix: selection.suffix,
            rects: Array.from(selection.range.getClientRects(), rect),
          }
        : null,
    };
    send(state);
  }

  function readSelection() {
    const range = selectedRange();
    selection = range ? quoteSelection(buildIndex(document), range) : null;
    schedule();
  }

  function hit(x: number, y: number) {
    let best: { id: string; length: number } | null = null;
    for (const thread of threads) {
      const anchor = anchors.get(thread.id);
      if (!anchor) continue;
      const inside = Array.from(anchor.range.getClientRects()).some(
        (box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
      );
      // Comments can overlap. The shortest one under the pointer is the one people mean.
      if (inside && (!best || thread.quote.length < best.length))
        best = { id: thread.id, length: thread.quote.length };
    }
    return best?.id ?? null;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== viewerOrigin) return;
    const data = event.data as FromBar;
    if (!data || typeof data !== "object") return;
    if (data.type === "nap:comments:threads") {
      threads = Array.isArray(data.threads) ? data.threads.filter(isQuote) : [];
      active = typeof data.active === "string" ? data.active : null;
      draft = data.draft && isQuote({ id: DRAFT, ...data.draft }) ? data.draft : null;
      reanchor();
    } else if (data.type === "nap:comments:clear-selection") {
      getSelection()?.removeAllRanges();
      selection = null;
      schedule();
    } else if (data.type === "nap:comments:scroll" && typeof data.id === "string") {
      anchors.get(data.id)?.range.startContainer.parentElement?.scrollIntoView({ block: "center" });
    }
  });

  let moveRequest = 0;
  document.addEventListener("mousemove", (event) => {
    cancelAnimationFrame(moveRequest);
    moveRequest = requestAnimationFrame(() => {
      const id = hit(event.clientX, event.clientY);
      if (id === hovered) return;
      hovered = id;
      cursorSheet?.replaceSync(id ? "* { cursor: default !important; }" : "");
      send({ type: "nap:comments:hover", id });
    });
  });
  document.addEventListener("click", (event) => {
    if (selectedRange()) return;
    send({ type: "nap:comments:click", id: hit(event.clientX, event.clientY) });
  });
  document.addEventListener("mouseup", () => setTimeout(readSelection));
  document.addEventListener("keyup", (event) => {
    if (event.shiftKey || event.key === "Shift") setTimeout(readSelection);
  });
  document.addEventListener("selectionchange", () => {
    if (selection && !selectedRange()) {
      selection = null;
      schedule();
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyM") {
      event.preventDefault();
      const range = selectedRange();
      selection = range ? quoteSelection(buildIndex(document), range) : null;
      sendState();
      send({ type: "nap:comments:shortcut" });
    }
  });
  addEventListener("scroll", schedule, true);
  addEventListener("resize", schedule);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);

  const ready = () => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(HIGHLIGHT_CSS);
      cursorSheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet, cursorSheet];
    } catch {
      // No constructable style sheets. No highlights.
    }
    new MutationObserver(() => {
      clearTimeout(indexTimer);
      indexTimer = window.setTimeout(reanchor, 300);
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    reanchor();
    send({ type: "nap:comments:ready", path: path() });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
}

function isQuote(value: unknown): value is Quote & { id: string } {
  const item = value as Record<string, unknown>;
  return (
    Boolean(item) &&
    typeof item.id === "string" &&
    typeof item.quote === "string" &&
    typeof item.prefix === "string" &&
    typeof item.suffix === "string"
  );
}

function rect(box: DOMRect): Rect {
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

function selectedRange() {
  const current = getSelection();
  if (!current || current.isCollapsed || !current.rangeCount) return null;
  if (!current.toString().trim()) return null;
  return current.getRangeAt(0);
}

/** The nearest element that is not inline, for placing pins in the margin. */
function blockOf(node: Node) {
  let element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (element) {
    const display = getComputedStyle(element).display;
    if (!display.startsWith("inline") && display !== "contents") return element;
    element = element.parentElement;
  }
  return null;
}

/** Whether the artifact looks dark: the first opaque background of <body> or <html>. */
function isDarkPage() {
  for (const element of [document.body, document.documentElement]) {
    if (!element) continue;
    const lightness = backgroundLightness(getComputedStyle(element).backgroundColor);
    if (lightness !== null) return lightness < 0.5;
  }
  // Nothing set: the frame shows white.
  return false;
}

/** 0 (black) to 1 (white), or null for a transparent or unknown color. */
function backgroundLightness(color: string) {
  const rgb = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const [r, g, b, a = 1] = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (a < 0.5) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  const lab = color.match(/^(?:ok)?l(?:ab|ch)\(\s*([\d.]+)(%?)[^/)]*(?:\/\s*([\d.]+)(%?))?\)$/);
  if (lab) {
    const alpha = lab[3] === undefined ? 1 : Number(lab[3]) / (lab[4] ? 100 : 1);
    if (alpha < 0.5) return null;
    const value = Number(lab[1]);
    return lab[2] || value > 1 ? value / 100 : value;
  }
  return null;
}
