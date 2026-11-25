# Slides on Nap

A deck is a nap of type `slides`: a page with one `<section>` per slide that loads Nap's slides shell. You write the slides; the shell does the rest, in the page: the column of slides, the stage, speaker notes, presenting, steps, transitions, links to a slide, and the PDF. Nap serves the shell, so a deck always gets today's.

Publish with `--type slides` (`type=slides` in the API and for drafts). Everything in the `sites` topic still applies.

## The deck

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Q3 review</title>
    <link rel="stylesheet" href="deck.css" />
    <script src="/_nap/slides.js" defer></script>
  </head>
  <body>
    <section class="slide" id="intro">
      <h1>Q3 in one line</h1>
      <aside>Speaker notes for this slide.</aside>
    </section>
    <section class="slide" id="numbers">
      <h2>Signups grew 8 %</h2>
      <p class="fragment">Mostly from Android.</p>
      <div data-island="signups"></div>
    </section>
  </body>
</html>
```

- **A slide is a `<section>` directly in `<body>`**, drawn on a fixed canvas of 1920 × 1080 px that the shell scales to fit. Lay slides out in px of that canvas; do not make them responsive. What does not fit is cut off, so keep to the canvas.
- **Give each slide an `id`** (letters, numbers, `-`, `_`). Its notes are kept by it, so an id that stays the same keeps its notes when slides move. Without one, a slide goes by its place.
- **Style slides by class**, never by id or by where they sit (`body > section`): the shell moves the sections into its own element and draws copies of them for the column.
- **Slides are plain HTML and CSS.** A slide must look finished at rest: the column and the PDF show it without its motion.
- **Notes**: an `<aside>` directly in a slide is its speaker notes to start with. People edit notes in Nap, and Nap keeps what they write (in the nap's collection `slide-notes`), so a new version does not overwrite it.
- **Steps**: `class="fragment"` on an element shows it one step at a time while presenting, in document order (`data-fragment-index` to change it). Outside the show and in the PDF everything shows.
- **Transitions**: `data-transition="fade"` (the default), `"none"`, or `"magic"` on a slide says how it gives way to the next one. With `magic`, an element with the same `data-magic="name"` on both slides moves and resizes from one to the other: use it to carry a headline, a number, or a picture across.
- **Links**: `#slide-7` or `#<a slide's id>` at the end of the nap's URL opens that slide.
- The Nap bar shows the place in the deck and a Present button. Keys: arrows, space, and Page Up/Down move; `F` starts and ends the show; Home and End jump. The shell's PDF button prints one slide a page.
- Do not write your own navigation, scaling, or slide counter, and load nothing else that takes over the keyboard.

## Islands: the parts drawn by code

Most of a slide is plain HTML. A part that needs code, such as a chart from live data or something that animates, is an island: an element with `data-island="<name>"` that the deck's own script fills in. The shell leaves islands alone.

- An island runs in the page like any nap's code: it can use `window.nap`, this Nap's extensions, a chart library, React.
- Keep islands to what needs them. A number that does not change is text, not an island.
- It should look finished at rest too. The column draws a still copy of it; what is drawn on a `<canvas>` is blank there.
- A chart in a deck shows what was true when it was presented unless it loads live. Say which on the slide: "as of 12 May", or "live".

## With the kit

The kit has a deck to start from (`kit` topic, Slides): `slides.html` with example slides, `src/slides/deck.css` with slide layouts on this Nap's theme tokens, and `src/slides/main.tsx`, where islands are React components that can use every kit part.

    node /tmp/nap-publish.mjs kit <dir> && cd <dir> && pnpm install
    pnpm build:slides                                   # → dist-slides/index.html
    node /tmp/nap-publish.mjs dist-slides --type slides --title "Q3 review"

A deck built from the kit's tokens switches theme like any page (`design` topic, Themes). Without the kit, a deck is the HTML above with your own CSS; nothing else is needed.

## A good deck

- One point a slide, said in its headline as a sentence: "Signups grew 8 %", not "Signups".
- Few words, large. The room listens to the speaker; what they would say goes in the notes.
- One chart a slide, with the value that matters labelled on it. There is no hover in a show.
- Write notes for every slide that needs them: what to say, not what is on it.
