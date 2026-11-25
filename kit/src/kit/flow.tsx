import { X } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type CSSProperties, type ComponentType, type ReactNode } from 'react'
import { cn, toneColor, toneMix, type Tone } from './lib'
import { Reveal } from './content'
import { DiagramFrame, Wired, labelRoom, type LabelSize, type Side, type Wire } from './wires'
import type { LegendItem } from './content'

/* ════════════════════════════════════════════════════════════════════════════
   Flow: boxes on a column/row grid with labelled right-angle edges.
   You place every node yourself (col/row, 1-based), so the layout is exactly
   what you specify. Edges route themselves between the boxes.
   ════════════════════════════════════════════════════════════════════════════ */

export type FlowNode = {
  id: string
  /** Grid position, 1-based. */
  col: number
  row: number
  /** Columns / rows to span. */
  span?: number
  rowSpan?: number
  title: ReactNode
  sub?: ReactNode
  tone?: Tone
  /**
   * box (default) · strong: tinted, for the key node · ghost: dashed, for planned or
   * removed parts · pill: small rounded start/end marker · note: free text, no box
   */
  kind?: 'box' | 'strong' | 'ghost' | 'pill' | 'note'
  /** A lucide-react icon component, e.g. `icon: Database`. */
  icon?: ComponentType<{ className?: string }>
  /** Small mono text above the title: an id, step number or path. */
  kicker?: ReactNode
  /** Extra content under the sub (tags, chips). */
  extra?: ReactNode
  /** Makes the node clickable; the detail opens under the diagram. */
  detail?: ReactNode
  /** Horizontal alignment inside its cell(s). Default stretch. */
  align?: 'stretch' | 'start' | 'center' | 'end'
}

export type FlowEdge = {
  from: string
  to: string
  label?: ReactNode
  tone?: Tone
  dashed?: boolean
  route?: 'ortho' | 'curve'
  fromSide?: Side
  toSide?: Side
  arrow?: 'end' | 'both' | 'none'
  labelAt?: number
  /** Max line width (px) of the label before it wraps. Default 88 on an edge straight across between neighbouring columns; one line elsewhere. */
  labelWrap?: number
  bend?: number
}

export type FlowGroup = {
  label?: ReactNode
  col: number
  row: number
  span?: number
  rowSpan?: number
  tone?: Tone
  dashed?: boolean
}

export type FlowLane = { label: ReactNode; sub?: ReactNode; tone?: Tone; band?: boolean }
export type FlowDivider = { after: number; label?: ReactNode; tone?: Tone }

export type FlowProps = {
  nodes: FlowNode[]
  edges?: FlowEdge[]
  /** Number of columns. Default: the largest col + span - 1. */
  cols?: number
  /** Boxes drawn behind nodes to group them (a service boundary, a phase). */
  groups?: FlowGroup[]
  /** Row labels in a left column, one per row (row 1 = lanes[0]). Turns the grid into lanes. */
  lanes?: FlowLane[]
  /** Dashed full-width rules between rows, e.g. a blinding line or a trust boundary. */
  dividers?: FlowDivider[]
  /** Node ids to emphasise. Edges between two highlighted nodes light up; the rest dim. */
  highlight?: string[]
  title?: ReactNode
  caption?: ReactNode
  legend?: LegendItem[]
  /** Below this width the diagram scrolls inside its frame. Default ≈ 150px per column. */
  minWidth?: number
  /**
   * Minimum gap between rows in px. Default 56. If a labelled edge runs straight down
   * between boxes in neighbouring rows, every row gap grows to fit that label with its
   * arrowhead clear of it.
   */
  rowGap?: number
  /**
   * Minimum gap between columns in px. Default 36. If a labelled edge runs straight across
   * between boxes in neighbouring columns, every column gap grows to fit the widest such
   * label with its arrowhead clear of it, so set this only to make the gaps wider still.
   */
  colGap?: number
  /** Render without the frame box (still scrolls on phones). */
  bare?: boolean
  className?: string
}

