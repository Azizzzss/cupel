// The README's screenshots: a page of the control room, from a headless
// Chromium driven over the DevTools protocol, with nothing to install.
//
//   node docs/shoot.mjs <url> <out> [--dark] [--frames N --every MS]
//        [--selector CSS] [--width W --height H --scale S] [--wait MS]
//        [--scroll CSS] [--eval JS] [--evalfile PATH]
//
// <out> is a .png for a still, or a directory for a frame sequence
// (f0000.png, …) to turn into a GIF with ffmpeg. The browser is $BROWSER, or
// the first Chrome, Chromium or Edge found in the usual places.
//
// How the images in docs/img were made, against `cupel up` with
// `cupel traffic` running in another terminal:
//
//   node docs/shoot.mjs 'http://127.0.0.1:8544/#/' overview.png --scale 1.5 [--dark]
//   node docs/shoot.mjs 'http://127.0.0.1:8544/#/depth' frames --dark --scale 2 \
//        --wait 8000 --scroll .canvas-frame --selector .canvas-frame --frames 72 --every 125
//   ffmpeg -framerate 8 -i frames/f%04d.png -vf 'crop=1640:790:10:190,scale=900:-1,palettegen' p.png
//   ffmpeg -framerate 8 -i frames/f%04d.png -i p.png -lavfi \
//        'crop=1640:790:10:190,scale=900:-1[x];[x][1:v]paletteuse' chain-in-depth.gif
//
// A headless page counts as visible, which matters: the scene stops drawing
// in a hidden one.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const [url, out] = argv
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = argv[i + 1]
  return next === undefined || next.startsWith('--') ? true : next
}
const width = Number(flag('width', 1280))
const height = Number(flag('height', 800))
const scale = Number(flag('scale', 1))
const frames = Number(flag('frames', 0))
const every = Number(flag('every', 100))
const settle = Number(flag('wait', 6000))
const port = 9300 + Math.floor(Math.random() * 90)

const browser = [
  process.env.BROWSER,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => path && existsSync(path))
if (!browser) {
  console.error('no Chrome, Chromium or Edge found — set BROWSER to one')
  process.exit(1)
}

const profile = mkdtempSync(join(tmpdir(), 'shoot-'))
const edge = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, '--no-first-run', '--hide-scrollbars',
  '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let targets = []
for (let i = 0; i < 60 && !targets.some((t) => t.type === 'page'); i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch {}
  await wait(200)
}
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) =>
  new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
const features = [{ name: 'prefers-color-scheme', value: flag('dark', false) ? 'dark' : 'light' }]
await send('Emulation.setEmulatedMedia', { features })
await send('Page.navigate', { url })
await wait(settle)
if (flag('scroll', false)) {
  await evaluate(`document.querySelector(${JSON.stringify(flag('scroll'))})?.scrollIntoView({block:'center'})`)
  await wait(800)
}
if (flag('eval', false)) console.log('eval:', await evaluate(flag('eval')))
if (flag('evalfile', false)) {
  const { readFileSync } = await import('node:fs')
  console.log('evalfile:', await evaluate(readFileSync(flag('evalfile'), 'utf8')))
}

let clip
if (flag('selector', false)) {
  const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(flag('selector'))})?.getBoundingClientRect(); return r && { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height } })()`)
  if (box) clip = { ...box, scale: 1 }
}
const shot = async () => {
  const result = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}), captureBeyondViewport: false })
  return Buffer.from(result.result.data, 'base64')
}

if (frames > 0) {
  mkdirSync(out, { recursive: true })
  const started = Date.now()
  for (let i = 0; i < frames; i++) {
    const due = started + i * every
    if (Date.now() < due) await wait(due - Date.now())
    writeFileSync(join(out, `f${String(i).padStart(4, '0')}.png`), await shot())
  }
  console.log(`${frames} frames in ${((Date.now() - started) / 1000).toFixed(1)}s → ${out}`)
} else {
  writeFileSync(out, await shot())
  console.log(`→ ${out}`)
}
ws.close()
edge.kill()
process.exit(0)
