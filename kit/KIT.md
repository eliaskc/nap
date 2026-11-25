# Nap kit

A Vite + React + TypeScript + Tailwind v4 project with shadcn/ui (Base UI) and a set of
components for pages on Nap. You fetch it from your Nap, write `src/App.tsx`, and build one
self-contained `dist/index.html`. The components give you building blocks; how you arrange them is
up to you. Each Nap serves the kit with its own themes and may add components; what this page
says after "On this Nap" is that Nap's own.

Use the kit for pages that are mostly content: reports, write-ups, explainers, dashboards, and
decks of slides. A page
that is a single canvas or a game, or anything without Node, is fine as plain HTML. You can also
skip the kit, or take only its theme.

## Start and build

```sh
node /tmp/nap-publish.mjs kit <dir> && cd <dir>   # this Nap's kit, into a new folder
pnpm install            # or: npm install
pnpm dev                # http://localhost:5173 ; the kitchen sink is at /?kitchen
pnpm build              # → dist/index.html, everything inline (JS, CSS, fonts, images)
node scripts/shot.mjs out.png 1400 dark full   # screenshot dist/index.html; 390 for phone, light|dark
```

- Set `<title>` in `index.html` to the page's name. Nap names a published page after it, read
  from the HTML file (setting `document.title` from React does not count). `pnpm build` fails
  while it is still the placeholder.
- Write the page in `src/App.tsx` (it starts as a stub). Put images in `src/assets/` and `import` them;
  they are inlined.
- `pnpm build` type-checks first (`tsc -b`), then bundles. A type error stops the build.
- `src/examples/KitchenSink.tsx` renders every component with sample content. It is a good place
  to copy usage from; it is not part of a normal build (`pnpm build:kitchen` builds it separately).
- The page runs in an iframe under the Nap bar. Light/dark follows the system through the script
  in `index.html`; there is no toggle. Every link that leaves the page opens in a new tab
  (`KitRoot` in `main.tsx` does this), so plain `<a href>` is fine. Don't use `window.top`, and
  don't size anything with `vh`: the iframe can be any height.
- `dist/index.html` sizes: about 360 kB for the stub page (React ≈200 kB, CSS ≈115 kB), plus a
  theme's fonts. Motion (`Segmented`, `StageSwitcher`) adds ≈140 kB, charts ≈380 kB, `Code`
  ≈470 kB, `Diff` ≈830 kB. The kitchen sink with everything is 2.6 MB.

## Imports

```tsx
import { Page, Section, Flow, Stat /* … */ } from '@/kit'      // everything light
import { BarChart, LineChart, Histogram } from '@/kit/charts'    // Recharts
import { Code, Diff } from '@/kit/code'                          // WASM highlighter
import { Dashboard, Panel, Metric, useDataset } from '@/kit/dashboard'  // dashboards
import { mountIslands } from '@/kit/slides'                       // islands in a deck
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/kit/ui/tabs'  // shadcn/ui
```

Unused components are tree-shaken. shadcn/ui primitives live in `src/kit/ui/`: tabs, collapsible,
tooltip, popover, dialog, sheet, toggle-group, toggle, switch, slider, select, badge, separator,
scroll-area, button, chart. Add more with `pnpm dlx shadcn@latest add <name>` (they land in
`src/kit/ui`). Icons: `lucide-react`.
Base UI's `Select` shows the raw value in the trigger unless you pass `items` (value → label),
for example `<Select items={{ eu: 'europe-north1' }}>`. Wrap the items in `SelectGroup` as the shadcn
examples do; its padding is what lines the open list up with the trigger.

Every component's full props are typed and commented in `src/kit/*.tsx`. Read the source for
anything not covered here.

## Theme

All colour and type goes through CSS variables (tokens), so everything works in light and dark
and in every theme. Use the Tailwind classes, or the variables directly in SVG and inline styles.
Never hard-code hex.

