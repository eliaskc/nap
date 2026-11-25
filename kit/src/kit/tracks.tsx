import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn, toneColor, toneMix, useWidth, type Tone } from './lib'
import { Diamond, PlusIcon, Reveal, type LegendItem } from './content'
import { chevron, rounded } from './wires'
import { Legend } from './content'

export type TrackItem = { title: ReactNode; sub?: ReactNode; extra?: ReactNode; detail?: ReactNode }
export type Track = {
  id: string
  /** One or two characters in the circle: 0, A, B, C… */
  badge?: ReactNode
  title: ReactNode
  /** Quiet text at the right of the header: an outcome, a cost, an owner. */
  meta?: ReactNode
  tone?: Tone
  items?: TrackItem[]
  /** Closing line with a diamond: the milestone the track ends in. */
  outcome?: ReactNode
  /** Planned or optional track: dashed outline. */
  ghost?: boolean
}

/**
 * Parallel workstreams with dependencies. Each stage is a row of tracks that run
 * in parallel; every stage needs the one before it. E.g. [[0], [A, B], [C]] draws
 * a full-width 0, then A ∥ B, then a full-width C, joined by labelled connectors.
 * On phones the stages stack and parallel tracks are bracketed.
 */
export function Tracks({
  stages,
  joins = [],
  title,
  caption,
  legend,
  className,
}: {
  stages: Track[][]
  /** Label on the connector into stage i+1, e.g. "needs 0" or "needs A + B". */
  joins?: ReactNode[]
  title?: ReactNode
  caption?: ReactNode
  legend?: LegendItem[]
  className?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const stacked = width > 0 && width < 640

  return (
    <figure data-wide ref={ref} className={cn('min-w-0', className)}>
      {(title || legend) && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          {title ? <div className="eyebrow">{title}</div> : <span />}
          {legend && <Legend items={legend} />}
        </div>
      )}
      {stacked ? (
        <div className="flex flex-col">
          {stages.map((stage, si) => (
            <Fragment key={si}>
              {si > 0 && <StackJoin label={joins[si - 1]} />}
              {stage.length > 1 ? (
                <div className="rounded-[22px] border border-dashed border-line-strong p-2">
                  <div className="eyebrow px-2 pt-1 pb-2 text-[10.5px]">In parallel</div>
                  <div className="flex flex-col gap-2">
                    {stage.map((t) => (
                      <TrackCard key={t.id} t={t} row={false} />
                    ))}
                  </div>
                </div>
              ) : (
                stage.map((t) => <TrackCard key={t.id} t={t} row={false} />)
              )}
            </Fragment>
          ))}
        </div>
      ) : (
        <Bus stages={stages}>
          {stages.map((stage, si) => (
            <Fragment key={si}>
              {si > 0 && (
                <div data-gap={si} className="flex h-[76px] items-center justify-center">
                  <span className="relative z-10 rounded-full border border-line bg-bg px-2.5 py-[3px] text-[10.5px] font-medium tracking-[0.1em] whitespace-nowrap text-quiet uppercase">
                    {joins[si - 1] ?? 'then'}
                  </span>
                </div>
              )}
              <div className="grid items-start gap-4" style={{ gridTemplateColumns: `repeat(${stage.length}, minmax(0, 1fr))` }}>
                {stage.map((t) => (
                  <div key={t.id} data-track={t.id} className="relative z-10 min-w-0">
                    <TrackCard t={t} row={stage.length === 1} />
                  </div>
                ))}
              </div>
            </Fragment>
          ))}
        </Bus>
      )}
      {caption && <figcaption className="mt-3 text-[13px] leading-[1.5] text-quiet">{caption}</figcaption>}
    </figure>
  )
}

