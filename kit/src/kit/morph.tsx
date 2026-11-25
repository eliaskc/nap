import { TextMorph } from 'torph/react'

/**
 * Animates changes of a short text or number (torph). Use inside Stat/Num values that
 * change with state: <Stat value={<Morph>{total}</Morph>} />. Respects reduced motion.
 */
export function Morph({ children, className }: { children: string | number; className?: string }) {
  return (
    <TextMorph as="span" className={className} duration={420} ease="cubic-bezier(0.22, 1, 0.36, 1)">
      {String(children)}
    </TextMorph>
  )
}
