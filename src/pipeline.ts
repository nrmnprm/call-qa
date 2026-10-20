/** Processing queue: transcribe → prepare → score → alert, one call at a
 * time (a local model is busy enough with one). Every stage can fail; a
 * failure counts an attempt and the call goes back to the queue with a
 * growing delay, and after MAX_ATTEMPTS it is marked failed. A transcript
 * that was already made is kept, so a scoring retry does not pay for speech
 * recognition again, and a failed call still shows the rule-based flags.
 *
 * Results are keyed by a hash of the call, the scorecard and the prompt:
 * editing the scorecard re-queues every call, a restart re-queues nothing. */
import { createHash } from 'node:crypto'
import { llmStatus } from './llm.ts'
import { ruleFlags } from './rules.ts'
import { keyOf, outage, score } from './scorer.ts'
import { alerts, calls, managerById, results, saveResults, scorecard } from './store.ts'
import { metricsOf, prepare, skipReason } from './transcript.ts'
import type { Alert, CallRecord, CallResult, TraceStep } from './types.ts'

export const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3)
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS ?? 1500)
/** Consecutive scoring failures before the "provider down" alert. */
const OUTAGE_THRESHOLD = 3

const queue: string[] = []
const notBefore = new Map<string, number>()
let running = false
const health = { failures: 0, alerted: false }

const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function alert(level: Alert['level'], callId: string | null, text: string) {
  alerts.unshift({ id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ts: now(), level, callId, text })
  alerts.splice(200)
}

const sttKeyOf = (c: CallRecord) => createHash('sha256').update(JSON.stringify(c.stt)).digest('hex').slice(0, 16)

function fresh(c: CallRecord): CallResult {
  return { id: c.id, status: 'queued', attempts: { stt: 0, llm: 0 }, trace: [], key: keyOf(c, scorecard), sttKey: sttKeyOf(c), updatedAt: now() }
}

export function enqueue(c: CallRecord, force = false) {
  const prev = results[c.id]
  const key = keyOf(c, scorecard)
  if (!force && prev && prev.key === key && ['scored', 'skipped', 'failed'].includes(prev.status)) return
  // Same audio: keep the transcript, only the scoring is redone.
  const keep = prev?.transcript && prev.sttKey === sttKeyOf(c) && !force ? { transcript: prev.transcript, metrics: prev.metrics } : {}
  results[c.id] = { ...fresh(c), ...keep }
  // Alerts of the old result no longer apply.
  for (let i = alerts.length - 1; i >= 0; i--) if (alerts[i].callId === c.id) alerts.splice(i, 1)
  if (!queue.includes(c.id)) queue.push(c.id)
  void drain()
}

export function enqueueAll(force = false) {
  for (const c of calls) enqueue(c, force)
}

export function queueState() {
  return { pending: queue.length, running, outage: outage.on, mode: llmStatus().mode }
}

export function setOutage(on: boolean) {
  outage.on = on
}

/** Simulated speech recognition: the call files already hold the provider's
 * output; a call may be set up to fail its first attempts. */
async function transcribe(c: CallRecord, attempt: number): Promise<void> {
  await sleep(Number(process.env.STT_DELAY_MS ?? 400))
  if (attempt <= (c.sttFailures ?? 0)) throw new Error('speech-to-text timeout after 30 s (simulated)')
}

function retryOrFail(r: CallResult, stage: 'stt' | 'llm', error: string) {
  r.error = error
  if (r.attempts[stage] >= MAX_ATTEMPTS) {
    r.status = 'failed'
    alert('amber', r.id, `Not ${stage === 'stt' ? 'transcribed' : 'scored'} after ${MAX_ATTEMPTS} attempts: ${error}`)
    return
  }
  const delay = RETRY_BASE_MS * 2 ** (r.attempts[stage] - 1)
  r.status = 'retry'
  notBefore.set(r.id, Date.now() + delay)
  queue.push(r.id)
  r.trace.push({ name: 'retry', ok: true, ms: 0, detail: `attempt ${r.attempts[stage] + 1} of ${MAX_ATTEMPTS} in ${(delay / 1000).toFixed(1)} s` })
}

