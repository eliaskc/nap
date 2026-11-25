/**
 * The slides shell: /_nap/slides.js. A deck is a page whose <body> holds one <section> per slide,
 * each drawn on a fixed 1920 × 1080 canvas, and loads this script. The script builds everything
 * around the slides, in the page: the column of slides, the stage, the speaker notes, presenting,
 * stepping through fragments, transitions between slides, links to a slide, and printing to PDF.
 * Nap serves it, so every deck gets the shell Nap has today, not the one it was published with.
 *
 * What a deck may use (the `slides` instructions topic is the contract):
 *   <section id="…">                 a slide. The id names it in links and keeps its notes.
 *   <aside>…</aside>                 in a slide: its speaker notes, to start with.
 *   class="fragment"                 revealed one step at a time while presenting
 *                                    (data-fragment-index orders them).
 *   data-transition="fade|none|magic" on a slide: how it leaves. With magic, elements that carry
 *                                    the same data-magic value on both slides move between them.
 *   data-island="name"               an element the deck's own script fills in. The shell leaves
 *                                    it alone.
 *
 * The slides stay in the page's own document, so the deck's styles and scripts apply to them. The
 * shell's own parts are in a shadow root, apart from the deck's styles. Plain TypeScript with no
 * dependencies: it runs in every deck.
 */

type Message =
  | { type: "nap:slides:go"; index: number }
  | { type: "nap:slides:present"; on: boolean };

type NotesCollection = {
  list(options: { limit: number }): Promise<{ documents: Array<{ id: string; data: unknown }> }>;
  put(id: string, data: { text: string }): Promise<unknown>;
};

const WIDTH = 1920;
const HEIGHT = 1080;
const THUMB_WIDTH = 168;
const NOTES_COLLECTION = "slide-notes";

/** Styles for the slides themselves, which live in the page's document. */
const PAGE_CSS = `
html, body { height: 100%; margin: 0; }
body { overflow: hidden; }
nap-deck { display: block; height: 100%; }
:where(section.nap-slide) { background: var(--bg, #fff); color: var(--value, #18181b); }
nap-deck section.nap-slide { position: absolute; inset: 0; width: ${WIDTH}px; height: ${HEIGHT}px; box-sizing: border-box; overflow: hidden; margin: 0; }
nap-deck > section.nap-slide { visibility: hidden; pointer-events: none; }
nap-deck > section.nap-slide[data-current], nap-deck > section.nap-slide[data-leaving] { visibility: visible; }
nap-deck > section.nap-slide[data-current] { pointer-events: auto; z-index: 1; }
nap-deck section.nap-slide > aside { display: none; }
nap-deck[data-present] > section.nap-slide .fragment { opacity: 0; transition: opacity 0.35s ease; }
nap-deck[data-present] > section.nap-slide .fragment.visible { opacity: 1; }
nap-deck [data-nap-thumb] { pointer-events: none; }
@media (prefers-reduced-motion: reduce) { nap-deck > section.nap-slide .fragment { transition: none !important; } }
@media print {
  @page { size: ${WIDTH}px ${HEIGHT}px; margin: 0; }
  html, body { height: auto; overflow: visible; }
  nap-deck { height: auto; }
  nap-deck > section.nap-slide { position: relative !important; visibility: visible !important; opacity: 1 !important; break-after: page; break-inside: avoid; }
  nap-deck > section.nap-slide .fragment { opacity: 1 !important; }
  nap-deck [data-nap-thumb] { display: none !important; }
}
`;

