import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cn, toneColor, type Tone } from './lib'
import { Legend, type LegendItem } from './content'

/* ════════════════════════════════════════════════════════════════════════════
   Wires: edges drawn between HTML boxes. Lay boxes out with CSS (grid, flex),
   mark each with data-node="id", and list the edges. Paths are measured from the
   DOM and redrawn on resize, so layout stays plain CSS and reflows naturally.
   ════════════════════════════════════════════════════════════════════════════ */

export type Side = 't' | 'b' | 'l' | 'r'
export type WireState = 'default' | 'on' | 'dim'

export type Wire = {
  from: string
  to: string
  label?: ReactNode
  tone?: Tone
  dashed?: boolean
  /** ortho (default): right angles with rounded corners. curve: smooth S-bend. */
  route?: 'ortho' | 'curve'
  /** Sides to leave / enter. Default: picked from the boxes' relative position. */
  fromSide?: Side
  toSide?: Side
  /** Arrowheads. Default 'end'. */
  arrow?: 'end' | 'both' | 'none'
  /**
   * Where the label sits along the path, 0–1. Default 0.5. The label never covers the
   * arrowhead: it slides along the line to stay clear of it, and when the line is too
   * short it sits beside the line instead (above a horizontal run, right of a vertical one).
   */
  labelAt?: number
  /** Lets a long label wrap onto lines at most this wide (px), for a short line. Default: one line, up to 180px. */
  labelWrap?: number
  /** For ortho routes: where the middle bend sits between the two ends, 0–1. Default 0.5. */
  bend?: number
  state?: WireState
}

export type Pt = { x: number; y: number }
type Drawn = { i: number; d: string; label?: Pt; fit?: 'on' | 'beside' | 'covers'; end: Pt; endDir: Pt; start: Pt; startDir: Pt; w: Wire }
export type LabelSize = { w: number; h: number }

/** Line kept clear of labels before an arrowhead: the chevron (5.5px) plus a visible stretch. */
export const ARROW_ROOM = 16
/** Line kept clear at the start of a wire without an arrowhead there. */
const START_ROOM = 6
/** Space kept between a label and the line it must not cover. */
const LABEL_PAD = 2

/**
 * Length of straight line a label needs to sit on its wire without hiding the arrowhead:
 * the label's extent along the line (`along`: its width on a horizontal run, its height
 * on a vertical one) plus the clear room at both ends.
 */
export function labelRoom(along: number, arrow: Wire['arrow'] = 'end') {
  return Math.ceil(along + 2 * LABEL_PAD + 4 + (arrow === 'none' ? START_ROOM : ARROW_ROOM) + (arrow === 'both' ? ARROW_ROOM : START_ROOM))
}

/** Warnings for authors: in `pnpm dev`, and for built pages opened from disk (scripts/shot.mjs). */
const warned = new Set<string>()
function authorWarn(msg: string) {
  const local = import.meta.env.DEV || (typeof location !== 'undefined' && location.protocol === 'file:')
  if (!local || warned.has(msg)) return
  warned.add(msg)
  console.warn(`[kit] ${msg}`)
}
function warnLabels(drawn: Drawn[]) {
  for (const x of drawn) {
    const name = `${x.w.from} → ${x.w.to}`
    if (x.fit === 'beside')
      authorWarn(`Label on edge ${name} is longer than its line, so it sits beside the line. Widen the gap (colGap/rowGap) or shorten the label.`)
    if (x.fit === 'covers') authorWarn(`Label on edge ${name} covers its arrowhead. Widen the gap (colGap/rowGap) or shorten the label.`)
  }
}

type Sample = { p: Pt; s: number }

/** Points every ~3px along a polyline, with their distance from the start. */
function densify(pts: Pt[], step = 3): Sample[] {
  const out: Sample[] = [{ p: pts[0], s: 0 }]
  let s = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(len / step))
    for (let k = 1; k <= n; k++) out.push({ p: { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }, s: s + (len * k) / n })
    s += len
  }
  return out
}

/**
 * Where a label of `size` goes on a path. On the line, as near `at` as it can be without
 * covering the clear room at the ends; failing that, beside the line. `fit` says which.
 */