async function processOne(id: string) {
  const c = calls.find((x) => x.id === id)
  const r = results[id]
  if (!c || !r) return
  const step = (s: TraceStep) => {
    r.trace.push(s)
    r.updatedAt = now()
  }

  if (!r.transcript) {
    r.status = 'transcribing'
    r.attempts.stt++
    const t0 = Date.now()
    try {
      await transcribe(c, r.attempts.stt)
    } catch (e) {
      step({ name: 'speech-to-text', ok: false, ms: Date.now() - t0, detail: `attempt ${r.attempts.stt}: ${(e as Error).message}` })
      return retryOrFail(r, 'stt', (e as Error).message)
    }
    const t = prepare(c)
    r.transcript = t
    r.metrics = metricsOf(t)
    step({
      name: 'speech-to-text',
      ok: true,
      ms: Date.now() - t0,
      detail: `${c.stt.provider}, ${c.audio.channels === 2 ? 'stereo' : 'mono'}, ${c.stt.utterances.length} utterances, attempt ${r.attempts.stt}`,
    })
    step({
      name: 'prepare',
      ok: true,
      ms: 0,
      detail: [
        `roles by ${t.roles.method}: ${t.roles.detail}`,
        t.dropped.length ? `dropped ${t.dropped.length}: ${t.dropped.map((d) => `"${d.text}" (${d.reason})`).join(', ')}` : 'nothing dropped',
        t.redactions.length ? `masked: ${t.redactions.map((x) => `${x.kind} in ${x.utterance}`).join(', ')}` : 'no personal data found',
      ].join('; '),
    })
  }

  const skip = skipReason(r.transcript, r.metrics!)
  if (skip) {
    r.status = 'skipped'
    r.skipReason = skip
    step({ name: 'skip', ok: true, ms: 0, detail: `${skip}: not sent to the model` })
    return
  }

  r.status = 'scoring'
  r.attempts.llm++
  const out = await score(c, r.transcript, scorecard, managerById(c.managerId))
  for (const s of out.steps) step(s)
  if (!out.ok) {
    health.failures++
    if (health.failures >= OUTAGE_THRESHOLD && !health.alerted) {
      health.alerted = true
      alert('red', null, `Scoring provider is failing: ${health.failures} errors in a row (${out.error}). Calls wait in the queue.`)
    }
    // Rule-based flags do not need the model.
    const flags = ruleFlags(r.transcript)
    if (flags.length && !alerts.some((a) => a.callId === id)) {
      alert('red', id, `${flags.map((f) => f.note).join('; ')} (found by rules, model scoring pending)`)
    }
    return retryOrFail(r, 'llm', out.error)
  }
  if (health.alerted) alert('info', null, `Scoring provider recovered after ${health.failures} failed attempts.`)
  health.failures = 0
  health.alerted = false

  r.status = 'scored'
  r.error = undefined
  r.assessment = out.assessment
  r.model = out.model
  r.source = out.source
  r.usage = out.usage
  for (let i = alerts.length - 1; i >= 0; i--) if (alerts[i].callId === id) alerts.splice(i, 1)
  const a = out.assessment
  const m = managerById(c.managerId)?.name ?? c.managerId
  for (const f of a.redFlags) alert('red', id, `${m}, ${c.customer.company}: ${f.note || f.type.replace('_', ' ')}`)
  if (!a.redFlags.length && a.total != null && a.total < scorecard.passMark) {
    alert('amber', id, `${m}, ${c.customer.company}: ${a.total}/100, below the pass mark of ${scorecard.passMark}`)
  }
}

async function drain() {
  if (running) return
  running = true
  try {
    while (queue.length) {
      // The first call that is due; waiting retries do not block the others.
      const i = queue.findIndex((id) => (notBefore.get(id) ?? 0) <= Date.now())
      if (i === -1) {
        await sleep(250)
        continue
      }
      const [id] = queue.splice(i, 1)
      notBefore.delete(id)
      try {
        await processOne(id)
      } catch (e) {
        console.error(e)
        const r = results[id]
        if (r) {
          r.status = 'failed'
          r.error = (e as Error).message
        }
      }
      saveResults()
    }
  } finally {
    running = false
  }
}

/** Promise that resolves when the queue is empty (scripts and tests). */
export async function idle(): Promise<void> {
  while (running || queue.length) await sleep(200)
}