/** Styles for the shell's own parts, in its shadow root. Colours follow the deck's theme tokens. */
const SHELL_CSS = `
:host { color-scheme: light dark; --fg: var(--value, CanvasText); --ground: var(--bg, Canvas); --line: color-mix(in srgb, var(--fg) 13%, transparent); --quiet: color-mix(in srgb, var(--fg) 58%, transparent); --wash: color-mix(in srgb, var(--fg) 6%, transparent); --accent: var(--teal, #2563eb); font: 13px/1.4 var(--sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif); color: var(--fg); }
* { box-sizing: border-box; }
.shell { display: grid; grid-template-columns: ${THUMB_WIDTH + 56}px minmax(0, 1fr); height: 100%; background: var(--ground); }
.rail { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.count { flex: 1; color: var(--quiet); font-variant-numeric: tabular-nums; }
button { font: inherit; color: inherit; cursor: pointer; }
.head button { height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 7px; background: transparent; }
.head button:hover { background: var(--wash); }
.head button.primary { background: var(--fg); color: var(--ground); border-color: transparent; }
.head button.primary:hover { opacity: 0.88; background: var(--fg); }
.thumbs { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 10px 12px 16px; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.thumbs button { display: grid; grid-template-columns: 20px ${THUMB_WIDTH}px; gap: 8px; align-items: start; width: 100%; padding: 0; border: 0; background: none; text-align: left; }
.thumbs .n { padding-top: 2px; color: var(--quiet); font-size: 11.5px; font-variant-numeric: tabular-nums; text-align: right; }
.thumb { position: relative; width: ${THUMB_WIDTH}px; height: ${(THUMB_WIDTH * HEIGHT) / WIDTH}px; overflow: hidden; border-radius: 6px; outline: 1px solid var(--line); background: var(--ground); }
.thumbs button[aria-current="true"] .thumb { outline: 2px solid var(--accent); }
.thumbs button[aria-current="true"] .n { color: var(--fg); }
.thumbs button:focus-visible { outline: none; }
.thumbs button:focus-visible .thumb { outline: 2px solid var(--accent); outline-offset: 2px; }
.thumb-canvas { position: absolute; top: 0; left: 0; width: ${WIDTH}px; height: ${HEIGHT}px; transform-origin: 0 0; transform: scale(${THUMB_WIDTH / WIDTH}); }
.main { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
.stage { position: relative; min-height: 0; margin: 20px 24px; }
.frame { position: absolute; overflow: hidden; border-radius: 8px; outline: 1px solid var(--line); box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.06); }
.canvas { position: absolute; top: 0; left: 0; width: ${WIDTH}px; height: ${HEIGHT}px; transform-origin: 0 0; }
.notes { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 0 24px 16px; }
.notes-head { display: flex; justify-content: space-between; color: var(--quiet); font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; }
.notes-head .saved { letter-spacing: 0; text-transform: none; }
textarea { width: 100%; height: 84px; resize: vertical; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--wash); color: var(--fg); font: inherit; font-size: 13.5px; line-height: 1.5; }
textarea:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
:host([data-present]) .shell { grid-template-columns: minmax(0, 1fr); background: #000; }
:host([data-present]) .rail, :host([data-present]) .notes { display: none; }
:host([data-present]) .stage { margin: 0; cursor: none; }
:host([data-present]) .frame { border-radius: 0; outline: 0; box-shadow: none; }
@media (max-width: 720px) {
  .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  .rail { order: 2; border-right: 0; border-top: 1px solid var(--line); }
  .thumbs { flex-direction: row; overflow-x: auto; overflow-y: hidden; padding: 10px 12px; }
  .thumbs button { grid-template-columns: ${THUMB_WIDTH}px; width: auto; }
  .thumbs .n { display: none; }
  .stage { margin: 12px; }
  .notes { display: none; }
}
@media print {
  .shell { display: block; height: auto; }
  .rail, .notes { display: none; }
  .stage { margin: 0; }
  .frame { position: static; width: auto !important; height: auto !important; overflow: visible; border-radius: 0; outline: 0; box-shadow: none; }
  .canvas { position: static; width: auto; height: auto; transform: none !important; }
}
`;