/** Draws the connectors between stages: stubs down from each track into a bus, then down into the next stage. */
function Bus({ stages, children }: { stages: Track[][]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<{ d: string; color: string; head?: string }[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const measure = () => {
      const base = root.getBoundingClientRect()
      const r = (sel: string) => root.querySelector<HTMLElement>(sel)?.getBoundingClientRect()
      const out: { d: string; color: string; head?: string }[] = []
      stages.forEach((stage, si) => {
        if (si === 0) return
        const gap = r(`[data-gap="${si}"]`)
        if (!gap) return
        const y = gap.top + gap.height / 2 - base.top
        const cx = gap.left + gap.width / 2 - base.left
        const color = (t: Track) => toneColor(t.tone ?? 'neutral', 'rgb(var(--ink) / 0.3)')
        for (const t of stages[si - 1]) {
          const b = r(`[data-track="${CSS.escape(t.id)}"]`)
          if (!b) continue
          const x = b.left + b.width / 2 - base.left
          out.push({ d: rounded([{ x, y: b.bottom - base.top }, { x, y }, { x: cx, y }], 12), color: color(t) })
        }
        for (const t of stage) {
          const b = r(`[data-track="${CSS.escape(t.id)}"]`)
          if (!b) continue
          const x = b.left + b.width / 2 - base.left
          const end = { x, y: b.top - base.top }
          out.push({ d: rounded([{ x: cx, y }, { x, y }, end], 12), color: color(t), head: chevron(end, { x: 0, y: 1 }) })
        }
      })
      setPaths(out)
      setSize({ w: root.offsetWidth, h: root.offsetHeight })
    }
    measure()
    const ro = new ResizeObserver(() => requestAnimationFrame(measure))
    ro.observe(root)
    root.querySelectorAll('[data-track]').forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [stages])
  return (
    <div ref={ref} className="relative flex flex-col">
      <svg className="pointer-events-none absolute inset-0 overflow-visible" width={size.w} height={size.h} aria-hidden>
        {paths.map((p, i) => (
          <g key={i} fill="none" stroke={p.color} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
            <path d={p.d} />
            {p.head && <path d={p.head} />}
          </g>
        ))}
      </svg>
      {children}
    </div>
  )
}

function StackJoin({ label }: { label?: ReactNode }) {
  return (
    <div className="relative flex h-14 items-center justify-center">
      <span aria-hidden className="absolute inset-y-0 left-1/2 border-l border-line-strong" />
      {label && (
        <span className="relative rounded-full border border-line bg-bg px-2.5 py-[3px] text-[10.5px] font-medium tracking-[0.1em] text-quiet uppercase">
          {label}
        </span>
      )}
    </div>
  )
}

function TrackCard({ t, row }: { t: Track; row: boolean }) {
  const tone = t.tone ?? 'neutral'
  const [open, setOpen] = useState<number | null>(null)
  const items = t.items ?? []
  return (
    <div
      className={cn('overflow-hidden rounded-[20px] border bg-paper', t.ghost && 'border-dashed')}
      style={{ borderColor: t.ghost ? 'rgb(var(--ink) / 0.2)' : 'rgb(var(--ink) / 0.12)' }}
    >
      <div className="flex items-center gap-3.5 px-4 py-4 md:px-5">
        {t.badge != null && (
          <span
            className="grid size-8 shrink-0 place-items-center rounded-full border text-[13px] font-medium"
            style={{ borderColor: toneMix(tone, 60), color: toneColor(tone, 'rgb(var(--ink) / 0.75)') }}
          >
            {t.badge}
          </span>
        )}
        <div className="min-w-0 flex-1 text-[18px] leading-[1.3] font-normal tracking-[-0.01em] text-value md:text-[19px]">{t.title}</div>
        {t.meta && (
          <div className="shrink-0 text-right text-[12.5px] leading-[1.35] text-quiet" style={tone !== 'neutral' ? { color: toneColor(tone) } : undefined}>
            {t.meta}
          </div>
        )}
      </div>
      {items.length > 0 && (
        <ol
          className={cn('border-t border-line', row ? 'grid' : 'flex flex-col')}
          style={row ? { gridTemplateColumns: `repeat(${Math.min(items.length, 5)}, minmax(0, 1fr))` } : undefined}
        >
          {items.map((it, i) => {
            const isOpen = open === i
            return (
              <li
                key={i}
                className={cn('min-w-0 px-4 py-3.5 md:px-5', row ? i > 0 && 'border-l border-line' : i > 0 && 'border-t border-line')}
              >
                <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] gap-x-2">
                  <span className="tnum pt-[1.5px] text-[11.5px] text-faint">{String(i + 1).padStart(2, '0')}</span>
                  <div className="min-w-0">
                    {it.detail ? (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setOpen(isOpen ? null : i)}
                        className="block cursor-pointer text-left text-[14px] leading-[1.35] font-medium text-strong decoration-line-strong underline-offset-4 hover:underline"
                      >
                        {it.title}
                      </button>
                    ) : (
                      <div className="text-[14px] leading-[1.35] font-medium text-strong">{it.title}</div>
                    )}
                    {it.sub && <div className="mt-1 text-[12.5px] leading-[1.45] text-quiet">{it.sub}</div>}
                    {it.extra && <div className="mt-2">{it.extra}</div>}
                  </div>
                  {it.detail ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      onClick={() => setOpen(isOpen ? null : i)}
                      className="cursor-pointer pt-[3px] text-quiet hover:text-strong"
                    >
                      <PlusIcon open={isOpen} />
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
                {it.detail && (
                  <Reveal open={isOpen}>
                    <div className="pt-3 pl-[30px] text-[13.5px] leading-[1.55] text-body">{it.detail}</div>
                  </Reveal>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {t.outcome && (
        <div
          className="flex items-start gap-3 border-t border-line px-4 py-3.5 text-[13.5px] leading-[1.45] md:px-5"
          style={{ color: toneColor(tone, 'rgb(var(--ink) / 0.85)') }}
        >
          <Diamond filled className="mt-[4px]" />
          <span>{t.outcome}</span>
        </div>
      )}
    </div>
  )
}
