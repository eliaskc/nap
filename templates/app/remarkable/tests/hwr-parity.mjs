// Checks that the backend's handwriting network (backend/hwr.go) gives the same answers as the
// web games' (dle's src/lib/pen/recognizer.ts) on the same strokes.
//   node tests/hwr-parity.mjs <dle checkout> <entry binary for this Mac>
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const [dle, entry] = process.argv.slice(2)
const rec = await import(pathToFileURL(join(dle, "src/lib/pen/recognizer.ts")).href)
const bin = readFileSync(join(dle, "public/pen/letters.bin"))
const model = rec.parseModel(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength))

// Letters as strokes on a 100-unit box, with wobble.
const shapes = {
  A: [[[10, 95], [50, 5], [90, 95]], [[28, 60], [72, 60]]],
  E: [[[80, 5], [15, 5], [15, 95], [80, 95]], [[15, 50], [65, 50]]],
  H: [[[15, 5], [15, 95]], [[85, 5], [85, 95]], [[15, 50], [85, 50]]],
  L: [[[20, 5], [20, 95], [80, 95]]],
  O: [Array.from({ length: 30 }, (_, i) => [50 + 40 * Math.cos((i / 29) * 2 * Math.PI), 50 + 45 * Math.sin((i / 29) * 2 * Math.PI)])],
  T: [[[10, 8], [90, 8]], [[50, 8], [50, 95]]],
  W: [[[5, 5], [25, 95], [50, 30], [75, 95], [95, 5]]],
  X: [[[10, 5], [90, 95]], [[90, 5], [10, 95]]],
}
let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5)
const densify = (stroke) => {
  const out = []
  for (let i = 0; i < stroke.length - 1; i++) {
    const [a, b] = [stroke[i], stroke[i + 1]]
    for (let k = 0; k < 8; k++) out.push([a[0] + ((b[0] - a[0]) * k) / 8, a[1] + ((b[1] - a[1]) * k) / 8])
  }
  out.push(stroke.at(-1))
  return out
}
const cases = []
for (const [letter, strokes] of Object.entries(shapes))
  for (let v = 0; v < 3; v++)
    cases.push({ letter, strokes: strokes.map((s) => densify(s).map(([x, y]) => [x * 1.3 + rand() * 6 + 200, y * 1.3 + rand() * 6 + 40])) })

const dir = mkdtempSync(join(tmpdir(), "hwr-"))
writeFileSync(join(dir, "cases.json"), JSON.stringify(cases.map((c) => c.strokes)))
const native = JSON.parse(execFileSync(entry, ["--hwr-test", join(dle, "public/pen/letters.bin"), join(dir, "cases.json")]).toString())

let worst = 0
let agree = 0
for (const [i, c] of cases.entries()) {
  const strokes = c.strokes.map((s) => s.map(([x, y]) => ({ x, y, t: 0 })))
  const web = rec.classify(model, rec.rasterize(strokes))
  const go = native[i].probs
  let diff = 0
  for (let k = 0; k < 26; k++) diff = Math.max(diff, Math.abs(web[k] - go[k]))
  worst = Math.max(worst, diff)
  const top = (p) => rec.LETTERS[[...p].indexOf(Math.max(...p))]
  if (top(web) === top(go)) agree++
  console.log(`${c.letter}  web ${top(web)} ${Math.max(...web).toFixed(3)}  native ${top(go)} ${Math.max(...go).toFixed(3)}  max diff ${diff.toExponential(1)}  ${native[i].ms} ms`)
}
console.log(`\n${agree}/${cases.length} same top letter; largest probability difference ${worst.toExponential(2)}`)
if (agree !== cases.length || worst > 1e-3) process.exit(1)
