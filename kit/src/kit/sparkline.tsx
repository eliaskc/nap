import { useId } from 'react'
import { cn, toneColor, type Tone } from './lib'

/**
 * Tiny inline trend line (no axes). Fits text: put it next to a Stat or in a table cell.
 * Draws to the width of its box; set `width` for a fixed size.
 */
export function Sparkline({
  values,
  tone = 'teal',
  height = 28,
  width,
  area = true,
  dot = true,
  className,
}: {
  values: number[]
  tone?: Tone
  height?: number
  /** Fixed width in px. Default: 100% of the parent (min 60px). */
  width?: number
  area?: boolean
  /** Dot on the last value. */
  dot?: boolean
  className?: string
}) {
  const id = useId().replace(/:/g, '')
  if (values.length < 2) return null
  const W = 100
  const H = height
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pad = 2.5
  const y = (v: number) => (hi === lo ? H / 2 : pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2))
  const x = (i: number) => (i / (values.length - 1)) * W
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
  const c = toneColor(tone)
  const last = values.length - 1
  return (
    <span className={cn('relative inline-block min-w-[60px] align-middle', !width && 'w-full', className)} style={{ width, height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
        <defs>
          <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={c} stopOpacity="0.22" />
            <stop offset="1" stopColor={c} stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#sp${id})`} />}
        <path d={d} fill="none" stroke={c} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {dot && (
        <span
          className="absolute size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${(x(last) / W) * 100}%`, top: y(values[last]), background: c }}
        />
      )}
    </span>
  )
}
