import { Dialog } from '@base-ui/react/dialog'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import { cn } from './lib'

/* ─── Figure ──────────────────────────────────────────────────────────────── */

/** An image (or any visual) with a caption. `frame` puts it on a sheer box. */
export function Figure({
  src,
  alt = '',
  children,
  caption,
  credit,
  frame,
  wide,
  className,
}: {
  src?: string
  alt?: string
  /** Any visual instead of `src`. */
  children?: ReactNode
  caption?: ReactNode
  credit?: ReactNode
  frame?: boolean
  wide?: boolean
  className?: string
}) {
  return (
    <figure data-wide={wide || undefined} className={cn('min-w-0', className)}>
      <div className={cn('overflow-hidden', frame ? 'rounded-[18px] border border-line bg-sheer p-3 md:p-5' : 'rounded-[14px]')}>
        {src ? <img src={src} alt={alt} decoding="async" className={cn('block h-auto w-full', frame ? 'rounded-[10px]' : 'rounded-[14px]')} /> : children}
      </div>
      {(caption || credit) && (
        <figcaption className="mt-3 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[13px] leading-[1.5] text-quiet">
          <span className="text-pretty">{caption}</span>
          {credit && <span className="text-faint">{credit}</span>}
        </figcaption>
      )}
    </figure>
  )
}

/* ─── Lightbox ────────────────────────────────────────────────────────────── */

export type LightboxImage = { src: string; alt?: string; caption?: ReactNode; label?: ReactNode }

/**
 * A grid of thumbnails that open full-size in an overlay. Arrow keys and buttons move
 * between images, Esc closes. Good for screenshots and QA evidence.
 */
export function Lightbox({
  images,
  columns = 3,
  aspect = '4 / 3',
  fit = 'cover',
  className,
}: {
  images: LightboxImage[]
  /** Thumbnails per row on wide screens (phones show two). */
  columns?: number
  /** Thumbnail aspect ratio, e.g. "9 / 19.5" for phone screenshots. */
  aspect?: string
  fit?: 'cover' | 'contain'
  className?: string
}) {
  const [index, setIndex] = useState<number | null>(null)
  const open = index != null
  const go = useCallback((d: number) => setIndex((i) => (i == null ? i : (i + d + images.length) % images.length)), [images.length])
  const cur = index != null ? images[index] : undefined

  return (
    <div data-wide className={cn('min-w-0', className)}>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(var(--cols),minmax(0,1fr))] md:gap-4" style={{ '--cols': columns } as React.CSSProperties}>
        {images.map((im, i) => (
          <li key={i} className="min-w-0">
            <button
              type="button"
              onClick={() => setIndex(i)}
              className="group press block w-full cursor-zoom-in text-left"
              aria-label={`Open ${typeof im.label === 'string' ? im.label : im.alt || `image ${i + 1}`}`}
            >
              <span className="block overflow-hidden rounded-[12px] border border-line bg-sheer" style={{ aspectRatio: aspect }}>
                <img
                  src={im.src}
                  alt={im.alt ?? ''}
                  decoding="async"
                  className={cn('size-full transition-transform duration-500 ease-out group-hover:scale-[1.02] motion-reduce:transition-none', fit === 'cover' ? 'object-cover object-top' : 'object-contain')}
                />
              </span>
              {(im.label || im.caption) && (
                <span className="mt-2 block text-[12.5px] leading-[1.4] text-quiet">
                  {im.label && <span className="font-medium text-strong">{im.label}</span>}
                  {im.label && im.caption ? ' · ' : ''}
                  {!im.label && im.caption}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <Dialog.Root open={open} onOpenChange={(o) => !o && setIndex(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-[rgb(8_7_6/0.86)] backdrop-blur-sm transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') go(1)
              if (e.key === 'ArrowLeft') go(-1)
            }}
            className="fixed inset-0 z-50 flex flex-col p-3 outline-none md:p-6 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            <div className="flex items-center justify-between gap-4 pb-3 text-[13px] text-white/70">
              <Dialog.Title className="tnum">
                {index != null && `${index + 1} / ${images.length}`}
                {cur?.label && <span className="ml-3 text-white/90">{cur.label}</span>}
              </Dialog.Title>
              <Dialog.Close aria-label="Close" className="grid size-9 cursor-pointer place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white">
                <X className="size-5" />
              </Dialog.Close>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
              {cur && <img src={cur.src} alt={cur.alt ?? ''} className="max-h-full max-w-full rounded-[10px] object-contain" />}
              {images.length > 1 && (
                <>
                  <button type="button" onClick={() => go(-1)} aria-label="Previous" className="absolute left-0 grid size-11 cursor-pointer place-items-center rounded-full bg-black/40 text-white/85 hover:bg-black/60 md:left-2">
                    <ChevronLeft className="size-5" />
                  </button>
                  <button type="button" onClick={() => go(1)} aria-label="Next" className="absolute right-0 grid size-11 cursor-pointer place-items-center rounded-full bg-black/40 text-white/85 hover:bg-black/60 md:right-2">
                    <ChevronRight className="size-5" />
                  </button>
                </>
              )}
            </div>
            {cur?.caption && <Dialog.Description className="mx-auto max-w-[680px] pt-3 text-center text-[13.5px] leading-[1.5] text-white/75">{cur.caption}</Dialog.Description>}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

/* ─── PhoneFrame ──────────────────────────────────────────────────────────── */

/**
 * An iPhone-shaped frame for a screenshot (`src`) or live content (`children`).
 * Width in px; the height follows the 19.5:9 screen.
 */
export function PhoneFrame({
  src,
  alt = '',
  children,
  width = 280,
  caption,
  className,
}: {
  src?: string
  alt?: string
  children?: ReactNode
  width?: number
  caption?: ReactNode
  className?: string
}) {
  return (
    <figure className={cn('mx-0 inline-flex max-w-full flex-col items-center', className)} style={{ width }}>
      <div
        className="relative w-full rounded-[calc(var(--w)*0.155)] border border-line-strong bg-[#0b0b0b] p-[calc(var(--w)*0.03)] shadow-[0_24px_60px_-24px_rgb(0_0_0/0.45)]"
        style={{ '--w': `${width}px` } as React.CSSProperties}
      >
        <div className="relative overflow-hidden rounded-[calc(var(--w)*0.125)] bg-black" style={{ aspectRatio: '9 / 19.5' }}>
          {src ? <img src={src} alt={alt} decoding="async" className="size-full object-cover object-top" /> : <div className="size-full overflow-auto">{children}</div>}
          <span aria-hidden className="absolute top-[calc(var(--w)*0.035)] left-1/2 h-[calc(var(--w)*0.085)] w-[calc(var(--w)*0.3)] -translate-x-1/2 rounded-full bg-black" />
        </div>
      </div>
      {caption && <figcaption className="mt-3 text-center text-[13px] leading-[1.5] text-quiet">{caption}</figcaption>}
    </figure>
  )
}
