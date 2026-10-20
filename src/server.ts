/** Demo server: static UI + JSON API, no framework. */
import './env.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkModels, llmStatus } from './llm.ts'
import { enqueue, enqueueAll, queueState, setOutage } from './pipeline.ts'
import { addCustomCall, calls, COMPANY, managerById, managers, results, saveScorecard, scorecard } from './store.ts'
import { teamSummary } from './team.ts'
import { parsePasted } from './transcript.ts'
import type { CallRecord } from './types.ts'

const PORT = Number(process.env.PORT ?? 4330)
const HOST = process.env.HOST ?? '127.0.0.1'
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, limit = 100_000): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object')
  return body as Record<string, unknown>
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Live model calls cost money: a small per-client budget. The socket
 * address is used unless TRUST_PROXY=1 (then the proxy's own last hop). */
const hits = new Map<string, number[]>()
function rateLimit(req: IncomingMessage, perMinute: number) {
  if (llmStatus().mode !== 'live') return
  const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const ip = process.env.TRUST_PROXY === '1' && hops.length ? hops[hops.length - 1] : (req.socket.remoteAddress ?? '')
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= perMinute) throw new HttpError(429, 'too many requests, try again in a minute')
  recent.push(now)
  hits.set(ip, recent)
}
setInterval(() => {
  const now = Date.now()
  for (const [k, t] of hits) if (!t.some((x) => now - x < 60_000)) hits.delete(k)
}, 60_000).unref()

function needsLive(what: string) {
  if (llmStatus().mode !== 'live') throw new HttpError(409, `${what} needs a live model (${llmStatus().reason}); recorded answers only cover the bundled calls`)
}

function listItem(c: CallRecord) {
  const r = results[c.id]
  const a = r?.assessment
  return {
    id: c.id,
    startedAt: c.startedAt,
    direction: c.direction,
    manager: managerById(c.managerId)?.name ?? c.managerId,
    managerId: c.managerId,
    company: c.customer.company,
    contact: c.customer.contact,
    language: c.language,
    durationSec: c.audio.durationSec,
    custom: !!c.custom,
    status: r?.status ?? 'queued',
    total: a?.total ?? null,
    passed: a?.passed ?? null,
    flags: a?.redFlags.length ?? 0,
    outcome: a?.outcome ?? null,
    skipReason: r?.skipReason ?? null,
    error: r?.status === 'failed' ? r.error : null,
    attempts: r?.attempts ?? { stt: 0, llm: 0 },
  }
}

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method === 'GET' && path === '/api/meta') {
    return send(res, 200, { company: COMPANY, managers, scorecard, llm: llmStatus(), queue: queueState() })
  }
  if (req.method === 'GET' && path === '/api/calls') {
    return send(res, 200, { calls: [...calls].reverse().map(listItem), queue: queueState() })
  }
  const one = /^\/api\/calls\/([\w-]+)(\/rescore)?$/.exec(path)
  if (one) {
    const c = calls.find((x) => x.id === one[1])
    if (!c) throw new HttpError(404, 'no such call')
    if (req.method === 'GET' && !one[2]) {
      const { stt, ...meta } = c
      return send(res, 200, { call: { ...meta, manager: managerById(c.managerId)?.name, sttProvider: stt.provider }, item: listItem(c), result: results[c.id] ?? null })
    }
    if (req.method === 'POST' && one[2]) {
      rateLimit(req, 6)
      enqueue(c, true)
      return send(res, 200, { queued: true })
    }
  }
  if (req.method === 'POST' && path === '/api/calls') {
    needsLive('Scoring a new call')
    rateLimit(req, 6)
    const b = await readJson(req)
    const managerId = str(b.managerId, 40)
    if (!managerById(managerId)) throw new HttpError(400, 'unknown manager')
    const utterances = parsePasted(str(b.text, 20_000))
    if (utterances.length < 2) throw new HttpError(400, 'paste at least two lines like "Manager: …" and "Customer: …"')
    const n = calls.filter((x) => x.custom).length + 1
    const day = new Date().toISOString().slice(0, 16)
    const record: CallRecord = {
      id: `p-${String(n).padStart(3, '0')}`,
      direction: b.direction === 'outbound' ? 'outbound' : 'inbound',
      managerId,
      customer: { company: str(b.company, 80).trim() || 'unknown', contact: str(b.contact, 80).trim() || 'unknown', phone: '' },
      startedAt: day,
      language: /[а-яё]/i.test(utterances.map((u) => u.text).join(' ')) ? 'ru' : 'en',
      audio: { channels: utterances.some((u) => u.channel != null) ? 2 : 1, durationSec: Math.ceil(utterances.at(-1)!.end + 1) },
      stt: { provider: 'pasted text', utterances },
      custom: true,
    }
    addCustomCall(record)
    enqueue(record)
    return send(res, 200, { id: record.id })
  }
  if (req.method === 'GET' && path === '/api/team') return send(res, 200, { ...teamSummary(), queue: queueState() })
  if (req.method === 'PUT' && path === '/api/scorecard') {
    needsLive('Re-scoring with a changed scorecard')
    const b = await readJson(req)
    if (typeof b.passMark === 'number' && b.passMark >= 0 && b.passMark <= 100) scorecard.passMark = Math.round(b.passMark)
    for (const e of Array.isArray(b.criteria) ? b.criteria : []) {
      if (!e || typeof e !== 'object') continue
      const o = e as Record<string, unknown>
      const c = scorecard.criteria.find((x) => x.id === o.id)
      if (!c) continue
      if (typeof o.weight === 'number' && o.weight >= 0 && o.weight <= 5) c.weight = Math.round(o.weight)
      if (typeof o.description === 'string' && o.description.trim()) c.description = o.description.trim().slice(0, 600)
    }
    saveScorecard()
    enqueueAll()
    return send(res, 200, { scorecard, queue: queueState() })
  }
  if (req.method === 'POST' && path === '/api/outage') {
    const b = await readJson(req)
    setOutage(b.on === true)
    return send(res, 200, queueState())
  }
  throw new HttpError(404, 'not found')
}

async function serveStatic(res: ServerResponse, path: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(path === '/' ? '/index.html' : path)
  } catch {
    throw new HttpError(400, 'bad path')
  }
  const file = join(PUBLIC, normalize(decoded).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'forbidden')
  try {
    const body = await readFile(file)
    // Revalidate every time: a demo edited in place must not serve a stale script.
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(body)
  } catch {
    throw new HttpError(404, 'not found')
  }
}

const server = createServer(async (req, res) => {
  try {
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      throw new HttpError(400, 'bad URL')
    }
    if (path.startsWith('/api/')) await api(req, res, path)
    else await serveStatic(res, path)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : 'error' })
  }
})

const checks = await checkModels()
server.listen(PORT, HOST, () => {
  const st = llmStatus()
  console.log(`Call QA demo: http://${HOST}:${PORT}`)
  for (const c of checks) console.log(`  ${c}`)
  console.log(st.mode === 'live' ? `  LLM: live (${st.model})` : `  LLM: replay only (${st.reason}); ${st.recordings} recordings`)
  enqueueAll()
  console.log(`  queue: ${queueState().pending} call(s) to process`)
})
