/**
 * Code and diffs. Import from '@/kit/code' (kept out of the main '@/kit' entry: the
 * highlighter is WebAssembly, ~0.45 MB inlined, and Diff adds ~0.4 MB more).
 *
 * Highlighting uses @pierre/highlights (152 languages) with a CSS-variable theme, so
 * colours come from the --code-* tokens in index.css and follow light/dark.
 */
import { codeToTokens, isSupportedLanguage, type Theme } from '@pierre/highlights'
import { MultiFileDiff, PatchDiff } from '@pierre/diffs/react'
import { registerCustomTheme } from '@pierre/diffs'
import { Check, Copy } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { cn, useWidth } from './lib'

const theme = (appearance: 'dark' | 'light'): Theme => ({ name: `kit-${appearance}`, appearance, cssVariables: true, style: { syntax: {} } })

/* ─── Code ────────────────────────────────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true)
            setTimeout(() => setDone(false), 1400)
          },
          () => {},
        )
      }}
      aria-label={done ? 'Copied' : 'Copy code'}
      className="grid size-7 cursor-pointer place-items-center rounded-md text-quiet transition-colors hover:bg-sheer-2 hover:text-strong"
    >
      {done ? <Check className="size-3.5 text-good" /> : <Copy className="size-3.5" />}
    </button>
  )
}

/**
 * Highlighted code block with a copy button. Optional title (file name), line
 * numbers, highlighted lines and a caption. Scrolls sideways inside itself; `wrap`
 * wraps long lines instead.
 */
export function Code({
  code,
  lang = 'text',
  title,
  lineNumbers,
  highlight = [],
  wrap,
  caption,
  maxHeight,
  className,
}: {
  code: string
  /** Language name or alias: ts, tsx, py, sql, bash, json, yaml, swift, kotlin, go, rust… */
  lang?: string
  title?: ReactNode
  lineNumbers?: boolean
  /** 1-based line numbers to emphasise. */
  highlight?: number[]
  wrap?: boolean
  caption?: ReactNode
  /** Scroll vertically beyond this height (px). */
  maxHeight?: number
  className?: string
}) {
  const text = code.replace(/\n$/, '')
  const lines = useMemo(() => {
    if (!isSupportedLanguage(lang)) return text.split('\n').map((l) => [{ content: l, color: undefined as string | undefined, fontStyle: 0 }])
    return codeToTokens(text, { lang: lang as never, theme: theme('dark') }).tokens
  }, [text, lang])
  const hl = new Set(highlight)
  return (
    <figure className={cn('min-w-0', className)}>
      <div className="group relative overflow-hidden rounded-[14px] border border-line bg-sheer">
        {title ? (
          <div className="flex items-center justify-between gap-4 border-b border-line py-1.5 pr-1.5 pl-4">
            <span className="truncate font-mono text-[12px] text-quiet">{title}</span>
            <CopyButton text={text} />
          </div>
        ) : (
          <div className="absolute top-1.5 right-1.5 z-10 rounded-md bg-frame opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-70">
            <CopyButton text={text} />
          </div>
        )}
        <pre
          className={cn('kit-scroll py-3 font-mono text-[12.5px] leading-[1.7]', wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre')}
          style={{ maxHeight, overflowY: maxHeight ? 'auto' : undefined, color: 'var(--code-fg)' }}
          tabIndex={0}
        >
          <code className="block min-w-max">
            {lines.map((toks, i) => (
              <span
                key={i}
                className={cn('flex pr-10 pl-4', hl.has(i + 1) && 'bg-[color-mix(in_oklab,var(--teal)_10%,transparent)] shadow-[inset_2px_0_0_var(--teal)]')}
              >
                {lineNumbers && <span className="tnum mr-4 inline-block w-[2.5ch] shrink-0 text-right text-faint select-none">{i + 1}</span>}
                <span className={cn(wrap && 'min-w-0')}>
                  {toks.length ? (
                    toks.map((t, j) => (
                      <span key={j} style={{ color: t.color, fontStyle: (t.fontStyle ?? 0) & 1 ? 'italic' : undefined, fontWeight: (t.fontStyle ?? 0) & 2 ? 500 : undefined }}>
                        {t.content.replace(/\n$/, '')}
                      </span>
                    ))
                  ) : (
                    '\u200b'
                  )}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
      {caption && <figcaption className="mt-2.5 text-[13px] leading-[1.5] text-quiet">{caption}</figcaption>}
    </figure>
  )
}

/* ─── Diff ────────────────────────────────────────────────────────────────── */

let registered = false
function registerThemes() {
  if (registered) return
  registered = true
  registerCustomTheme('kit-dark', async () => theme('dark'), 'zed')
  registerCustomTheme('kit-light', async () => theme('light'), 'zed')
}

/**
 * A code diff (via @pierre/diffs): pass a unified `patch` (git diff output), or
 * `before` + `after` with a file `name`. Split view when wide, unified on phones.
 */
export function Diff({
  patch,
  before,
  after,
  name = 'file.txt',
  layout = 'auto',
  title,
  caption,
  className,
}: {
  patch?: string
  before?: string
  after?: string
  /** File name; its extension picks the language. */
  name?: string
  layout?: 'auto' | 'split' | 'unified'
  title?: ReactNode
  caption?: ReactNode
  className?: string
}) {
  registerThemes()
  const [ref, width] = useWidth<HTMLDivElement>()
  const style = layout === 'auto' ? (width >= 760 ? 'split' : 'unified') : layout
  const options = {
    theme: { dark: 'kit-dark', light: 'kit-light' },
    themeType: 'system' as const,
    preferredHighlighter: 'highlights' as const,
    diffStyle: style,
    overflow: 'scroll' as const,
    disableFileHeader: false,
    // Light mode: a stronger line tint than the library default (88–91 % ground, here 80 %), so added and
    // removed lines read as clearly different colours on the warm ground.
    unsafeCSS:
      '[data-line-type^=change]:is([data-line],[data-no-newline]){--mix-light:80% !important}' +
      '[data-line-type^=change]:is([data-gutter-buffer],[data-column-number]){--mix-light:82% !important}',
  }
  return (
    <figure data-wide className={cn('min-w-0', className)}>
      {title && <div className="eyebrow mb-3">{title}</div>}
      <div ref={ref} className="kit-diff overflow-hidden rounded-[14px] border border-line bg-sheer">
        {width > 0 &&
          (patch ? (
            <PatchDiff patch={patch} options={options} />
          ) : (
            <MultiFileDiff oldFile={{ name, contents: before ?? '' }} newFile={{ name, contents: after ?? '' }} options={options} />
          ))}
      </div>
      {caption && <figcaption className="mt-2.5 text-[13px] leading-[1.5] text-quiet">{caption}</figcaption>}
    </figure>
  )
}