function placeLabel(pts: Pt[], size: LabelSize, at: number, arrow: Wire['arrow']): { c: Pt; fit: 'on' | 'beside' | 'covers' } {
  const samples = densify(pts)
  const total = samples[samples.length - 1].s
  const endRoom = arrow === 'none' ? START_ROOM : ARROW_ROOM
  const startRoom = arrow === 'both' ? ARROW_ROOM : START_ROOM
  const hw = size.w / 2 + LABEL_PAD
  const hh = size.h / 2 + LABEL_PAD
  const kept = samples.filter((q) => q.s < startRoom || q.s > total - endRoom)
  const clear = (c: Pt) => kept.every((q) => Math.abs(q.p.x - c.x) > hw || Math.abs(q.p.y - c.y) > hh)
  const want = total * Math.min(1, Math.max(0, at))
  const order = [...samples].sort((a, b) => Math.abs(a.s - want) - Math.abs(b.s - want))
  const on = order.find((q) => q.s >= startRoom && q.s <= total - endRoom && clear(q.p))
  if (on) return { c: on.p, fit: 'on' }
  // beside the line: above a horizontal run, right of a vertical one (else the other side)
  const dirAt = (q: Sample) => {
    const j = samples.indexOf(q)
    const a = samples[Math.max(0, j - 1)].p
    const b = samples[Math.min(samples.length - 1, j + 1)].p
    return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'h' : 'v'
  }
  const gapX = size.w / 2 + 6
  const gapY = size.h / 2 + 5
  for (const q of order) {
    const sides = dirAt(q) === 'h' ? [{ x: 0, y: -gapY }, { x: 0, y: gapY }] : [{ x: gapX, y: 0 }, { x: -gapX, y: 0 }]
    for (const o of sides) {
      const c = { x: q.p.x + o.x, y: q.p.y + o.y }
      if (clear(c)) return { c, fit: 'beside' }
    }
  }
  return { c: order[0].p, fit: 'covers' }
}

function bezPoints(a: Pt, c1: Pt, c2: Pt, b: Pt, n = 40): Pt[] {
  return Array.from({ length: n + 1 }, (_, k) => bez(a, c1, c2, b, k / n))
}

const DIR: Record<Side, Pt> = { t: { x: 0, y: -1 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 }, r: { x: 1, y: 0 } }
const vertical = (s: Side) => s === 't' || s === 'b'

function autoSides(A: DOMRect, B: DOMRect): [Side, Side] {
  const vOverlap = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top)
  if (vOverlap > 4) return B.left >= A.right - 4 ? ['r', 'l'] : ['l', 'r']
  return B.top >= A.bottom - 4 ? ['b', 't'] : ['t', 'b']
}

function sidePoint(r: DOMRect, base: DOMRect, side: Side, t = 0.5): Pt {
  const x0 = r.left - base.left
  const y0 = r.top - base.top
  if (side === 't') return { x: x0 + r.width * t, y: y0 }
  if (side === 'b') return { x: x0 + r.width * t, y: y0 + r.height }
  if (side === 'l') return { x: x0, y: y0 + r.height * t }
  return { x: x0 + r.width, y: y0 + r.height * t }
}

/** Polyline → path with rounded corners. */
export function rounded(pts: Pt[], radius = 10) {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) > 0.5)
  if (p.length < 3) return p.map((q, i) => `${i ? 'L' : 'M'}${q.x},${q.y}`).join(' ')
  let d = `M${p[0].x},${p[0].y}`
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1]
    const b = p[i]
    const c = p[i + 1]
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    const u = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) }
    const v = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y) }
    d += ` L${b.x - u.x * r},${b.y - u.y * r} Q${b.x},${b.y} ${b.x + v.x * r},${b.y + v.y * r}`
  }
  const last = p[p.length - 1]
  return d + ` L${last.x},${last.y}`
}

function along(pts: Pt[], t: number): Pt {
  const segs = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y))
  const total = segs.reduce((a, b) => a + b, 0)
  let k = total * t
  for (let i = 0; i < segs.length; i++) {
    if (k <= segs[i] || i === segs.length - 1) {
      const f = segs[i] ? Math.min(1, k / segs[i]) : 0
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f }
    }
    k -= segs[i]
  }
  return pts[0]
}

function orthoPoints(a: Pt, fs: Side, b: Pt, ts: Side, bend: number): Pt[] {
  const out = 18
  if (vertical(fs) && vertical(ts)) {
    if (fs !== ts) {
      const my = a.y + (b.y - a.y) * bend
      return [a, { x: a.x, y: my }, { x: b.x, y: my }, b]
    }
    const y = fs === 'b' ? Math.max(a.y, b.y) + out : Math.min(a.y, b.y) - out
    return [a, { x: a.x, y }, { x: b.x, y }, b]
  }
  if (!vertical(fs) && !vertical(ts)) {
    if (fs !== ts) {
      const mx = a.x + (b.x - a.x) * bend
      return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]
    }
    const x = fs === 'r' ? Math.max(a.x, b.x) + out : Math.min(a.x, b.x) - out
    return [a, { x, y: a.y }, { x, y: b.y }, b]
  }
  return vertical(fs) ? [a, { x: a.x, y: b.y }, b] : [a, { x: b.x, y: a.y }, b]
}

