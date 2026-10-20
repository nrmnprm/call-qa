/** Turns the hand-written call scripts in scripts/calls/*.txt into the shape a
 * speech-to-text provider returns: utterances with start/end times, a channel
 * (stereo recording: one line per party) or a diarized speaker index (mono),
 * and a confidence. The demo never sees the M:/C: labels, only this output.
 *
 *   npm run calls       # writes data/calls/*.json
 *
 * Script syntax, one utterance per line:
 *   M: text      manager            C: text     customer
 *   +4 C: text   starts after a 4 s pause
 *   ~M: text     starts before the previous speaker finished (interruption)
 *   C?: text     low recognition confidence */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { CallRecord, SttUtterance } from '../src/types.ts'

const SRC = new URL('calls/', import.meta.url)
const OUT = new URL('../data/calls/', import.meta.url)

/** Deterministic pseudo-random in [0, 1) so regenerated files do not churn. */
function rand(seed: string): number {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return ((h >>> 0) % 10_000) / 10_000
}

const round = (n: number) => Math.round(n * 100) / 100

for (const file of readdirSync(SRC).filter((f) => f.endsWith('.txt')).sort()) {
  const [head, body] = readFileSync(new URL(file, SRC), 'utf8').split('\n---\n')
  const h: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const stereo = h.audio === 'stereo'
  const managerSpeaker = Number(h.mono_manager ?? 0)
  const wordsPerSec = h.language === 'ru' ? 2.2 : 2.6
  const utterances: SttUtterance[] = []
  let clock = 1.2
  for (const [n, raw] of body.trim().split('\n').entries()) {
    const m = /^(?:\+(\d+(?:\.\d+)?)\s+)?(~)?([MC])(\?)?:\s*(.+)$/.exec(raw.trim())
    if (!m) throw new Error(`${file}:${n + 1}: cannot parse "${raw}"`)
    const [, pause, interrupt, who, unsure, text] = m
    const prev = utterances.at(-1)
    const r = rand(`${file}:${n}`)
    let start = clock + (pause ? Number(pause) : 0.35 + r * 0.7)
    if (interrupt && prev) start = prev.end - Math.min(1.6, (prev.end - prev.start) * 0.3)
    const words = text.split(/\s+/).length
    const end = start + words / wordsPerSec + 0.3 + r * 0.4
    const isManager = who === 'M'
    const u: SttUtterance = {
      start: round(start),
      end: round(end),
      ...(stereo ? { channel: isManager ? 0 : 1 } : { speaker: isManager ? managerSpeaker : 1 - managerSpeaker }),
      text,
      confidence: unsure ? 0.41 : round(0.9 + r * 0.08),
    }
    utterances.push(u)
    clock = Math.max(clock, end)
  }
  const record: CallRecord = {
    id: h.id,
    direction: h.direction as CallRecord['direction'],
    managerId: h.manager,
    customer: { company: h.company, contact: h.contact, phone: h.phone },
    startedAt: h.started,
    language: h.language,
    audio: { channels: stereo ? 2 : 1, durationSec: Math.ceil(clock + 1.5) },
    ...(h.stt_failures ? { sttFailures: Number(h.stt_failures) } : {}),
    stt: { provider: 'simulated', utterances },
  }
  writeFileSync(new URL(`${h.id}.json`, OUT), JSON.stringify(record, null, 1) + '\n')
  console.log(`data/calls/${h.id}.json: ${utterances.length} utterances, ${record.audio.durationSec}s, ${stereo ? 'stereo' : 'mono'}`)
}