- `src/theme/tokens.css` is the neutral theme and the full list of tokens. `src/theme/instance.css`
  holds this Nap's themes, each a block of token values for `:root[data-theme="<id>"]`, and
  `theme.json` lists them and names the default.
- A page built with more than one theme can switch: the build lists the themes in
  `<meta name="nap-themes">`, Nap offers the choice in its bar, and each viewer sees the theme
  they picked (the page's default until they do). So check the page in every theme: `/?theme=<id>`
  in dev, and `THEME=<id> node scripts/shot.mjs …` for a screenshot.
- A page with its own colours, art, or anything that does not come from the tokens should not
  switch. Give `theme.json` only the theme you designed for, and the build leaves the meta tag out.
- For a one-off look, add a theme to `instance.css` and `theme.json` rather than editing
  components.

| Role | Tailwind | CSS |
| --- | --- | --- |
| Page ground | `bg-bg` | `var(--bg)` |
| Raised opaque surface (nodes, popovers) | `bg-paper` | `var(--paper)` |
| Diagram frame ground | `bg-frame` | `var(--frame)` |
| Sheer fill (3–4 % ink) / stronger | `bg-sheer` `bg-sheer-2` | `rgb(var(--ink) / var(--sheer-a))` |
| Hairline / stronger | `border-line` `border-line-strong` | `rgb(var(--ink) / var(--line-a))` |
| Text: numbers & titles → faintest | `text-value` `text-strong` `text-body` `text-quiet` `text-faint` | `var(--value)`, `rgb(var(--ink) / .85 .76 .56 .38)` |
| Accents (sparingly, with meaning) | `text-teal` `text-peach` `text-orange` `text-cream` (also `bg-`, `border-`) | `var(--teal)` … |
| Status (not accents) | `text-good` `text-warn` `text-bad` | `var(--good)` … |
| Chart series 1–6 | `bg-chart-1` … | `var(--chart-1)` … |
| Code | — | `var(--code-keyword)`, `--code-string`, `--code-fn`, … |

- Opacity modifiers work on all of them: `bg-teal/10`, `border-peach/40`.
- `--ink` is an RGB triplet, so `rgb(var(--ink) / 0.2)` gives any ink opacity.
- Components take a `tone` prop: `'neutral' | 'teal' | 'peach' | 'orange' | 'cream' | 'good' | 'warn' | 'bad'`.
  `toneColor(tone)` and `toneMix(tone, pct)` from `@/kit` turn it into CSS colours.
- Type: the theme's `--sans` and `--mono` (`font-sans`, `font-mono`); the neutral theme uses the
  system's. Headings are Regular (`font-normal`) with slightly tight tracking; keep them modest in size so
  the hierarchy comes from size steps and spacing, not from huge type. Light is only for big
  numbers (`Stat`). Labels are Medium.
- The accent names are slots, not promises about colour: `teal` is the primary accent, `peach`
  the secondary, `orange` the strong one, `cream` the quiet one. A theme decides what they look like.
- `Page` can add big soft radial lights behind the page (`--glow-top`, `--glow-a`, `--glow-b`);
  themes without a glow leave them transparent. Change colours through the tokens only.
- Utilities: `eyebrow` (uppercase tracked label), `tnum` (tabular numbers), `hatch` (diagonal
  lines for n/a or planned), `kit-scroll` (sideways scroll box), `kit-prose` (= `<Prose>`),
  `press` (slight scale while pressed, for your own compact buttons; it carries the colour
  transitions too, so don't add `transition-*` next to it) and `press-row` (a tint for full-width rows).
- Scrollbars are styled everywhere (page, diagrams, menus): no track and a slim rounded thumb in
  ink that darkens on hover, in both modes. Hide one with `no-scrollbar`; don't restyle them per element.
- Radii: boxes 12 px, cards 14–20 px, pills full. Motion: `ease` from `@/kit` (`[0.22, 1, 0.36, 1]`),
  also the default curve of every Tailwind `transition-*` class (`ease-out-soft`).

## Page

**`Page`**: the shell: faint background glow, a readable column, and a sticky side index on
desktop built from the `Section`s inside it. Direct children flow in a 680 px text column;
diagrams, charts and `Wide` span the full width; `MarginNote`s float into the right margin.
Props: `indexTitle`, `indexFooter`, `index` (default true), `glow`.

```tsx
<Page indexTitle="Storage memo">…</Page>
```

**`Section`**: a titled part; registers itself in the index. Props: `title`, `eyebrow`, `lede`,
`level` (2 or 3), `index` (label, or `false`), `id`.

```tsx
<Section eyebrow="The plan" title="Three tracks" lede="A and B run in parallel.">…</Section>
```

**`Title`**: the page `h1` with optional `eyebrow`; `size="md"` for a smaller one.
**`Lede`**: larger intro paragraph; `<strong>` goes to full brightness.
**`Eyebrow`**: uppercase tracked label; `tone`.
**`Prose`**: typography for plain HTML: p, ul, ol, table, code, pre, blockquote, h3, h4, a, hr.
Running text keeps to about 72 characters a line (34em); tables and code use the full column,
and table cells use tabular numbers.
**`Wide`**: makes any block span the full content width.

```tsx
<Title eyebrow="Recommendation">Blobs to GCS now.</Title>
<Lede>Build a <strong>general Vault</strong> …</Lede>
<Prose><p>…</p><ul><li>…</li></ul></Prose>
```

## Content

**`Stat`**: a number with dimmed prefix/unit, a label and a note. Props: `value`, `pre`, `unit`,
`label`, `note`, `tone` (label colour), `size` (`sm` `md` `lg` `xl`).
**`StatRow`**: Stats side by side with hairlines; two per row on phones. `items`, `size`.
**`Num`**: the inline version: `<Num pre="≈" value="$145k" unit="/yr" />`.
**`Morph`**: animates a changing number or word (torph): `value={<Morph>{total}</Morph>}`.

```tsx
<Stat label="Saved per year" tone="orange" size="xl" pre="≈" value="$145k" unit="/yr" note="blobs to GCS" />
<StatRow items={[{ value: '−88', unit: '%', note: 'Datastore storage' }, { value: '1', unit: '×', note: 'copies' }]} />
```

**`Takeaway`**: the one thing to know, larger text with a coloured label. `label`, `tone`.

```tsx
<Takeaway>Move the blobs now; it pays for itself in two months.</Takeaway>
```

**`Callout`**: an aside: `kind` `note` | `warn` | `question` | `good` | `bad`; `title`, `label`.

```tsx
<Callout kind="question" title="Regional or dual-region?">Decide before the backfill.</Callout>
```

**`MarginNote`**: sits in the right margin on wide screens, inline on narrow ones. Place it
directly before the block it belongs to. `label`, `title`, `tone` (default peach), `icon`.

```tsx
<MarginNote label="Open · owners" title="Who owns B?">Needs a name before May.</MarginNote>
<Prose><p>…</p></Prose>
```

**`Disclosure`**: animated expand/collapse. `label`, `meta` (right-hand text), `defaultOpen`,
`open`/`onOpenChange`, `variant` (`line` | `card`). Wrap a run of line disclosures in
**`DisclosureGroup`**. **`Reveal`** is the bare animation (`open`, children) for your own toggles.

```tsx
<DisclosureGroup>
  <Disclosure label="Why not keep them in Datastore?" meta="cost">…</Disclosure>
  <Disclosure label="Rollback">…</Disclosure>
</DisclosureGroup>
```

**`Compare`**: before/after, A/B or options as rows. A table on wide screens, cards on phones.
`columns` (`label`, `sub`, `tone`), `rows` (`label`, `cells[]`, `note`), `emphasis` (column index).

```tsx
<Compare emphasis={1} columns={[{ label: 'Today' }, { label: 'After', tone: 'teal' }]}
  rows={[{ label: 'Deletes', cells: ['Soft flag', 'Purged after 30 days'] }]} />
```

**`Tag`**: small uppercase flag (`tone`, `variant` `outline`|`soft`, `icon` `diamond`|`dot`).
**`Chip`**: normal-case pill for names/filters; `mono`, `selected`, `onClick` makes it a toggle.

```tsx
<Tag tone="peach" icon="diamond">Region</Tag> <Chip mono>app-events</Chip>
```

**`Steps`**: a numbered list with a rail, for a real sequence. `items` (`title`, `body`, `meta`,
`tone`, `detail` → expandable), `start`.

```tsx
<Steps items={[{ title: 'Create the bucket', body: 'Soft delete on.' }, { title: 'Backfill', detail: '…' }]} />
```

**`KeyValue`**: labelled facts. `items` (`k`, `v`, `mono`, `note`), `cols` (1 or 2).

```tsx
<KeyValue items={[{ k: 'Bucket', v: 'app-events', mono: true }, { k: 'Owner', v: 'Backend' }]} />
```

**`Legend`**: small key: `items` (`label`, `tone` or `color`, `kind` `line`|`dashed`|`box`|`dot`|`hatch`).

## Diagrams

All diagrams use the tokens, work in both modes, and never widen the page: below their
`minWidth` they scroll sideways inside their own frame and say so. Most accept `title`,
`caption` and `legend`. Nodes and steps take `tone`. Flow and Sequence columns are never
narrower than their longest word, so text stays inside its box; if a diagram gets too wide it
scrolls. Keep node titles to a few words and put the rest in `sub` or `detail`.

**`Flow`**: boxes on a grid you specify, with labelled right-angle edges that route themselves.
- `nodes`: `id`, `col`, `row` (1-based), `span`, `rowSpan`, `title`, `sub`, `kicker` (mono line),
  `icon` (lucide component), `extra` (tags), `tone`, `kind` (`box` | `strong` | `ghost` | `pill` | `note`),
  `detail` (makes it clickable; the detail opens under the diagram and lights up its neighbours).
- `edges`: `from`, `to`, `label`, `tone`, `dashed`, `route` (`ortho` | `curve`), `fromSide`/`toSide`
  (`t` `b` `l` `r`), `arrow` (`end` | `both` | `none`), `labelAt`, `labelWrap`, `bend`.
- Edge labels never hide an arrowhead. A label sits on its line as near `labelAt` (default 0.5)
  as it can while the last stretch before the arrowhead stays clear. When an edge runs straight
  between neighbouring columns or rows, the gaps grow to fit its label: `colGap` (default 36) and
  `rowGap` (default 56) are minimums, and every column (row) gap widens to the widest such label.
  Labels on those horizontal edges wrap at 88px (`labelWrap` changes it), so gaps stay narrow.
  A label with no room on its line sits beside it (above a horizontal run, right of a vertical
  one) and the page warns in the console, naming the edge (`a → b`), in `pnpm dev` and in
  `scripts/shot.mjs`. Keep labels to a word or two; on a warning, shorten the label or widen the gap.
- `groups` (boxes behind nodes: `label`, `col`, `row`, `span`, `rowSpan`, `tone`, `dashed`),
  `lanes` (row labels), `dividers` (dashed rule under a row), `highlight` (node ids to light up;
  the rest dims), `cols`, `rowGap`, `colGap`, `minWidth`, `bare`.

```tsx
<Flow
  nodes={[
    { id: 'app', col: 1, row: 1, title: 'iOS app', icon: Smartphone },
    { id: 'api', col: 2, row: 1, title: 'Vault', tone: 'teal', kind: 'strong', detail: 'Records and revisions.' },
    { id: 'gcs', col: 2, row: 2, title: 'GCS bucket', tone: 'peach' },
  ]}
  edges={[{ from: 'app', to: 'api', label: 'sync' }, { from: 'api', to: 'gcs', label: 'blobs', tone: 'peach' }]}
  highlight={['app', 'api']}
/>
```

**`Swimlane`**: lanes by role with steps placed by lane and column, labelled edges, and dividing
lines between lanes. `lanes` (`id`, `label`, `sub`, `tone`), `steps` (Flow nodes with `lane` instead
of `row`), `edges`, `dividers` (`after`: lane id, `label`, `tone`; default orange).

```tsx
<Swimlane
  lanes={[{ id: 'op', label: 'Operator', tone: 'teal' }, { id: 'ref', label: 'Reference' }]}
  steps={[{ id: 'p', lane: 'op', col: 1, title: 'Predict' }, { id: 'm', lane: 'ref', col: 2, title: 'Match' }]}
  edges={[{ from: 'p', to: 'm', label: 'after lock', dashed: true }]}
  dividers={[{ after: 'op', label: 'Blinding' }]}
/>
```

**`Sequence`**: participants and messages. `participants` (`id`, `label`, `sub`, `tone`); `items`
are messages (`from`, `to`, `label`, `sub`, `kind` `call`|`reply`|`async`, `tone`; `from === to`
draws a self-call), notes (`note`, `over: [ids]`) or dividers (`divider`). `numbered`, `active`
(index to emphasise).

```tsx
<Sequence participants={[{ id: 'app', label: 'App' }, { id: 'api', label: 'API' }]}
  items={[{ from: 'app', to: 'api', label: 'PUT /session' }, { from: 'api', to: 'app', label: '201', kind: 'reply' }]} />
```

**`Tracks`**: parallel workstreams with dependencies. `stages` is a list of rows of tracks
(`[[f], [a, b], [c]]` = f, then a ∥ b, then c), joined by orthogonal connectors; `joins` labels
each connector. A track has `id`, `badge`, `title`, `meta`, `tone`, `items` (`title`, `sub`, `extra`,
`detail`), `outcome`, `ghost`. A full-width track lays its items out in columns. Stacks on phones.

```tsx
<Tracks joins={['needs 0']} stages={[
  [{ id: 'f', badge: '0', title: 'Foundation', items: [{ title: 'Buckets' }, { title: 'IAM' }] }],
  [{ id: 'a', badge: 'A', title: 'Notes', tone: 'teal', outcome: 'Live' }, { id: 'b', badge: 'B', title: 'Blobs', tone: 'orange' }],
]} />
```

**`Cycle`**: a process that returns to its start: steps on a ring with arrows, `center` text,
`active` index. A vertical list with a return rail below ≈520 px.

```tsx
<Cycle center="every release" steps={[{ title: 'Measure' }, { title: 'Decide' }, { title: 'Deploy' }]} />
```

**`Timeline`**: dated items (`date`, `title`, `body`, `state` `done`|`now`|`next`|`risk`, `tone`).
Horizontal when it fits (`maxAcross`, default 6), else vertical; force with `layout`.

```tsx
<Timeline items={[{ date: 'Mar 3', title: 'Foundation', state: 'done' }, { date: 'Jun', title: 'Launch', state: 'next' }]} />
```

**`Matrix`**: a grid of cells with states. `rows`, `cols` (`id`, `label`, `sub`), `states`
(id → `label`, `tone`, `fill` `solid`|`outline`|`hatch`|`empty`), `cells` (`"row:col"` → `state`,
`label`, `note` (clickable), `flag`), `corner`. Draws its own legend.

```tsx
<Matrix rows={[{ id: 'pro', label: 'Pro' }]} cols={[{ id: 'g15', label: 'Gen 15' }]}
  states={{ measured: { label: 'Measured', tone: 'teal', fill: 'solid' } }}
  cells={{ 'pro:g15': { state: 'measured', note: 'Class reference.' } }} />
```

**`DiagramFrame`** and **`Wired`**: the parts the diagrams are built from, for custom diagrams.
`DiagramFrame` is the rounded surface with title, legend, caption and in-frame scrolling
(`minWidth`). `Wired` draws `wires` (same fields as Flow edges) between any descendants marked
`data-node="id"`, laid out however you like with CSS. Labels keep clear of arrowheads as in Flow,
but `Wired` does not grow your gaps: leave room for each label plus about 30px, or it sits beside its line.

```tsx
<DiagramFrame minWidth={560}>
  <Wired wires={[{ from: 'a', to: 'b', label: 'calls' }]} className="grid grid-cols-2 gap-12">
    <div data-node="a" className="rounded-xl border border-line-strong bg-paper p-3">A</div>
    <div data-node="b" className="rounded-xl border border-line-strong bg-paper p-3">B</div>
  </Wired>
</DiagramFrame>
```

## State and story

**`Segmented`**: segmented control (radio group, arrow keys, sliding highlight). `options`
(`id`, `label`), `value`, `onChange`, `size`, `label`.
**`StageSwitcher`**: a Segmented that swaps between states of one thing. `stages` (`id`, `label`,
`caption`, `content`), or `children(stageId, index)` to render one view whose props change
(changes in `Flow` `highlight` animate). `content` swaps at once and the new view fades in.
`label`, `defaultStage`.

```tsx
<StageSwitcher label="Show" stages={[{ id: 'now', label: 'Today' }, { id: 'b', label: 'After B' }]}>
  {(id) => <Flow nodes={nodes} edges={edges} highlight={paths[id]} />}
</StageSwitcher>
```

**`Picker`**: choose one option, see what it means; list beside the view on wide screens, chips
on phones. `options` (`id`, `label`, `sub`, plus any fields you need), `children(option)`, `label`.

```tsx
<Picker label="Kind of change" options={[{ id: 'minor', label: 'Minor release', path: ['a', 'b'] }]}>
  {(o) => <Flow nodes={nodes} edges={edges} highlight={o.path} />}
</Picker>
```

**`ScrollStory`**: chapters scroll beside a pinned stage that follows the active chapter.
Readable at rest; clicking a chapter activates it; inline (chapter, then its stage) below ≈860 px.
`chapters` (`title`, `body`, `eyebrow`, `id`), `stage(index)`.

```tsx
<ScrollStory chapters={[{ title: 'Today' }, { title: 'After B' }]} stage={(i) => <Flow … highlight={paths[i]} />} />
```

## Data (`@/kit/charts`)

Shared props: `data` (rows), `x` (category key), `series` (`key`, `label`, `tone`, `dashed`),
`height`, `unit`, `format`, `title`, `caption`, `reference` (`y`, `label`, `tone`), `wide`.
Series default to `--chart-1…6`. A legend appears with two or more series.

- **`BarChart`**: grouped bars; `stacked`, `horizontal`.
- **`LineChart`**: lines; `area` (filled), `stacked` (with `area`), `dots`.
- **`Histogram`**: raw `values` into `bins`; `domain`, `markers` (`x`, `label`, `tone`).

```tsx
<BarChart title="Storage, TB" data={rows} x="month" stacked unit=" TB"
  series={[{ key: 'datastore', label: 'Datastore' }, { key: 'gcs', label: 'GCS', tone: 'peach' }]} />
<Histogram title="Latency, ms" values={ms} bins={30} markers={[{ x: 250, label: 'SLO', tone: 'bad' }]} />
```

**`Sparkline`** (from `@/kit`, no Recharts): tiny trend line. `values`, `tone`, `width`, `height`,
`area`, `dot`.

## Dashboards (`@/kit/dashboard`)

For a nap of type `dashboard`. Read the `dashboards` topic first; these parts do what it asks for.
`src/examples/DashboardExample.tsx` shows all of them with every state (`/?dashboard` in dev).

**`useDataset`**: one thing the page loads and keeps fresh. `id`, `title`, `source` (where it comes
from, a few words), `link`, `load` (async; gets `{ signal }`), `refresh` (seconds, default 300, 0
for once), `staleAfter` (seconds, default three refreshes), `deps` (a change loads again), `enabled`.
It returns `{ status: 'loading' | 'ready' | 'error', data, error, updatedAt, stale, refreshing,
reload }`. It refreshes in place, waits while the tab is hidden, loads at once when the tab shows
again with old data, and keeps the last data when a refresh fails (`stale` and `error` are then set).
Never write your own timer or fetch-in-effect for dashboard data.

**`Dashboard`**: the shell, instead of `Page`: `title`, `eyebrow`, `range` (the time the numbers
cover: text or a `RangePicker`), `controls`. Its header shows how fresh the data is ("Updated 3
min ago", by the oldest dataset) and opens Sources: every dataset with its source, age and error.
With `?wall` in the address (or `wall`) it is wall mode: no controls, everything enlarged to fill
a big screen (`wallWidth`, default 1440, is the width the layout is designed for).

**`DashGrid`**: one column on a phone up to `cols` (1, 2, 3, 4, 6) on wide screens, by its own width.
**`Metric`**: one number with its unit and what it compares to. `label`, `dataset`, `value` and
`compare` (numbers, or functions of the data; the change shows in percent), `compareLabel`, `format`,
`pre`, `unit`, `goodWhen` (`'up' | 'down' | 'none'`), `note`.
**`Panel`**: a titled card for a chart or table. `title` (what it shows, not what it is), `note`,
`dataset`, `children` as a function of the data, `empty`, `emptyText`, `height` (kept while there
is nothing to draw), `span` (2, 3, `'full'`), `actions`. With a dataset it draws the loading,
empty and error states itself and marks stale data with its age.
**`RangePicker`**: `options` (`id`, `label`), `value`, `onChange`. Put the choice in the datasets' `deps`.
**`ago(date)`**: "3 min ago".

```tsx
const [range, setRange] = useState('30')
const signups = useDataset({
  id: 'signups', title: 'Signups per day', source: 'Amplitude', deps: [range],
  load: () => nap.amplitude.segmentation({ /* … */ }).then(toRows),
})
<Dashboard title="Signups" range={<RangePicker options={RANGES} value={range} onChange={setRange} />}>
  <DashGrid cols={4}>
    <Metric dataset={signups} label="Signups" value={(d) => d.total} compare={(d) => d.previous} />
  </DashGrid>
  <DashGrid cols={3}>
    <Panel title="Signups per day" dataset={signups} span={2}>
      {(d) => <LineChart data={d.rows} x="day" series={[{ key: 'signups' }]} />}
    </Panel>
  </DashGrid>
</Dashboard>
```

- The look of a dashboard is the theme's: charts use `--chart-1…6`, so a page switches theme with
  the rest of Nap.
- Label the values that matter on the chart; wall screens and phones have no hover.

## Slides

For a nap of type `slides`. Read the `slides` topic first: it is the contract for a deck (one
`<section>` a slide on a 1920 × 1080 canvas, notes, steps, transitions, islands). Nap's slides
shell shows and presents the deck; the kit gives you a deck to start from and its styles.

```sh
pnpm dev                 # http://localhost:5173/slides.html, with Nap's shell
pnpm build:slides        # → dist-slides/index.html, one file
node scripts/shot.mjs out.png 1600 dark no dist-slides/index.html#slide-3   # one slide, in the shell
node /tmp/nap-publish.mjs dist-slides --type slides
```

- **`slides.html`** is the deck: plain HTML, one `<section class="slide">` a slide. Set its
  `<title>`; the build fails on the placeholder. Tailwind classes work in it, next to the deck's own.
- **`src/slides/deck.css`** styles slides on the theme tokens, in px of the canvas. Layouts go
  next to `slide`: `title` (bottom-left, with the theme's glow) and `center`. Parts: `eyebrow`,
  `lede`, `big` (a huge number, with `unit`), `cols` (two columns; `wide-right`), `fill` (takes
  the room that is left, for an island), `foot`, `accent`. Add your own classes there. Text sizes:
  body 40 px, `h2` 76 px, `h1` 128 px; nothing a room should read goes under 24 px.
- **`src/slides/main.tsx`** fills the islands: `mountIslands({ name: Component })` from
  `@/kit/slides` renders each component into the elements with that `data-island`. All islands
  share one React tree under `KitRoot`. Every kit part works in an island, and `useDataset`
  (`@/kit/dashboard`) loads and refreshes its data. Remove the example island, and the charts
  import, from a deck without one.
- Inside an island, kit parts are drawn at twice their size (`zoom: 2`): design the island as
  for a page about 960 px wide, and give charts a `height` of what is left of 540 px.
- The shell comes from the Nap the kit was fetched from (`nap.local.json`, or `NAP_URL`), in dev
  and for screenshots; a built deck loads it from Nap itself.
- A deck has the same themes as a page, and switches the same way.

## Code (`@/kit/code`) and trees

**`Code`**: highlighted code with a copy button. `code`, `lang` (ts, tsx, py, sql, bash, json, yaml,
swift, kotlin, go, rust… 152 languages), `title`, `lineNumbers`, `highlight` (line numbers), `wrap`,
`maxHeight`, `caption`.

```tsx
<Code title="store.py" lang="python" lineNumbers highlight={[3]} code={source} />
```

**`Diff`** (@pierre/diffs): a unified `patch` (git diff text), or `before` + `after` + `name`.
Split when wide, unified on phones (`layout` to force). `title`, `caption`.

```tsx
<Diff before={oldText} after={newText} name="settings.py" />
```

Both highlight with `@pierre/highlights`, whose WebAssembly is embedded as base64 in its module,
so it inlines into the single file without extra steps (≈0.45 MB). `@pierre/diffs` would also pull
in Shiki and every grammar (≈10 MB); `vite.config.ts` stubs Shiki out, so `Diff` always uses the
Highlights backend. If a page needs `Code` but must stay small, render a plain
`<Prose><pre><code>…</code></pre></Prose>` instead.

**`Tree`** (from `@/kit`): file tree or call tree with guide lines and collapsible branches.
`items` (`name`, `note`, `children`, `open`, `tone`, `status` `added`|`removed`|`changed`), `mono`
(default true), `title`.

```tsx
<Tree items={[{ name: 'src', children: [{ name: 'App.tsx', note: 'entry' }, { name: 'old.ts', status: 'removed' }] }]} />
```

## Media

**`Figure`**: an image (`src`, `alt`) or any visual (children) with `caption`, `credit`, `frame`, `wide`.
**`Lightbox`**: thumbnail grid that opens full-size; arrow keys and buttons move, Esc closes.
`images` (`src`, `alt`, `label`, `caption`), `columns`, `aspect` (e.g. `"9 / 19.5"`), `fit`.
**`PhoneFrame`**: iPhone-shaped frame for a screenshot (`src`) or live children; `width`, `caption`.

```tsx
import shot from './assets/onboarding.png'
<Figure src={shot} alt="Onboarding step 2" caption="Step 2 asks for the alarm time." frame />
<Lightbox columns={4} aspect="9 / 19.5" images={[{ src: shot, label: 'Step 2' }]} />
<PhoneFrame src={shot} width={240} />
```

## Accessibility and motion

Focus rings are visible (teal outline). Disclosures, nodes with detail, matrix cells and tabs are
real buttons with ARIA state; Segmented and Picker are radio groups with arrow keys.
`prefers-reduced-motion` removes movement and scale (presses, popup zoom, Reveal's height,
Motion transforms) but keeps opacity and colour fades. `Reveal`/`Disclosure` are
pure CSS; `motion` is only loaded by `Segmented`/`StageSwitcher`, `torph` only by `Morph`.
