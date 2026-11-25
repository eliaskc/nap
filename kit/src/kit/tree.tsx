import { ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn, toneColor, type Tone } from './lib'
import { Reveal } from './content'

export type TreeNode = {
  name: ReactNode
  /** Quiet text after the name: what it is, a size, a count. */
  note?: ReactNode
  children?: TreeNode[]
  /** Folders start open unless `open: false`. */
  open?: boolean
  tone?: Tone
  /** Marks the row: added (+, good), removed (−, bad), changed (~, warn). */
  status?: 'added' | 'removed' | 'changed'
}

const STATUS = {
  added: { mark: '+', tone: 'good' as Tone },
  removed: { mark: '−', tone: 'bad' as Tone },
  changed: { mark: '~', tone: 'warn' as Tone },
}

/** A file tree or call tree with guide lines and collapsible branches. */
export function Tree({
  items,
  mono = true,
  title,
  className,
}: {
  items: TreeNode[]
  /** Monospace names (files, functions). Set false for a tree of plain phrases. */
  mono?: boolean
  title?: ReactNode
  className?: string
}) {
  return (
    <figure className={cn('min-w-0', className)}>
      {title && <div className="eyebrow mb-3">{title}</div>}
      <div className="kit-scroll rounded-[14px] border border-line bg-sheer px-3 py-3">
        <ul role="tree" className="min-w-max">
          {items.map((n, i) => (
            <Row key={i} n={n} depth={0} mono={mono} />
          ))}
        </ul>
      </div>
    </figure>
  )
}

function Row({ n, depth, mono }: { n: TreeNode; depth: number; mono: boolean }) {
  const branch = !!n.children?.length
  const [open, setOpen] = useState(n.open ?? true)
  const st = n.status ? STATUS[n.status] : undefined
  const label = (
    <>
      <span className="grid w-4 shrink-0 place-items-center">
        {branch ? (
          <ChevronRight className={cn('size-3.5 text-faint transition-transform duration-200', open && 'rotate-90')} />
        ) : (
          <span className="size-[3px] rounded-full bg-faint" />
        )}
      </span>
      {st && (
        <span className="tnum w-3 shrink-0 text-center font-mono text-[12px]" style={{ color: toneColor(st.tone) }}>
          {st.mark}
        </span>
      )}
      <span
        className={cn(mono ? 'font-mono text-[12.5px]' : 'text-[14px]', branch ? 'text-strong' : 'text-body', n.status === 'removed' && 'line-through decoration-1 opacity-70')}
        style={n.tone ? { color: toneColor(n.tone) } : undefined}
      >
        {n.name}
        {branch && mono && <span className="text-faint">/</span>}
      </span>
      {n.note && <span className="ml-3 text-[12.5px] text-quiet">{n.note}</span>}
    </>
  )
  return (
    <li role="treeitem" aria-expanded={branch ? open : undefined} className="relative">
      {branch ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-[3px] pr-2 text-left hover:bg-sheer-2"
        >
          {label}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 py-[3px] pr-2">{label}</div>
      )}
      {branch && (
        <Reveal open={open}>
          <ul role="group" className="relative ml-[7px] border-l border-line pl-3">
            {n.children!.map((c, i) => (
              <Row key={i} n={c} depth={depth + 1} mono={mono} />
            ))}
          </ul>
        </Reveal>
      )}
    </li>
  )
}
