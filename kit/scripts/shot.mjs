// Screenshot a built page with headless Chrome, in light or dark.
// usage: node scripts/shot.mjs <out.png> [width=1400] [light|dark] [full] [file-or-url=dist/index.html]
// THEME=<id> in the environment picks one of the page's themes (theme.json).
// Tall full-page shots are captured in segments and stitched (needs python3 + Pillow);
// without Pillow the segments are kept as <out>-N.png.
import puppeteer from 'puppeteer-core'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

const [, , out = 'shot.png', w = '1400', scheme = 'light', full = '', target = 'dist/index.html'] = process.argv
const url = /^https?:|^file:/.test(target) ? target : pathToFileURL(path.resolve(target)).href
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' })
const page = await browser.newPage()
const errors = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
const width = +w
const dsf = width < 600 ? 2 : 1
await page.setViewport({ width, height: 900, deviceScaleFactor: dsf })
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
await page.goto(url, { waitUntil: 'load' })
// THEME=<id> shows the page in one of its themes.
if (process.env.THEME) await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), process.env.THEME)
await page.evaluate(() => document.fonts.ready)
await new Promise((r) => setTimeout(r, 800))
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

if (full !== 'full') {
  await page.screenshot({ path: out })
} else {
  const H = await page.evaluate(() => document.documentElement.scrollHeight)
  const seg = Math.floor(8000 / dsf)
  const parts = []
  for (let y = 0, i = 0; y < H; y += seg, i++) {
    const f = out.replace(/\.png$/, `-${i}.png`)
    await page.screenshot({ path: f, clip: { x: 0, y, width, height: Math.min(seg, H - y) }, captureBeyondViewport: true })
    parts.push(f)
  }
  try {
    execFileSync('python3', ['-c', `
import sys
from PIL import Image
ims=[Image.open(f) for f in sys.argv[2:]]
o=Image.new('RGB',(ims[0].size[0],sum(i.size[1] for i in ims))); y=0
for i in ims: o.paste(i,(0,y)); y+=i.size[1]
o.save(sys.argv[1])`, out, ...parts])
    parts.forEach((f) => rmSync(f))
  } catch {
    console.log('python3 + Pillow not available; kept the segments')
  }
}
console.log(`${out}: horizontal overflow ${overflow}px; console errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`)
await browser.close()
