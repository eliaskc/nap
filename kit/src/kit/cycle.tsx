import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn, toneColor, toneMix, useWidth, type Tone } from './lib'
import { DiagramFrame } from './wires'

export type CycleStep = { title: ReactNode; sub?: ReactNode; tone?: Tone }

/**
 * A process that returns to its start: steps on a ring with arrows between them,
 * an optional label in the middle. Below ~520px it becomes a vertical list with a
 * return rail, so it stays readable on phones.
 */
export function Cycle({
  steps,
  center,
  active,
  title,
  caption,
  className,
}: {
  steps: CycleStep[]
  /** Text in the middle of the ring, e.g. "every sprint". */
  center?: ReactNode
  /** Index of the step to emphasise. */
  active?: number
  title?: ReactNode
  caption?: ReactNode
  className?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const n = steps.length
  const ring = width >= 520
  return (
    <DiagramFrame title={title} caption={caption} className={className}>
      <div ref={ref}>{width > 0 && (ring ? <Ring steps={steps} center={center} active={active} size={Math.min(width, 540)} /> : <Column steps={steps} center={center} active={active} n={n} />)}</div>
    </DiagramFrame>
  )
}

function StepBox({ s, i, active, className }: { s: CycleStep; i: number; active?: number; className?: string }) {
  const on = active === i
  const tone = s.tone ?? (on ? 'teal' : 'neutral')
  return (
    <div
      className={cn('rounded-[12px] border bg-paper px-3 py-2.5 transition-[opacity,border-color] duration-300', className)}
      style={{
        borderColor: on ? toneColor(tone) : tone !== 'neutral' ? toneMix(tone, 45) : 'rgb(var(--ink) / 0.15)',
        boxShadow: on ? `0 0 0 3px ${toneMix(tone, 14)}` : undefined,
      }}
    >
      <div className="flex items-baseline gap-2">
        <span className="tnum text-[11px] text-faint">{String(i + 1).padStart(2, '0')}</span>
        <span className="text-[13.5px] leading-[1.3] font-medium text-strong">{s.title}</span>
      </div>
      {s.sub && <div className="mt-1 pl-[22px] text-[12px] leading-[1.42] text-quiet">{s.sub}</div>}
    </div>
  )
}

function Ring({ steps, center, active, size }: { steps: CycleStep[]; center?: ReactNode; active?: number; size: number }) {
  const n = steps.length
  const R = n <= 4 ? 36 : 40 // % of the square
  const boxW = n <= 4 ? 34 : n <= 6 ? 26 : 22 // % of the square
  const boxes = useRef<(HTMLDivElement | null)[]>([])
  const [heights, setHeights] = useState<number[]>([])
  useLayoutEffect(() => {
    const read = () => setHeights(boxes.current.map((b) => b?.offsetHeight ?? 64))
    read()
    const ro = new ResizeObserver(read)
    boxes.current.forEach((b) => b && ro.observe(b))
    return () => ro.disconnect()
  }, [n, size])
  const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n
  const pt = (a: number) => ({ x: 50 + R * Math.cos(a), y: 50 + R * Math.sin(a) })
  // angle to leave clear on each side of a box so arcs start just outside it
  const clear = (i: number) => {
    const c = pt(ang(i))
    const hw = boxW / 2 + 2.2
    const hh = ((heights[i] ?? 64) / size) * 50 + 2.2 // half the box height, in %
    for (let d = 0; d < Math.PI / n; d += 0.005) {
      const q = pt(ang(i) + d)
      if (Math.abs(q.x - c.x) > hw || Math.abs(q.y - c.y) > hh) return d
    }
    return Math.PI / n - 0.05
  }
  return (
    <div className="relative mx-auto aspect-square w-full" style={{ maxWidth: size }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible" aria-hidden>
        {steps.map((_, i) => {
          const a0 = ang(i) + clear(i)
          const a1 = ang(i + 1) - clear((i + 1) % n)
          const p0 = pt(a0)
          const p1 = pt(a1)
          const large = a1 - a0 > Math.PI ? 1 : 0
          const on = active === i
          const color = on ? 'var(--teal)' : 'rgb(var(--ink) / 0.32)'
          const t = { x: -Math.sin(a1), y: Math.cos(a1) }
          const nrm = { x: Math.cos(a1), y: Math.sin(a1) }
          const k = 1.3
          const head = `M${p1.x - t.x * k + nrm.x * k * 0.7},${p1.y - t.y * k + nrm.y * k * 0.7} L${p1.x},${p1.y} L${p1.x - t.x * k - nrm.x * k * 0.7},${p1.y - t.y * k - nrm.y * k * 0.7}`
          return (
            <g key={i} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'stroke 300ms' }}>
              <path d={`M${p0.x},${p0.y} A${R},${R} 0 ${large} 1 ${p1.x},${p1.y}`} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 1.25 }} />
              <path d={head} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 1.25 }} />
            </g>
          )
        })}
      </svg>
      {center && (
        <div className="absolute top-1/2 left-1/2 w-[30%] -translate-x-1/2 -translate-y-1/2 text-center text-[14px] leading-[1.35] text-quiet">
          <span className="mb-1 block text-[18px] text-faint">↻</span>
          {center}
        </div>
      )}
      {steps.map((s, i) => {
        const p = pt(ang(i))
        return (
          <div
            key={i}
            ref={(el) => {
              boxes.current[i] = el
            }}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${boxW}%` }}
          >
            <StepBox s={s} i={i} active={active} />
          </div>
        )
      })}
    </div>
  )
}

function Column({ steps, center, active }: { steps: CycleStep[]; center?: ReactNode; active?: number; n: number }) {
  return (
    <div className="relative pl-7">
      {/* return rail: from the last step back up to the first */}
      <span aria-hidden className="absolute top-[22px] bottom-[22px] left-[6px] w-[14px] rounded-l-[12px] border-y border-l border-dashed border-line-strong" />
      <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className="absolute top-[17px] left-[15px]">
        <path d="M2 1.5 L7 5 L2 8.5" fill="none" stroke="rgb(var(--ink) / 0.4)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={i} className="relative">
            <StepBox s={s} i={i} active={active} />
          </li>
        ))}
      </ol>
      {center && <div className="mt-3 text-[13px] text-quiet">↺ {center}</div>}
    </div>
  )
}