function nodeStyle(n: FlowNode, state: 'on' | 'dim' | 'default', selected: boolean): CSSProperties {
  const tone = n.tone ?? 'neutral'
  const tint = (pct: number) => `linear-gradient(${toneMix(tone, pct)}, ${toneMix(tone, pct)}), var(--paper)`
  const s: CSSProperties = {}
  if (n.kind === 'note') return { opacity: state === 'dim' ? 0.4 : 1 }
  if (n.kind === 'ghost') {
    s.background = 'var(--frame)'
    s.borderStyle = 'dashed'
    s.borderColor = tone === 'neutral' ? 'rgb(var(--ink) / 0.2)' : toneMix(tone, 45)
  } else if (n.kind === 'strong') {
    s.background = tint(tone === 'neutral' ? 14 : 12)
    s.borderColor = tone === 'neutral' ? 'rgb(var(--ink) / 0.26)' : toneMix(tone, 60)
  } else {
    s.background = tone === 'neutral' ? 'var(--paper)' : tint(5)
    s.borderColor = tone === 'neutral' ? 'rgb(var(--ink) / 0.15)' : toneMix(tone, 42)
  }
  if (state === 'on' || selected) {
    const t = tone === 'neutral' ? 'teal' : tone
    s.borderColor = toneMix(t, selected ? 90 : 60)
    if (selected) s.boxShadow = `0 0 0 3px ${toneMix(t, 16)}`
  }
  if (state === 'dim') s.opacity = 0.38
  return s
}

function NodeBox({
  n,
  state,
  selected,
  onSelect,
}: {
  n: FlowNode
  state: 'on' | 'dim' | 'default'
  selected: boolean
  onSelect?: () => void
}) {
  const Icon = n.icon
  const tone = n.tone ?? 'neutral'
  const pill = n.kind === 'pill'
  const body = (
    <>
      {n.kicker && <div className="mb-0.5 font-mono text-[10.5px] leading-[1.4] tracking-[0.02em] text-faint">{n.kicker}</div>}
      <div className={cn('flex items-start gap-2', pill && 'items-center justify-center')}>
        {Icon && <Icon className="mt-[1px] size-[15px] shrink-0" />}
        <span
          className={cn(
            'leading-[1.3]',
            n.kind === 'note' ? 'text-[12.5px] text-quiet' : 'text-[13.5px] font-medium text-strong',
            pill && 'text-[12.5px]',
          )}
          style={Icon && tone !== 'neutral' ? undefined : undefined}
        >
          {n.title}
        </span>
      </div>
      {n.sub && <div className={cn('mt-1 text-[12px] leading-[1.42] text-quiet', Icon && !pill && 'pl-[23px]')}>{n.sub}</div>}
      {n.extra && <div className={cn('mt-2', Icon && !pill && 'pl-[23px]')}>{n.extra}</div>}
    </>
  )
  const cls = cn(
    'relative z-10 block w-full text-left',
    n.kind === 'note' ? 'px-1 py-1' : pill ? 'rounded-full border px-4 py-2 text-center' : 'min-w-[9rem] rounded-[12px] border px-3.5 py-2.5',
    onSelect ? 'press cursor-pointer select-none [--press-duration:300ms] [--press-scale:0.98] hover:border-line-strong' : 'transition-[opacity,border-color,box-shadow] duration-300',
  )
  const iconColor = tone !== 'neutral' ? toneColor(tone) : undefined
  return onSelect ? (
    <button type="button" aria-pressed={selected} onClick={onSelect} className={cls} style={{ ...nodeStyle(n, state, selected), color: iconColor }}>
      {body}
      <span aria-hidden className="absolute top-2 right-2.5 text-[13px] leading-none text-faint">
        {selected ? '–' : '+'}
      </span>
    </button>
  ) : (
    <div className={cls} style={{ ...nodeStyle(n, state, selected), color: iconColor }}>
      {body}
    </div>
  )
}

