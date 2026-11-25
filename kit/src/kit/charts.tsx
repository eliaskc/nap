/**
 * Chart wrappers on shadcn charts (Recharts). Import from '@/kit/charts' (kept out of
 * the main '@/kit' entry so pages without charts don't carry Recharts).
 * Colours come from the --chart-1…6 tokens unless a series sets `tone`.
 */
import { useMemo, type ReactNode } from 'react'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/kit/ui/chart'
import { cn, toneColor, type Tone } from './lib'
import { Legend } from './content'

export type Series = {
  key: string
  label?: ReactNode
  /** Default: the next --chart-N colour. */
  tone?: Tone
  /** Line charts: dashed line (forecast, target). */
  dashed?: boolean
}

type Common = {
  /** Rows of data, e.g. [{ month: 'Jan', a: 4, b: 7 }]. */
  data: Record<string, unknown>[]
  /** Key of the category / x value in each row. */
  x: string
  series: Series[]
  height?: number
  /** Appended to tick and tooltip values, e.g. "ms" or "%". */
  unit?: string
  /** Format tick and tooltip values. */
  format?: (v: number) => string
  title?: ReactNode
  caption?: ReactNode
  /** Horizontal reference line, e.g. a target. */
  reference?: { y: number; label?: string; tone?: Tone }
  /** Span the full content width. */
  wide?: boolean
  className?: string
}

/** Round tick values for a numeric axis. */
function niceTicks(lo: number, hi: number, count = 6) {
  const span = hi - lo || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10))
  return out
}

const colorOf = (s: Series, i: number) => (s.tone ? toneColor(s.tone) : `var(--chart-${(i % 6) + 1})`)

function useConfig(series: Series[]) {
  return useMemo(
    () => Object.fromEntries(series.map((s, i) => [s.key, { label: s.label ?? s.key, color: colorOf(s, i) }])) as ChartConfig,
    [series],
  )
}

function Frame({
  title,
  caption,
  series,
  wide,
  className,
  children,
}: {
  title?: ReactNode
  caption?: ReactNode
  series?: Series[]
  wide?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <figure data-wide={wide || undefined} className={cn('min-w-0', className)}>
      {(title || (series && series.length > 1)) && (
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          {title ? <div className="eyebrow">{title}</div> : <span />}
          {series && series.length > 1 && (
            <Legend items={series.map((s, i) => ({ label: s.label ?? s.key, color: colorOf(s, i), kind: s.dashed ? 'dashed' : 'dot' }))} />
          )}
        </div>
      )}
      {children}
      {caption && <figcaption className="mt-3 text-[13px] leading-[1.5] text-quiet">{caption}</figcaption>}
    </figure>
  )
}

const axisTick = { fontSize: 11.5, fill: 'rgb(var(--ink) / 0.48)' }

function fmt(format?: (v: number) => string, unit?: string) {
  return (v: unknown) => (typeof v === 'number' ? (format ? format(v) : v.toLocaleString()) + (unit ?? '') : String(v))
}

function Ref({ reference }: { reference?: Common['reference'] }) {
  if (!reference) return null
  const c = toneColor(reference.tone ?? 'neutral', 'rgb(var(--ink) / 0.45)')
  return (
    <ReferenceLine
      y={reference.y}
      stroke={c}
      strokeDasharray="4 4"
      label={reference.label ? { value: reference.label, position: 'insideTopRight', fill: c, fontSize: 11 } : undefined}
    />
  )
}

/* ─── BarChart ────────────────────────────────────────────────────────────── */

/** Bars per category; several series group side by side, or stack with `stacked`. */
export function BarChart({ stacked, horizontal, ...p }: Common & { stacked?: boolean; horizontal?: boolean }) {
  const config = useConfig(p.series)
  const f = fmt(p.format, p.unit)
  const n = p.series.length
  return (
    <Frame title={p.title} caption={p.caption} series={p.series} wide={p.wide} className={p.className}>
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height: p.height ?? (horizontal ? p.data.length * 34 + 30 : 240) }}>
        <ComposedChart data={p.data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 8, left: horizontal ? 8 : -8, bottom: 0 }} barCategoryGap={horizontal ? '24%' : '22%'}>
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="rgb(var(--ink) / 0.08)" strokeDasharray="2 4" />
          {horizontal ? (
            <>
              <XAxis type="number" tickLine={false} axisLine={false} tick={axisTick} tickFormatter={f} />
              <YAxis type="category" dataKey={p.x} tickLine={false} axisLine={false} tick={{ ...axisTick, fill: 'rgb(var(--ink) / 0.7)' }} width={110} />
            </>
          ) : (
            <>
              <XAxis dataKey={p.x} tickLine={false} axisLine={false} tick={axisTick} tickMargin={8} interval="preserveStartEnd" />
              <YAxis tickLine={false} axisLine={false} tick={axisTick} tickFormatter={f} width={p.unit ? 64 : 48} />
            </>
          )}
          <ChartTooltip isAnimationActive={false} cursor={{ fill: 'rgb(var(--ink) / 0.04)' }} content={<ChartTooltipContent formatter={undefined} />} />
          {p.series.map((s, i) => {
            const top = !stacked || i === n - 1
            const r = 3
            const radius: [number, number, number, number] = !top ? [0, 0, 0, 0] : horizontal ? [0, r, r, 0] : [r, r, 0, 0]
            return (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.key}
                stackId={stacked ? 'a' : undefined}
                fill={`var(--color-${s.key})`}
                radius={radius}
                maxBarSize={horizontal ? 18 : 44}
                isAnimationActive={false}
              />
            )
          })}
          <Ref reference={p.reference} />
        </ComposedChart>
      </ChartContainer>
    </Frame>
  )
}