function start(scriptSrc: string) {
  const slides = Array.from(document.body.querySelectorAll<HTMLElement>(":scope > section"));
  if (slides.length === 0) return;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  document.head.appendChild(
    Object.assign(document.createElement("style"), { textContent: PAGE_CSS }),
  );
  const host = document.createElement("nap-deck");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${SHELL_CSS}</style>
<div class="shell">
  <aside class="rail">
    <div class="head"><span class="count"></span><button type="button" class="pdf" title="Print, or save as PDF">PDF</button><button type="button" class="present primary" title="Present (F)">Present</button></div>
    <ol class="thumbs"></ol>
  </aside>
  <div class="main">
    <div class="stage"><div class="frame"><div class="canvas"><slot name="slide"></slot></div></div></div>
    <div class="notes"><div class="notes-head"><label for="nap-notes">Speaker notes</label><span class="saved"></span></div><textarea id="nap-notes" placeholder="Notes for this slide"></textarea></div>
  </div>
</div>`;
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const stage = $(".stage");
  const frame = $(".frame");
  const canvas = $(".canvas");
  const count = $(".count");
  const thumbs = $("ol.thumbs");
  const notes = $<HTMLTextAreaElement>("textarea");
  const saved = $(".saved");

  /** Each slide's name: its id, or its place when it has none. Notes and links go by it. */
  const names = slides.map((slide, i) =>
    /^[A-Za-z0-9_-]{1,64}$/.test(slide.id) ? slide.id : `slide-${i + 1}`,
  );
  const noteText = slides.map(
    (slide) => slide.querySelector(":scope > aside")?.textContent?.trim() ?? "",
  );
  const thumbButtons: Array<HTMLButtonElement> = [];
  const thumbHolders: Array<HTMLElement> = [];

  slides.forEach((slide, i) => {
    slide.classList.add("nap-slide");
    slide.slot = "slide";
    host.appendChild(slide);
    const item = document.createElement("li");
    item.innerHTML = `<button type="button"><span class="n">${i + 1}</span><span class="thumb"><span class="thumb-canvas"><slot name="thumb-${i}"></slot></span></span></button>`;
    const button = item.querySelector("button")!;
    button.setAttribute("aria-label", `Slide ${i + 1}`);
    button.addEventListener("click", () => go(i));
    thumbs.appendChild(item);
    thumbButtons.push(button);
    const holder = document.createElement("div");
    holder.slot = `thumb-${i}`;
    holder.setAttribute("data-nap-thumb", "");
    holder.inert = true;
    host.appendChild(holder);
    thumbHolders.push(holder);
  });
  document.body.appendChild(host);

  /** A still copy of a slide for the column: everything revealed, no ids, notes or scripts. */
  function drawThumb(i: number) {
    const copy = slides[i].cloneNode(true) as HTMLElement;
    copy.removeAttribute("slot");
    copy.removeAttribute("data-current");
    copy.removeAttribute("data-leaving");
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    copy.querySelectorAll(":scope > aside, script").forEach((element) => element.remove());
    copy.querySelectorAll(".fragment").forEach((element) => element.classList.add("visible"));
    copy.getAnimations?.({ subtree: true }).forEach((animation) => animation.cancel());
    thumbHolders[i].replaceChildren(copy);
  }
  // Islands and late scripts change a slide after it loads; its copy follows.
  const pending = new Set<number>();
  let drawTimer = 0;
  const redraw = (i: number) => {
    pending.add(i);
    clearTimeout(drawTimer);
    drawTimer = window.setTimeout(() => {
      pending.forEach(drawThumb);
      pending.clear();
    }, 300);
  };
  slides.forEach((slide, i) => {
    drawThumb(i);
    new MutationObserver(() => redraw(i)).observe(slide, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  /* ── fitting the canvas ── */
  let scale = 1;
  function fit() {
    const box = stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    scale = Math.min(box.width / WIDTH, box.height / HEIGHT);
    frame.style.width = `${WIDTH * scale}px`;
    frame.style.height = `${HEIGHT * scale}px`;
    frame.style.left = `${(box.width - WIDTH * scale) / 2}px`;
    frame.style.top = `${(box.height - HEIGHT * scale) / 2}px`;
    canvas.style.transform = `scale(${scale})`;
  }
  new ResizeObserver(fit).observe(stage);

  /* ── moving through the deck ── */
  let current = -1;
  let step = 0;
  let presenting = false;
  const fragmentsOf = (slide: HTMLElement) =>
    Array.from(slide.querySelectorAll<HTMLElement>(".fragment"))
      .map((element, order) => ({
        element,
        order,
        at: Number(element.dataset.fragmentIndex ?? Number.NaN),
      }))
      .sort(
        (a, b) =>
          (Number.isNaN(a.at) ? Infinity : a.at) - (Number.isNaN(b.at) ? Infinity : b.at) ||
          a.order - b.order,
      )
      .map((entry) => entry.element);
  function showFragments(slide: HTMLElement, upTo: number) {
    fragmentsOf(slide).forEach((element, i) => element.classList.toggle("visible", i < upTo));
  }

  /** How one slide gives way to the next: a fade, and with "magic", shared elements that move. */
  function transition(from: HTMLElement, to: HTMLElement, kind: string) {
    if (kind === "none" || reducedMotion.matches || !to.animate) return;
    const duration = kind === "magic" ? 520 : 280;
    const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
    from.setAttribute("data-leaving", "");
    const fade = to.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing });
    fade.finished.catch(() => {}).then(() => from.removeAttribute("data-leaving"));
    if (kind !== "magic") return;
    const before = new Map<string, HTMLElement>();
    from
      .querySelectorAll<HTMLElement>("[data-magic]")
      .forEach((element) => before.set(element.dataset.magic!, element));
    to.querySelectorAll<HTMLElement>("[data-magic]").forEach((element) => {
      const old = before.get(element.dataset.magic!);
      if (!old) return;
      const a = old.getBoundingClientRect();
      const b = element.getBoundingClientRect();
      if (!b.width || !b.height) return;
      const dx = (a.left - b.left) / scale;
      const dy = (a.top - b.top) / scale;
      element.animate(
        [
          {
            transformOrigin: "0 0",
            transform: `translate(${dx}px, ${dy}px) scale(${a.width / b.width}, ${a.height / b.height})`,
            opacity: 1,
          },
          { transformOrigin: "0 0", transform: "none", opacity: 1 },
        ],
        { duration, easing },
      );
      old.animate([{ opacity: 0 }, { opacity: 0 }], { duration });
    });
  }

  function go(index: number, options: { fragments?: "none" | "all"; animate?: boolean } = {}) {
    const next = Math.max(0, Math.min(slides.length - 1, index));
    const previous = current;
    if (next === previous) return;
    current = next;
    const slide = slides[next];
    const all = fragmentsOf(slide).length;
    step = presenting && options.fragments !== "all" ? 0 : all;
    showFragments(slide, step);
    slides.forEach((other, i) => other.toggleAttribute("data-current", i === next));
    if (previous >= 0 && options.animate !== false) {
      // The transition belongs to the slide that comes first of the two.
      const owner = slides[Math.min(previous, next)];
      transition(slides[previous], slide, owner.dataset.transition || "fade");
    }
    thumbButtons.forEach((button, i) => button.setAttribute("aria-current", String(i === next)));
    thumbButtons[next].scrollIntoView({ block: "nearest", inline: "nearest" });
    count.textContent = `${next + 1} / ${slides.length}`;
    notes.value = noteText[next];
    saved.textContent = "";
    const hash = `#slide-${next + 1}`;
    if (location.hash !== hash && previous >= 0) history.replaceState(null, "", hash);
    tellParent();
  }
  function forward() {
    const all = fragmentsOf(slides[current]).length;
    if (presenting && step < all) return showFragments(slides[current], ++step);
    go(current + 1);
  }
  function back() {
    if (presenting && step > 0) return showFragments(slides[current], --step);
    go(current - 1, { fragments: "all" });
  }

  /** #slide-7, or #<a slide's id>. */
  function fromHash() {
    const hash = decodeURIComponent(location.hash.slice(1));
    const numbered = /^slide-(\d+)$/.exec(hash);
    const index = numbered ? Number(numbered[1]) - 1 : names.indexOf(hash);
    return index >= 0 && index < slides.length ? index : null;
  }
  addEventListener("hashchange", () => {
    const index = fromHash();
    if (index !== null) go(index);
  });

  /* ── presenting ── */
  function present(on: boolean, fullscreen = true) {
    if (on === presenting) return;
    presenting = on;
    host.toggleAttribute("data-present", on);
    const slide = slides[current];
    step = on ? 0 : fragmentsOf(slide).length;
    showFragments(slide, step);
    if (fullscreen) {
      if (on) host.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    }
    requestAnimationFrame(fit);
    tellParent();
  }
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && presenting) present(false, false);
  });
  $(".present").addEventListener("click", () => present(true));
  $(".pdf").addEventListener("click", () => window.print());
  stage.addEventListener("click", (event) => {
    if (!presenting) return;
    const target = event.composedPath()[0];
    if (
      target instanceof Element &&
      target.closest("a, button, input, select, textarea, [data-island]")
    )
      return;
    forward();
  });

  addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.composedPath()[0];
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    )
      return;
    const keys: Record<string, () => void> = {
      ArrowRight: forward,
      ArrowDown: forward,
      PageDown: forward,
      " ": forward,
      Enter: forward,
      ArrowLeft: back,
      ArrowUp: back,
      PageUp: back,
      Backspace: back,
      Home: () => go(0),
      End: () => go(slides.length - 1),
      f: () => present(!presenting),
      p: () => present(!presenting),
      Escape: () => present(false),
    };
    const action = keys[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });

  /* ── speaker notes: the deck's <aside> to start with, then what people wrote, kept on Nap ── */
  let collection: NotesCollection | null = null;
  const saveTimers = new Map<number, number>();
  notes.addEventListener("input", () => {
    const index = current;
    noteText[index] = notes.value;
    saved.textContent = collection ? "Saving…" : "Not saved: open this deck on Nap to keep notes";
    if (!collection) return;
    clearTimeout(saveTimers.get(index));
    saveTimers.set(
      index,
      window.setTimeout(() => {
        collection!.put(names[index], { text: noteText[index] }).then(
          () => index === current && (saved.textContent = "Saved"),
          () => index === current && (saved.textContent = "Could not save"),
        );
      }, 600),
    );
  });
  function loadNotes() {
    const nap = (window as { nap?: { db?: { collection(name: string): NotesCollection } } }).nap;
    if (!nap?.db) return;
    const notesCollection = nap.db.collection(NOTES_COLLECTION);
    notesCollection.list({ limit: 200 }).then(
      ({ documents }) => {
        collection = notesCollection;
        for (const document of documents) {
          const index = names.indexOf(document.id);
          const text = (document.data as { text?: unknown } | null)?.text;
          if (index < 0 || typeof text !== "string") continue;
          noteText[index] = text;
          if (index === current && notes !== root.activeElement) notes.value = text;
        }
      },
      () => {},
    );
  }
  if ((window as { nap?: unknown }).nap) loadNotes();
  else if (/\/_nap\/slides\.js(\?|$)/.test(scriptSrc)) {
    const client = document.createElement("script");
    client.src = scriptSrc.replace(/\/_nap\/slides\.js.*$/, "/_nap/client.js");
    client.onload = loadNotes;
    document.head.appendChild(client);
  }

  /* ── the Nap bar: it shows the place in the deck and can start the show ── */
  function tellParent() {
    if (parent === window) return;
    // The numbers are no secret, and this script does not know Nap's origin.
    parent.postMessage(
      { type: "nap:slides", index: current, count: slides.length, presenting },
      "*",
    );
  }
  addEventListener("message", (event) => {
    if (event.source !== parent || parent === window) return;
    const data = event.data as Message | null;
    if (data?.type === "nap:slides:go" && Number.isInteger(data.index)) go(data.index);
    // Nap made the frame fill the screen itself, so only the layout changes here.
    if (data?.type === "nap:slides:present") present(Boolean(data.on), false);
  });

  fit();
  go(fromHash() ?? 0, { animate: false });
}

const loaded = window as { __napSlides?: boolean };
if (!loaded.__napSlides) {
  loaded.__napSlides = true;
  const scriptSrc = (document.currentScript as HTMLScriptElement | null)?.src ?? "";
  if (document.readyState === "loading")
    addEventListener("DOMContentLoaded", () => start(scriptSrc));
  else start(scriptSrc);
}

export {};
