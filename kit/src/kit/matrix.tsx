import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cn, toneColor, toneMix, type Tone } from './lib'
import { Reveal } from './content'
import { DiagramFrame } from './wires'

export type MatrixState = {
  label: ReactNode
  tone?: Tone
  /** solid: tinted fill · outline: border only · hatch: diagonal lines (n/a, skipped) · empty */
  fill?: 'solid' | 'outline' | 'hatch' | 'empty'
}
export type MatrixCell = { state: string; label?: ReactNode; note?: ReactNode; flag?: ReactNode }

/**
 * A grid of cells with states: coverage, support, decisions per option. Cells with a
 * `note` are clickable and open their note under the grid. The state legend is built in.
 */
export function Matrix({
  rows,
  cols,
  states,
  cells,
  title,
  caption,
  corner,
  minWidth,
  className,
}: {
  rows: Array<{ id: string; label: ReactNode; sub?: ReactNode }>
  cols: Array<{ id: string; label: ReactNode; sub?: ReactNode }>
  /** State id → how it looks. */
  states: Record<string, MatrixState>
  /** "rowId:colId" → cell. Missing cells render empty. */
  cells: Record<string, MatrixCell>
  title?: ReactNode
  caption?: ReactNode
  /** Header text over the row labels. */
  corner?: ReactNode
  minWidth?: number
  className?: string
}) {
  const [sel, setSel] = useState<string | null>(null)
  const last = useRef<string | null>(null)
  if (sel && cells[sel]?.note) last.current = sel
  const shown = sel ?? last.current
  const selCell = shown ? cells[shown] : undefined
  const [sr, sc] = shown?.split(':') ?? []
  const grid: CSSProperties = { gridTemplateColumns: `minmax(110px, 1.1fr) repeat(${cols.length}, minmax(76px, 1fr))` }
  return (
    <DiagramFrame
      title={title}
      caption={caption}
      legend={Object.values(states).map((s) => ({ label: s.label, tone: s.tone, kind: s.fill === 'hatch' ? 'hatch' : 'box' }))}
      minWidth={minWidth ?? 120 + cols.length * 84}
      className={className}
    >
      <div role="table" className="tnum grid gap-1.5" style={grid}>
        <div role="row" className="contents">
          <div role="columnheader" className="eyebrow self-end pb-1 text-[10.5px]">
            {corner}
          </div>
          {cols.map((c) => (
            <div role="columnheader" key={c.id} className="min-w-0 self-end pb-1">
              <div className="eyebrow text-[10.5px]">{c.label}</div>
              {c.sub && <div className="text-[11.5px] text-faint">{c.sub}</div>}
            </div>
          ))}
        </div>
        {rows.map((r) => (
          <div role="row" key={r.id} className="contents">
            <div role="rowheader" className="flex min-w-0 flex-col justify-center pr-2">
              <div className="text-[13.5px] leading-[1.3] font-medium text-strong">{r.label}</div>
              {r.sub && <div className="text-[11.5px] leading-[1.35] text-quiet">{r.sub}</div>}
            </div>
            {cols.map((c) => {
              const key = `${r.id}:${c.id}`
              const cell = cells[key]
              const st = cell ? states[cell.state] : undefined
              const tone = st?.tone ?? 'neutral'
              const fill = st?.fill ?? (cell ? 'outline' : 'empty')
              const style: CSSProperties =
                fill === 'solid'
                  ? { background: toneMix(tone, tone === 'neutral' ? 22 : 16), borderColor: toneMix(tone, tone === 'neutral' ? 40 : 55) }
                  : fill === 'outline'
                    ? { borderColor: tone === 'neutral' ? 'rgb(var(--ink) / 0.16)' : toneMix(tone, 50) }
                    : fill === 'hatch'
                      ? { borderColor: 'rgb(var(--ink) / 0.1)' }
                      : { borderColor: 'transparent' }
              const on = sel === key
              const content = (
                <>
                  <span className="truncate">{cell?.label ?? (cell ? st?.label : '')}</span>
                  {cell?.flag && (
                    <span className="absolute -top-2 right-1.5 rounded-full bg-peach px-1.5 text-[9.5px] leading-[14px] font-medium tracking-[0.06em] text-bg uppercase">
                      {cell.flag}
                    </span>
                  )}
                </>
              )
              const cls = cn(
                'relative flex min-h-[38px] min-w-0 items-center rounded-[9px] border px-2.5 text-[12px] leading-[1.25]',
                fill === 'hatch' && 'hatch',
                fill === 'solid' ? 'text-value' : 'text-body',
                fill === 'empty' && 'text-faint',
              )
              const s2 = { ...style, color: fill === 'solid' && tone !== 'neutral' ? toneColor(tone) : undefined, boxShadow: on ? `0 0 0 2px ${toneColor(tone === 'neutral' ? 'teal' : tone)}` : undefined }
              return cell?.note ? (
                <button
                  role="cell"
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSel(on ? null : key)}
                  className={cn(cls, 'press cursor-pointer text-left hover:brightness-110')}
                  style={s2}
                >
                  {content}
                </button>
              ) : (
                <div role="cell" key={key} className={cn(cls, 'transition-[box-shadow,border-color]')} style={s2}>
                  {content}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <Reveal open={!!(sel && cells[sel]?.note)}>
        {selCell?.note && (
          <div className="mt-5 rounded-[14px] border border-line bg-paper px-4 py-3 text-[13.5px] leading-[1.55]" aria-live="polite">
            <div className="mb-1 text-[12px] text-quiet">
              {rows.find((r) => r.id === sr)?.label} · {cols.find((c) => c.id === sc)?.label} ·{' '}
              <span style={{ color: toneColor(states[selCell.state]?.tone ?? 'neutral', 'inherit') }}>{states[selCell.state]?.label}</span>
            </div>
            <div className="text-body">{selCell.note}</div>
          </div>
        )}
      </Reveal>
    </DiagramFrame>
  )
}