function bez(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  }
}

function layout(root: HTMLElement, wires: Wire[], sizes: (LabelSize | null)[]): Drawn[] {
  const base = root.getBoundingClientRect()
  const rect = (id: string) => root.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect()
  type Plan = { i: number; w: Wire; A: DOMRect; B: DOMRect; fs: Side; ts: Side }
  const plans: Plan[] = []
  for (const [i, w] of wires.entries()) {
    const A = rect(w.from)
    const B = rect(w.to)
    if (!A || !B || !A.width || !B.width) continue
    const [fs0, ts0] = autoSides(A, B)
    plans.push({ i, w, A, B, fs: w.fromSide ?? fs0, ts: w.toSide ?? ts0 })
  }
  // Preferred port position for each wire end: where the two boxes overlap on the
  // shared axis, so the wire can run straight.
  const pref = (p: Plan, end: 'a' | 'b'): number | undefined => {
    const { A, B, fs, ts } = p
    if (fs === ts) return undefined
    const R = end === 'a' ? A : B
    if (vertical(fs) && vertical(ts)) {
      const lo = Math.max(A.left, B.left)
      const hi = Math.min(A.right, B.right)
      return hi - lo > 24 ? ((lo + hi) / 2 - R.left) / R.width : undefined
    }
    if (!vertical(fs) && !vertical(ts)) {
      const lo = Math.max(A.top, B.top)
      const hi = Math.min(A.bottom, B.bottom)
      return hi - lo > 16 ? ((lo + hi) / 2 - R.top) / R.height : undefined
    }
    return undefined
  }
  // Several wires on one side of a box: spread them in the order of their other ends,
  // but keep a wire straight when its preferred spot is free.
  const ports = new Map<string, { plan: Plan; end: 'a' | 'b'; other: DOMRect; box: DOMRect }[]>()
  for (const p of plans) {
    const ka = `${p.w.from}|${p.fs}`
    const kb = `${p.w.to}|${p.ts}`
    ports.set(ka, [...(ports.get(ka) ?? []), { plan: p, end: 'a', other: p.B, box: p.A }])
    ports.set(kb, [...(ports.get(kb) ?? []), { plan: p, end: 'b', other: p.A, box: p.B }])
  }
  const tOf = new Map<string, number>()
  const keyOf = (p: Plan, end: 'a' | 'b') => `${plans.indexOf(p)}${end}`
  for (const [k, list] of ports) {
    const side = k.split('|')[1] as Side
    const len = vertical(side) ? list[0].box.width : list[0].box.height
    if (list.length === 1) {
      const e = list[0]
      const t = pref(e.plan, e.end)
      if (t != null) tOf.set(keyOf(e.plan, e.end), t)
      continue
    }
    const c = (r: DOMRect) => (vertical(side) ? r.left + r.width / 2 : r.top + r.height / 2)
    list.sort((x, y) => c(x.other) - c(y.other))
    const n = list.length
    const step = Math.min(0.24, 0.72 / n)
    const ts = list.map((_, i) => 0.5 + (i - (n - 1) / 2) * step)
    list.forEach((e, i) => {
      const t = pref(e.plan, e.end)
      if (t != null && ts.every((u, j) => j === i || Math.abs(u - t) * len > 18)) ts[i] = t
    })
    list.forEach((e, i) => tOf.set(keyOf(e.plan, e.end), ts[i]))
  }

  return plans.map((p) => {
    const { i, w, A, B, fs, ts } = p
    let ta = tOf.get(keyOf(p, 'a'))
    let tb = tOf.get(keyOf(p, 'b'))
    // a straight wire must use the same coordinate at both ends
    if (ta != null && tb == null) tb = pref(p, 'b')
    if (tb != null && ta == null) ta = pref(p, 'a')
    const a = sidePoint(A, base, fs, ta)
    const b = sidePoint(B, base, ts, tb)
    const endDir = { x: -DIR[ts].x, y: -DIR[ts].y }
    const startDir = { x: -DIR[fs].x, y: -DIR[fs].y }
    const at = w.labelAt ?? 0.5
    const size = w.label != null ? sizes[i] : null
    let fit: Drawn['fit']
    const place = (pts: Pt[], fallback: Pt) => {
      if (!size || !size.w) return fallback
      const p = placeLabel(pts, size, at, w.arrow)
      fit = p.fit
      return p.c
    }
    if (w.route === 'curve') {
      const dist = Math.hypot(b.x - a.x, b.y - a.y)
      const k = Math.max(18, Math.min(90, dist * 0.45))
      const c1 = { x: a.x + DIR[fs].x * k, y: a.y + DIR[fs].y * k }
      const c2 = { x: b.x + DIR[ts].x * k, y: b.y + DIR[ts].y * k }
      const label = place(bezPoints(a, c1, c2, b), bez(a, c1, c2, b, at))
      return { i, w, d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, label, fit, end: b, endDir, start: a, startDir }
    }
    // snap near-straight runs so they don't show a tiny jog
    if (vertical(fs) && vertical(ts) && Math.abs(a.x - b.x) < 6) b.x = a.x
    if (!vertical(fs) && !vertical(ts) && Math.abs(a.y - b.y) < 6) b.y = a.y
    const pts = orthoPoints(a, fs, b, ts, w.bend ?? 0.5)
    const label = place(pts, along(pts, at))
    return { i, w, d: rounded(pts), label, fit, end: b, endDir, start: a, startDir }
  })
}