/** Box-and-arrow diagram on an explicit grid. See FlowProps. */
export function Flow(props: FlowProps) {
  const {
    nodes,
    edges = [],
    groups = [],
    lanes,
    dividers = [],
    highlight,
    title,
    caption,
    legend,
    bare,
    rowGap = 56,
    colGap = 36,
    className,
  } = props
  const cols = props.cols ?? Math.max(...nodes.map((n) => n.col + (n.span ?? 1) - 1))
  const rows = Math.max(...nodes.map((n) => n.row + (n.rowSpan ?? 1) - 1), lanes?.length ?? 0)
  const [selected, setSelected] = useState<string | null>(null)
  const sel = nodes.find((n) => n.id === selected)
  // keep the last detail on screen while the panel closes
  const lastRef = useRef<FlowNode | undefined>(undefined)
  if (sel) lastRef.current = sel
  const lastSel = lastRef.current

  // selection highlights the node and its direct neighbours; otherwise the prop
  const lit = useMemo(() => {
    if (selected) {
      const s = new Set([selected])
      edges.forEach((e) => {
        if (e.from === selected) s.add(e.to)
        if (e.to === selected) s.add(e.from)
      })
      return s
    }
    return highlight?.length ? new Set(highlight) : null
  }, [selected, highlight, edges])

  // edges straight across between neighbouring columns / down between neighbouring rows:
  // their label has only one gap to sit in
  const straight = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const box = (n: FlowNode) => ({ c0: n.col, c1: n.col + (n.span ?? 1) - 1, r0: n.row, r1: n.row + (n.rowSpan ?? 1) - 1 })
    const across = (s?: Side) => !s || s === 'l' || s === 'r'
    const down = (s?: Side) => !s || s === 't' || s === 'b'
    return edges.map((e): 'across' | 'down' | null => {
      const A = byId.get(e.from)
      const B = byId.get(e.to)
      if (!A || !B || e.route === 'curve') return null
      const a = box(A)
      const b = box(B)
      if (a.r0 <= b.r1 && b.r0 <= a.r1 && (a.c1 + 1 === b.c0 || b.c1 + 1 === a.c0) && across(e.fromSide) && across(e.toSide)) return 'across'
      if (a.c0 <= b.c1 && b.c0 <= a.c1 && (a.r1 + 1 === b.r0 || b.r1 + 1 === a.r0) && down(e.fromSide) && down(e.toSide)) return 'down'
      return null
    })
  }, [edges, nodes])

  const wires: Wire[] = useMemo(
    () =>
      edges.map((e, i) => ({
        ...e,
        labelWrap: e.labelWrap ?? (straight[i] === 'across' ? 88 : undefined),
        state: !lit ? 'default' : lit.has(e.from) && lit.has(e.to) && (!selected || e.from === selected || e.to === selected) ? 'on' : 'dim',
      })),
    [edges, lit, selected, straight],
  )

  // Labelled edges between neighbouring boxes run only through one gap: grow the gaps so
  // the label fits on the line with the arrowhead clear of it (see Wire.labelAt).
  const [labelSizes, setLabelSizes] = useState<(LabelSize | null)[]>([])
  const onLabelSizes = useCallback(
    (next: (LabelSize | null)[]) =>
      setLabelSizes((prev) =>
        prev.length === next.length && prev.every((p, i) => p?.w === next[i]?.w && p?.h === next[i]?.h) ? prev : next,
      ),
    [],
  )
  const [colGapFit, rowGapFit] = useMemo(() => {
    let cg = colGap
    let rg = rowGap
    edges.forEach((e, i) => {
      const size = labelSizes[i]
      if (e.label == null || !size) return
      if (straight[i] === 'across') cg = Math.max(cg, labelRoom(size.w, e.arrow))
      if (straight[i] === 'down') rg = Math.max(rg, labelRoom(size.h, e.arrow))
    })
    return [cg, rg]
  }, [edges, straight, labelSizes, colGap, rowGap])

  const offset = lanes ? 1 : 0
  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `${lanes ? 'minmax(96px, 132px) ' : ''}repeat(${cols}, minmax(min-content, 1fr))`,
    gridTemplateRows: `repeat(${rows}, auto)`,
    columnGap: colGapFit,
    rowGap: rowGapFit,
  }
  // a floor of ~190px per column; the agent's minWidth can only raise it
  const minWidth = Math.max(props.minWidth ?? 0, cols * 190 + (lanes ? 140 : 0))
  // room for a group label above the first row
  if (groups.some((g) => g.row === 1 && g.label)) gridStyle.paddingTop = 22

  return (
    <DiagramFrame title={title} legend={legend} caption={caption} minWidth={minWidth} bare={bare} className={className}>
      <Wired wires={wires} style={gridStyle} onLabelSizes={onLabelSizes}>
        {/* lane bands and labels */}
        {lanes?.map((l, i) => (
          <div key={`lane${i}`} className="contents">
            {l.band && (
              <div
                aria-hidden
                className="-mx-3 -my-3 rounded-[14px] border md:-mx-4"
                style={{
                  gridColumn: '1 / -1',
                  gridRow: i + 1,
                  borderColor: toneMix(l.tone ?? 'neutral', 30),
                  background: toneMix(l.tone ?? 'neutral', 5),
                }}
              />
            )}
            <div className="relative z-10 self-center pr-2" style={{ gridColumn: 1, gridRow: i + 1 }}>
              <div className="eyebrow" style={l.tone ? { color: toneColor(l.tone) } : { color: 'rgb(var(--ink) / 0.75)' }}>
                {l.label}
              </div>
              {l.sub && <div className="mt-1 text-[12px] leading-[1.4] text-quiet">{l.sub}</div>}
            </div>
          </div>
        ))}
        {/* groups */}
        {groups.map((g, i) => (
          <div
            key={`g${i}`}
            aria-hidden={!g.label}
            className={cn('relative -mx-3 -mt-8 -mb-3 rounded-[16px] border', g.dashed && 'border-dashed')}
            style={{
              gridColumn: `${g.col + offset} / span ${g.span ?? 1}`,
              gridRow: `${g.row} / span ${g.rowSpan ?? 1}`,
              borderColor: g.tone ? toneMix(g.tone, 35) : 'rgb(var(--ink) / 0.12)',
              background: g.tone ? toneMix(g.tone, 4) : 'rgb(var(--ink) / 0.02)',
            }}
          >
            {g.label && (
              <div className="eyebrow absolute top-2 left-3.5 text-[10.5px]" style={g.tone ? { color: toneColor(g.tone) } : undefined}>
                {g.label}
              </div>
            )}
          </div>
        ))}
        {/* dividers sit in the gap under row `after` */}
        {dividers.map((d, i) => (
          <div
            key={`d${i}`}
            className="relative z-10 flex h-0 items-center self-end"
            style={{ gridColumn: '1 / -1', gridRow: d.after, transform: `translateY(${rowGapFit / 2}px)` }}
          >
            <span aria-hidden className="absolute inset-x-[-12px] top-0 border-t-[1.5px] border-dashed" style={{ borderColor: toneColor(d.tone ?? 'orange') }} />
            {d.label && (
              <span
                className="relative -translate-y-0 rounded-full border bg-frame px-3 py-[3px] text-[10.5px] font-medium tracking-[0.1em] uppercase"
                style={{ color: toneColor(d.tone ?? 'orange'), borderColor: toneMix(d.tone ?? 'orange', 45) }}
              >
                {d.label}
              </span>
            )}
          </div>
        ))}
        {/* nodes */}
        {nodes.map((n) => {
          const state = !lit ? 'default' : lit.has(n.id) ? 'on' : 'dim'
          return (
            <div
              key={n.id}
              data-node={n.id}
              className="relative z-10 flex"
              style={{
                gridColumn: `${n.col + offset} / span ${n.span ?? 1}`,
                gridRow: `${n.row} / span ${n.rowSpan ?? 1}`,
                alignSelf: 'center',
                justifySelf: n.align ?? (n.kind === 'pill' ? 'center' : 'stretch'),
              }}
            >
              <NodeBox
                n={n}
                state={state}
                selected={selected === n.id}
                onSelect={n.detail ? () => setSelected(selected === n.id ? null : n.id) : undefined}
              />
            </div>
          )
        })}
      </Wired>
      <Reveal open={!!sel?.detail}>
        <div className="mt-6 flex items-start gap-4 rounded-[14px] border border-line bg-paper px-4 py-3.5 md:px-5" aria-live="polite">
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-medium text-strong">{(sel ?? lastSel)?.title}</div>
            <div className="mt-1 text-[14px] leading-[1.6] text-body">{(sel ?? lastSel)?.detail}</div>
          </div>
          <button
            type="button"
            onClick={() => setSelected(null)}
            aria-label="Close detail"
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-quiet hover:bg-sheer-2 hover:text-strong"
          >
            <X className="size-4" />
          </button>
        </div>
      </Reveal>
    </DiagramFrame>
  )
}

/* ─── Swimlane ────────────────────────────────────────────────────────────── */

export type SwimStep = Omit<FlowNode, 'row'> & { lane: string }

/**
 * Lanes by role or system, steps placed in a lane and a column, labelled edges,
 * and optional dividing lines between lanes (a blinding line, a trust boundary).
 */
export function Swimlane({
  lanes,
  steps,
  edges,
  dividers,
  ...rest
}: Omit<FlowProps, 'nodes' | 'lanes' | 'dividers'> & {
  lanes: Array<FlowLane & { id: string }>
  steps: SwimStep[]
  /** Dividing line under the lane with this id. */
  dividers?: Array<{ after: string; label?: ReactNode; tone?: Tone }>
}) {
  const rowOf = (id: string) => lanes.findIndex((l) => l.id === id) + 1
  return (
    <Flow
      {...rest}
      lanes={lanes.map((l) => ({ band: true, ...l }))}
      nodes={steps.map((s) => ({ ...s, row: rowOf(s.lane) }))}
      edges={edges}
      dividers={dividers?.map((d) => ({ ...d, after: rowOf(d.after) }))}
      rowGap={rest.rowGap ?? 64}
    />
  )
}
