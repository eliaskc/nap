// Screenshot a built page with headless Chrome, in light or dark.
// usage: node scripts/shot.mjs <out.png> [width=1400] [light|dark] [full] [file-or-url=dist/index.html]
// THEME=<id> in the environment picks one of the page's themes (theme.json).
// Tall full-page shots are captured in segments and stitched (needs python3 + Pillow);
// without Pillow the segments are kept as <out>-N.png.
import puppeteer from 'puppeteer-core'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const [, , out = 'shot.png', w = '1400', scheme = 'light', full = '', target = 'dist/index.html'] = process.argv
// A deck: add #slide-3 to the file for one slide, e.g. dist-slides/index.html#slide-3.
const [file, hash = ''] = target.split('#')
const remote = /^https?:|^file:/.test(target)
// A built deck loads Nap's slides shell from /_nap/slides.js, which a file on disk does not have.
// So a file is served from a local server that also answers that path, with the shell of the Nap
// this kit came from (nap.local.json, or NAP_URL).
const errors = []
let server
if (!remote) {
  const local = path.resolve(import.meta.dirname, '../nap.local.json')
  const nap = (process.env.NAP_URL || (existsSync(local) ? JSON.parse(readFileSync(local, 'utf8')).url : '') || '').replace(/\/+$/, '')
  server = createServer(async (request, response) => {
    const asked = request.url.split('?')[0]
    if (!asked.startsWith('/_nap/')) {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      return response.end(readFileSync(path.resolve(file)))
    }
    response.setHeader('content-type', 'text/javascript; charset=utf-8')
    // Nap's other scripts (window.nap) are not here: the page runs without them.
    if (asked !== '/_nap/slides.js') return response.end('')
    try {
      if (!nap) throw new Error('no Nap address: set NAP_URL')
      const shell = await fetch(`${nap}/_nap/api/slides.js`)
      if (!shell.ok) throw new Error(`${nap} answered ${shell.status}`)
      response.end(await shell.text())
    } catch (error) {
      errors.push(`Nap's slides shell did not load: ${error.message}`)
      response.end('')
    }
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
}
const url = remote ? target : `http://127.0.0.1:${server.address().port}/${hash && `#${hash}`}`
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' })
const page = await browser.newPage()
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
server?.close()