export function chevron(p: Pt, dir: Pt, s = 5.5) {
  const back = { x: -dir.x * s, y: -dir.y * s }
  const perp = { x: -dir.y * s * 0.62, y: dir.x * s * 0.62 }
  return `M${p.x + back.x + perp.x},${p.y + back.y + perp.y} L${p.x},${p.y} L${p.x + back.x - perp.x},${p.y + back.y - perp.y}`
}

export function wireStroke(w: Wire) {
  if (w.state === 'on') return toneColor(w.tone && w.tone !== 'neutral' ? w.tone : 'teal')
  return toneColor(w.tone ?? 'neutral', 'rgb(var(--ink) / 0.34)')
}

/**
 * Container that draws `wires` between descendants marked `data-node="id"`.
 * Wires sit behind the boxes; labels sit on top of the lines but never over an arrowhead
 * (see `Wire.labelAt`). `onLabelSizes` reports each wire's measured label size (null
 * without a label), so a layout can make room for them.
 */
export function Wired({
  wires,
  children,
  className,
  style,
  onLabelSizes,
}: {
  wires: Wire[]
  children: ReactNode
  className?: string
  style?: CSSProperties
  onLabelSizes?: (sizes: (LabelSize | null)[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState<Drawn[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const warnTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // width of wrapped labels, shrunk to their longest line (CSS keeps a wrapped box at its max-width)
  const [wrapW, setWrapW] = useState<Record<number, number>>({})
  const measure = useCallback(() => {
    const root = ref.current
    if (!root) return
    const tight: Record<number, number> = {}
    const sizes = wires.map((w, i) => {
      const el = w.label != null ? root.querySelector<HTMLElement>(`[data-wire-label="${i}"]`) : null
      if (!el) return null
      const text = el.firstElementChild
      if (w.labelWrap && text) {
        const rects = [...text.getClientRects()]
        if (new Set(rects.map((r) => Math.round(r.top))).size > 1) {
          const width = Math.ceil(Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left)))
          const chrome = el.offsetWidth - el.clientWidth + parseFloat(getComputedStyle(el).paddingLeft) * 2
          tight[i] = width + chrome
          return { w: tight[i], h: el.offsetHeight }
        }
      }
      return { w: el.offsetWidth, h: el.offsetHeight }
    })
    setWrapW((prev) => (JSON.stringify(prev) === JSON.stringify(tight) ? prev : tight))
    onLabelSizes?.(sizes)
    const next = layout(root, wires, sizes)
    setDrawn(next)
    setSize({ w: root.offsetWidth, h: root.offsetHeight })
    // warn about the layout once it has settled (a parent may still be making room)
    clearTimeout(warnTimer.current)
    warnTimer.current = setTimeout(() => warnLabels(next), 600)
  }, [wires, onLabelSizes])
  const placed = new Map(drawn.map((x) => [x.i, x]))

  useLayoutEffect(() => {
    measure()
    const root = ref.current
    if (!root) return
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(root)
    root.querySelectorAll('[data-node]').forEach((el) => ro.observe(el))
    document.fonts?.ready.then(schedule)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      clearTimeout(warnTimer.current)
    }
  }, [measure])

  return (
    <div ref={ref} className={cn('relative', className)} style={style}>
      <svg className="pointer-events-none absolute inset-0 z-0 overflow-visible" width={size.w} height={size.h} aria-hidden>
        {drawn.map((x, i) => {
          const stroke = wireStroke(x.w)
          const sw = x.w.state === 'on' ? 1.6 : 1.2
          const arrow = x.w.arrow ?? 'end'
          return (
            <g
              key={i}
              className="transition-opacity duration-300"
              style={{ opacity: x.w.state === 'dim' ? 0.28 : 1 }}
            >
              <path d={x.d} fill="none" stroke={stroke} strokeWidth={sw} strokeDasharray={x.w.dashed ? '3 4' : undefined} strokeLinecap="round" style={{ transition: 'stroke 300ms' }} />
              {arrow !== 'none' && (
                <path d={chevron(x.end, x.endDir)} fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
              )}
              {arrow === 'both' && (
                <path d={chevron(x.start, x.startDir)} fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
              )}
            </g>
          )
        })}
      </svg>
      {children}
      {/* every label is rendered, so its size can be measured before it is placed */}
      {wires.map((w, i) => {
        if (w.label == null) return null
        const x = placed.get(i)
        return (
          <span
            key={`l${i}`}
            data-wire-label={i}
            className={cn(
              'pointer-events-none absolute top-0 left-0 z-20 -translate-x-1/2 -translate-y-1/2 border border-line bg-frame px-2 py-[2px] text-[10.5px] leading-[14px] font-medium tracking-[0.07em] uppercase transition-[color,opacity] duration-300',
              w.labelWrap ? 'text-center text-balance' : 'max-w-[180px] truncate',
              wrapW[i] ? 'rounded-[10px]' : 'rounded-full',
            )}
            style={{
              maxWidth: w.labelWrap,
              width: wrapW[i],
              left: x?.label?.x,
              top: x?.label?.y,
              visibility: x?.label ? undefined : 'hidden',
              color: w.state === 'on' || (w.tone && w.tone !== 'neutral') ? wireStroke(w) : 'rgb(var(--ink) / 0.52)',
              opacity: w.state === 'dim' ? 0.4 : 1,
            }}
          >
            <span>{w.label}</span>
          </span>
        )
      })}
    </div>
  )
}

/* ─── DiagramFrame ────────────────────────────────────────────────────────── */

/**
 * The surface every diagram sits on: rounded sheer box, optional title and legend,
 * caption below. When the diagram is wider than the screen it scrolls inside the
 * frame (never the page) and says so.
 */
export function DiagramFrame({
  title,
  legend,
  caption,
  children,
  minWidth = 0,
  bare,
  padding = 'md',
  className,
  innerClassName,
}: {
  title?: ReactNode
  legend?: LegendItem[]
  caption?: ReactNode
  children: ReactNode
  /** Below this width the diagram scrolls horizontally inside the frame. */
  minWidth?: number
  /** No box: just the diagram, caption and scroll handling. */
  bare?: boolean
  padding?: 'sm' | 'md' | 'lg'
  className?: string
  innerClassName?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    // the inner box's layout width, so absolutely placed labels never count as overflow
    const check = () => setOverflow(((el.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0) > el.clientWidth + 2)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])
  const pad = padding === 'sm' ? 'p-3 md:p-4' : padding === 'lg' ? 'p-5 md:p-8' : 'p-4 md:p-6'
  return (
    <figure data-wide className={cn('min-w-0', className)}>
      {(title || legend) && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          {title ? <div className="eyebrow">{title}</div> : <span />}
          {legend && <Legend items={legend} />}
        </div>
      )}
      <div className={cn(!bare && 'rounded-[20px] border border-line bg-frame shadow-[inset_0_1px_0_rgb(var(--ink)/0.05)]', 'relative overflow-hidden')}>
        <div ref={scroller} className="kit-scroll" tabIndex={overflow ? 0 : undefined} aria-label={overflow ? 'Diagram, scrolls sideways' : undefined}>
          <div className={cn('kit-diagram', !bare && pad, innerClassName)} style={{ width: 'fit-content', minWidth: minWidth ? `max(100%, ${minWidth}px)` : '100%' }}>
            {children}
          </div>
        </div>
        {overflow && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-frame to-transparent" />
        )}
      </div>
      {(caption || overflow) && (
        <figcaption className="mt-3 flex items-baseline justify-between gap-4 text-[13px] leading-[1.5] text-quiet">
          <span className="text-pretty">{caption}</span>
          {overflow && <span className="shrink-0 text-faint">Scroll sideways →</span>}
        </figcaption>
      )}
    </figure>
  )
}
