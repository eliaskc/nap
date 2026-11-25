import { type ReactNode } from 'react'
import { cn, toneColor, toneMix, type Tone } from './lib'
import { DiagramFrame } from './wires'
import type { LegendItem } from './content'

export type Participant = { id: string; label: ReactNode; sub?: ReactNode; tone?: Tone }

export type SequenceItem =
  | {
      from: string
      to: string
      label: ReactNode
      /** call (solid, filled head) · reply (dashed) · async (solid, open head) */
      kind?: 'call' | 'reply' | 'async'
      tone?: Tone
      /** Small quiet text under the label. */
      sub?: ReactNode
    }
  | { note: ReactNode; over: string[]; tone?: Tone }
  | { divider: ReactNode }

/**
 * Sequence diagram: participants across the top, messages down the page.
 * Message rows size to their labels, so long labels wrap instead of colliding.
 */
export function Sequence({
  participants,
  items,
  active,
  numbered,
  title,
  caption,
  legend,
  minWidth,
  className,
}: {
  participants: Participant[]
  items: SequenceItem[]
  /** Index into `items` to emphasise (others dim). Useful with StageSwitcher or ScrollStory. */
  active?: number
  /** Number the messages. */
  numbered?: boolean
  title?: ReactNode
  caption?: ReactNode
  legend?: LegendItem[]
  minWidth?: number
  className?: string
}) {
  const n = participants.length
  const idx = (id: string) => participants.findIndex((p) => p.id === id)
  const cx = (i: number) => ((i + 0.5) / n) * 100
  let msgNo = 0

  return (
    <DiagramFrame title={title} caption={caption} legend={legend} minWidth={minWidth ?? n * 132} className={className}>
      <div className="relative">
        {/* lifelines */}
        {participants.map((p, i) => (
          <span
            key={p.id}
            aria-hidden
            className="absolute top-8 bottom-0 w-0 border-l border-dashed"
            style={{ left: `${cx(i)}%`, borderColor: p.tone ? toneMix(p.tone, 40) : 'rgb(var(--ink) / 0.16)' }}
          />
        ))}
        {/* participants */}
        <div className="relative grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(min-content, 1fr))` }}>
          {participants.map((p) => (
            <div key={p.id} className="flex justify-center px-1.5">
              <div
                className="relative z-10 max-w-full rounded-[12px] border bg-paper px-3 py-2 text-center"
                style={{ borderColor: p.tone ? toneMix(p.tone, 50) : 'rgb(var(--ink) / 0.15)' }}
              >
                <div className="text-[13px] leading-[1.3] font-medium text-strong" style={p.tone ? { color: toneColor(p.tone) } : undefined}>
                  {p.label}
                </div>
                {p.sub && <div className="mt-0.5 text-[11.5px] leading-[1.35] text-quiet">{p.sub}</div>}
              </div>
            </div>
          ))}
        </div>
        {/* rows */}
        <ol className="relative mt-3 pb-3">
          {items.map((it, i) => {
            const dim = active != null && active !== i
            if ('divider' in it)
              return (
                <li key={i} className="relative my-3 flex items-center justify-center">
                  <span aria-hidden className="absolute inset-x-0 top-1/2 border-t border-line-strong" />
                  <span className="relative rounded-full border border-line bg-frame px-3 py-[2px] text-[10.5px] font-medium tracking-[0.1em] text-quiet uppercase">
                    {it.divider}
                  </span>
                </li>
              )
            if ('note' in it) {
              const xs = it.over.map(idx).filter((x) => x >= 0)
              const lo = Math.min(...xs)
              const hi = Math.max(...xs)
              const left = lo === hi ? cx(lo) - 50 / n : cx(lo) - 30 / n
              const right = lo === hi ? cx(lo) + 50 / n : cx(hi) + 30 / n
              return (
                <li key={i} className="relative my-2 transition-opacity duration-300" style={{ opacity: dim ? 0.35 : 1 }}>
                  <div
                    className="relative z-10 rounded-[10px] border px-3 py-1.5 text-center text-[12px] leading-[1.45] text-body"
                    style={{
                      marginLeft: `${Math.max(0, left)}%`,
                      width: `${Math.min(100, right) - Math.max(0, left)}%`,
                      borderColor: it.tone ? toneMix(it.tone, 40) : 'rgb(var(--ink) / 0.14)',
                      background: it.tone ? `linear-gradient(${toneMix(it.tone, 8)}, ${toneMix(it.tone, 8)}), var(--paper)` : 'var(--paper)',
                    }}
                  >
                    {it.note}
                  </div>
                </li>
              )
            }
            msgNo++
            const a = idx(it.from)
            const b = idx(it.to)
            const color = toneColor(it.tone ?? 'neutral', 'rgb(var(--ink) / 0.5)')
            const kind = it.kind ?? 'call'
            const label = (
              <>
                {numbered && <span className="tnum mr-1.5 text-faint">{msgNo}</span>}
                {it.label}
              </>
            )
            if (a === b) {
              return (
                <li key={i} className="relative py-1.5 transition-opacity duration-300" style={{ opacity: dim ? 0.3 : 1 }}>
                  <div className="relative flex items-start" style={{ marginLeft: `${cx(a)}%` }}>
                    <svg width="30" height="30" className="shrink-0" aria-hidden>
                      <path d="M0 6 H22 Q26 6 26 10 V20 Q26 24 22 24 H4" fill="none" stroke={color} strokeWidth="1.2" />
                      <path d="M8 20.5 L3.5 24 L8 27.5" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                    <div className="max-w-[46%] pl-2 text-[12.5px] leading-[1.35] text-strong">
                      {label}
                      {it.sub && <div className="text-[11.5px] text-quiet">{it.sub}</div>}
                    </div>
                  </div>
                </li>
              )
            }
            const lo = Math.min(a, b)
            const hi = Math.max(a, b)
            const rightward = b > a
            return (
              <li key={i} className="relative py-1.5 transition-opacity duration-300" style={{ opacity: dim ? 0.3 : 1 }}>
                <div className="relative" style={{ marginLeft: `${cx(lo)}%`, width: `${cx(hi) - cx(lo)}%` }}>
                  <div className={cn('px-3 pb-1 text-center text-[12.5px] leading-[1.35]', it.tone ? '' : 'text-strong')} style={it.tone ? { color } : undefined}>
                    {label}
                    {it.sub && <div className="text-[11.5px] text-quiet">{it.sub}</div>}
                  </div>
                  <div className="relative h-[9px]">
                    <span
                      aria-hidden
                      className="absolute inset-x-0 top-1/2 border-t-[1.25px]"
                      style={{ borderColor: color, borderStyle: kind === 'reply' ? 'dashed' : 'solid' }}
                    />
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 9 9"
                      className={cn('absolute top-0', rightward ? 'right-0' : 'left-0 rotate-180')}
                      aria-hidden
                    >
                      {kind === 'call' ? (
                        <path d="M0.5 0.8 L8.6 4.5 L0.5 8.2Z" fill={color} />
                      ) : (
                        <path d="M1.5 0.8 L8.4 4.5 L1.5 8.2" fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
                      )}
                    </svg>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </DiagramFrame>
  )
}