/* ─── LineChart ───────────────────────────────────────────────────────────── */

/** Lines over an ordered x (time). `area` fills under each line; `stacked` stacks the areas. */
export function LineChart({ area, stacked, dots, ...p }: Common & { area?: boolean; stacked?: boolean; dots?: boolean }) {
  const config = useConfig(p.series)
  const f = fmt(p.format, p.unit)
  return (
    <Frame title={p.title} caption={p.caption} series={p.series} wide={p.wide} className={p.className}>
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height: p.height ?? 240 }}>
        <ComposedChart data={p.data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <defs>
            {p.series.map((s) => (
              <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`var(--color-${s.key})`} stopOpacity={0.22} />
                <stop offset="100%" stopColor={`var(--color-${s.key})`} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke="rgb(var(--ink) / 0.08)" strokeDasharray="2 4" />
          <XAxis dataKey={p.x} tickLine={false} axisLine={false} tick={axisTick} tickMargin={8} minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} tick={axisTick} tickFormatter={f} width={p.unit ? 64 : 48} />
          <ChartTooltip isAnimationActive={false} cursor={{ stroke: 'rgb(var(--ink) / 0.2)' }} content={<ChartTooltipContent indicator="line" />} />
          {p.series.map((s) =>
            area ? (
              <Area
                key={s.key}
                dataKey={s.key}
                type="monotone"
                stackId={stacked ? 'a' : undefined}
                stroke={`var(--color-${s.key})`}
                strokeWidth={1.6}
                strokeDasharray={s.dashed ? '4 4' : undefined}
                fill={`url(#fill-${s.key})`}
                dot={false}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={s.key}
                dataKey={s.key}
                type="monotone"
                stroke={`var(--color-${s.key})`}
                strokeWidth={1.75}
                strokeDasharray={s.dashed ? '4 4' : undefined}
                dot={dots ? { r: 2.5, strokeWidth: 0, fill: `var(--color-${s.key})` } : false}
                activeDot={{ r: 3.5, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            ),
          )}
          <Ref reference={p.reference} />
        </ComposedChart>
      </ChartContainer>
    </Frame>
  )
}

/* ─── Histogram ───────────────────────────────────────────────────────────── */

/** Distribution of raw values in equal-width bins. Optional markers (median, threshold). */
export function Histogram({
  values,
  bins = 20,
  domain,
  tone,
  unit,
  format,
  height = 200,
  markers = [],
  title,
  caption,
  wide,
  className,
}: {
  values: number[]
  bins?: number
  /** [min, max]; default from the data. */
  domain?: [number, number]
  tone?: Tone
  unit?: string
  format?: (v: number) => string
  height?: number
  markers?: Array<{ x: number; label?: string; tone?: Tone }>
  title?: ReactNode
  caption?: ReactNode
  wide?: boolean
  className?: string
}) {
  const data = useMemo(() => {
    const lo = domain?.[0] ?? Math.min(...values)
    const hi = domain?.[1] ?? Math.max(...values)
    const w = (hi - lo) / bins || 1
    const out = Array.from({ length: bins }, (_, i) => ({ x0: lo + i * w, mid: lo + (i + 0.5) * w, count: 0 }))
    for (const v of values) {
      const i = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)))
      out[i].count++
    }
    return out
  }, [values, bins, domain])
  const f = fmt(format ?? ((v) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(+v.toFixed(1)))), unit)
  const config = { count: { label: 'Count', color: tone ? toneColor(tone) : 'var(--chart-1)' } } satisfies ChartConfig
  return (
    <Frame title={title} caption={caption} wide={wide} className={className}>
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
        <ComposedChart data={data} margin={{ top: 14, right: 8, left: -14, bottom: 0 }} barCategoryGap={1}>
          <CartesianGrid vertical={false} stroke="rgb(var(--ink) / 0.08)" strokeDasharray="2 4" />
          <XAxis dataKey="mid" type="number" domain={[data[0]?.x0 ?? 0, (data.at(-1)?.x0 ?? 0) + (data[1]?.x0 - data[0]?.x0 || 1)]} ticks={niceTicks(data[0]?.x0 ?? 0, (data.at(-1)?.x0 ?? 0) + (data[1]?.x0 - data[0]?.x0 || 1))} tickLine={false} axisLine={false} tick={axisTick} tickFormatter={f} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} tick={axisTick} width={44} allowDecimals={false} />
          <ChartTooltip isAnimationActive={false} cursor={{ fill: 'rgb(var(--ink) / 0.04)' }} content={<ChartTooltipContent labelFormatter={(_, pl) => { const d = pl?.[0]?.payload as { x0: number } | undefined; return d ? `${f(d.x0)} – ${f(d.x0 + (data[1]?.x0 - data[0]?.x0 || 0))}` : '' }} />} />
          <Bar dataKey="count" fill="var(--color-count)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
          {markers.map((m, i) => {
            const c = toneColor(m.tone ?? 'neutral', 'rgb(var(--ink) / 0.55)')
            return <ReferenceLine key={i} x={m.x} stroke={c} strokeDasharray="3 3" label={m.label ? { value: m.label, position: 'top', fill: c, fontSize: 11 } : undefined} />
          })}
        </ComposedChart>
      </ChartContainer>
    </Frame>
  )
}
