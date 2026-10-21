/** Renders the README screenshots with headless Chrome over the DevTools
 * protocol (no Playwright needed). Start the demo first (`npm start`) and let
 * the queue finish, then:
 *
 *   npm run screenshots            # docs/call.jpg, docs/transcript.jpg, docs/pipeline.jpg, docs/team.jpg
 *
 * CHROME=/path/to/chrome overrides the browser; THEME=dark for dark shots. */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.env.DEMO_URL ?? 'http://127.0.0.1:4330/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light'
const OUT = new URL('../docs/', import.meta.url)
const PORT = 9334

const profile = mkdtempSync(join(tmpdir(), 'callqa-shots-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function target(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('Chrome did not start')
}

const ws = new WebSocket(await target())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.error ? Promise.reject(new Error(msg.error.message)) : msg.result)
    pending.delete(msg.id)
  }
})
function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
async function run(js: string) {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${js} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'script failed')
  return r.result?.value
}
async function shot(name: string) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85 })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
  console.log(`docs/${name}`)
}
async function open(hash: string) {
  await cdp('Page.navigate', { url: `${URL_}#${hash}` })
  await sleep(1800)
}

try {
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: THEME }] })
  const suffix = THEME === 'dark' ? '-dark' : ''

  // A call that breaks policy: flags, overridden compliance, evidence chips.
  await open('c-103')
  await shot(`call${suffix}.jpg`)

  // Scores in the transcript margin: a card number read out, masked, compliance zeroed by the rules.
  await open('c-108')
  await run(`document.getElementById('utt-U1').scrollIntoView({ block: 'start' })`)
  await sleep(500)
  await shot(`transcript${suffix}.jpg`)

  // Retry of speech-to-text, roles, masking and the model rounds.
  await open('c-108')
  await run(`[...document.querySelectorAll('.head button')].find((b) => b.textContent === 'Pipeline').click()`)
  await sleep(500)
  await shot(`pipeline${suffix}.jpg`)

  await open('team')
  await sleep(800)
  await shot(`team${suffix}.jpg`)
} finally {
  ws.close()
  chrome.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}
