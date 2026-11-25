import { type ReactNode } from 'react'
import { cn, toneColor, toneMix, useWidth, type Tone } from './lib'

export type TimelineItem = {
  date: ReactNode
  title: ReactNode
  body?: ReactNode
  /** done: filled · now: ringed and accented · next: hollow · risk: warn colour */
  state?: 'done' | 'now' | 'next' | 'risk'
  tone?: Tone
}

/**
 * Dated events or milestones. Horizontal axis when there is room (up to `maxAcross`
 * items), otherwise a vertical list with dates on the left.
 */
export function Timeline({
  items,
  layout = 'auto',
  maxAcross = 6,
  className,
}: {
  items: TimelineItem[]
  layout?: 'auto' | 'horizontal' | 'vertical'
  maxAcross?: number
  className?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const across = layout === 'horizontal' || (layout === 'auto' && items.length <= maxAcross && width >= items.length * 128)
  return (
    <div ref={ref} data-wide={layout !== 'vertical' || undefined} className={cn('min-w-0', className)}>
      {width > 0 && (across ? <Across items={items} /> : <Down items={items} />)}
    </div>
  )
}

function Dot({ it }: { it: TimelineItem }) {
  const state = it.state ?? 'done'
  const tone: Tone = it.tone ?? (state === 'now' ? 'teal' : state === 'risk' ? 'warn' : 'neutral')
  const c = toneColor(tone, 'rgb(var(--ink) / 0.55)')
  return (
    <span className="relative grid size-[15px] shrink-0 place-items-center rounded-full bg-bg">
      {state === 'now' && <span className="absolute inset-0 rounded-full" style={{ boxShadow: `0 0 0 4px ${toneMix(tone, 18)}` }} />}
      <span
        className={cn('size-[9px] rounded-full border-[1.5px]', state === 'next' && 'border-dashed')}
        style={{ borderColor: c, background: state === 'next' ? 'var(--bg)' : c }}
      />
    </span>
  )
}

function Down({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="relative">
      {items.map((it, i) => (
        <li key={i} className="relative grid grid-cols-[minmax(64px,92px)_15px_minmax(0,1fr)] gap-x-4 pb-6 last:pb-0">
          <div className="tnum pt-[1px] text-right text-[12.5px] leading-[1.4] text-quiet">{it.date}</div>
          <div className="relative pt-[2px]">
            <Dot it={it} />
            {i < items.length - 1 && (
              <span
                aria-hidden
                className={cn('absolute top-[21px] -bottom-[20px] left-[7px] w-0 border-l', items[i + 1].state === 'next' ? 'border-dashed border-line-strong' : 'border-line-strong')}
              />
            )}
          </div>
          <div className={cn('min-w-0', it.state === 'next' && 'opacity-75')}>
            <div className="text-[15px] leading-[1.35] font-medium text-strong" style={it.state === 'now' ? { color: 'var(--value)' } : undefined}>
              {it.title}
            </div>
            {it.body && <div className="mt-1 text-[14px] leading-[1.55] text-quiet">{it.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

function Across({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((it, i) => (
        <li key={i} className={cn('relative min-w-0 pr-5', it.state === 'next' && '[&>.tl-body]:opacity-75')}>
          <div className="tnum mb-3 text-[12.5px] text-quiet">{it.date}</div>
          <div className="relative mb-3.5 flex items-center">
            <Dot it={it} />
            {i < items.length - 1 && (
              <span
                aria-hidden
                className={cn('ml-2 h-0 flex-1 border-t', items[i + 1].state === 'next' ? 'border-dashed border-line-strong' : 'border-line-strong')}
              />
            )}
          </div>
          <div className="tl-body">
            <div className="text-[14.5px] leading-[1.35] font-medium text-strong">{it.title}</div>
            {it.body && <div className="mt-1 text-[13px] leading-[1.5] text-quiet">{it.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}
