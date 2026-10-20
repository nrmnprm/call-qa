/** Speech-to-text output → a transcript the scorer can trust.
 *
 *  1. merge channels in time order;
 *  2. drop what the recogniser invented (Whisper-style "Thanks for watching!"
 *     in silence) and near-empty filler;
 *  3. decide who is the manager: the channel on stereo recordings, phrases on
 *     mono ones, where diarization only says "speaker 0" and "speaker 1";
 *  4. mask card numbers, card details, emails and phone numbers before the
 *     text goes anywhere near a model;
 *  5. compute conversation metrics from timings, without a model. */
import type { CallRecord, DroppedUtterance, Metrics, Role, RoleDetection, SttUtterance, Transcript, Utterance } from './types.ts'

export const COMPANY_RE = /\bnorthwind\b/i
/** The phone system records the office line on channel 0. */
const MANAGER_CHANNEL = 0

// ---- recogniser hallucinations ----

/** Phrases speech models are known to produce from silence or noise
 * (they come from subtitled videos in the training data). */
const HALLUCINATIONS = [
  /thanks? (you )?for watching/i,
  /please subscribe|subscribe to (the|my|our) channel/i,
  /субтитр\w* (сделал|создал|подготовил)|редактор субтитров/i,
  /продолжение следует/i,
  /спасибо за (просмотр|внимание)\W*$/i,
]
const FILLER = /^(?:u+h+m*|u+m+|hmm+|mm+|э+|ммм*|а+)[\s.,!?…-]*$/i

export function hallucinationReason(u: SttUtterance, pauseBefore: number, isLast: boolean): string | null {
  if (!u.text.trim() || FILLER.test(u.text.trim())) return 'filler'
  if (u.confidence < 0.3) return `confidence ${u.confidence}`
  if (HALLUCINATIONS.some((re) => re.test(u.text)) && (u.confidence < 0.6 || pauseBefore > 5 || isLast)) {
    return 'known recogniser hallucination'
  }
  return null
}

// ---- roles ----

const keyOf = (u: SttUtterance, byChannel: boolean) => (byChannel ? `channel ${u.channel ?? 0}` : `speaker ${u.speaker ?? 0}`)

/** Phrases that point at the side of the call someone is on. */
const MANAGER_HINTS = [/how can I help/i, /what do you need/i, /чем (могу|можем) помочь/i, /\bспасибо за звонок\b/i, /thanks for calling/i]
const CUSTOMER_HINTS = [/\bI'?m looking for\b/i, /\bwe need\b/i, /\bнам нужн\w*/i, /\bищу\b/i, /how much (is|does)/i, /сколько стоит/i]

export function detectRoles(utterances: SttUtterance[], direction: CallRecord['direction']): RoleDetection {
  const channels = new Set(utterances.map((u) => u.channel).filter((c) => c != null))
  if (channels.size >= 2) {
    return { method: 'channel', managerKey: `channel ${MANAGER_CHANNEL}`, detail: `stereo recording: the office line is channel ${MANAGER_CHANNEL}` }
  }
  const speakers = [...new Set(utterances.map((u) => keyOf(u, false)))]
  const first = speakers[0] ?? 'speaker 0'
  // A company name in a statement early on is an introduction ("Northwind Air,
  // Anna speaking"); in a question it is the caller checking the number.
  for (const u of utterances.filter((x) => x.start < 30)) {
    const sentences = u.text.split(/(?<=[.!?])\s+/)
    if (sentences.some((s) => COMPANY_RE.test(s) && !s.trim().endsWith('?'))) {
      return { method: 'greeting', managerKey: keyOf(u, false), detail: `introduces the company: "${u.text.slice(0, 60)}"` }
    }
  }
  const score = new Map<string, number>(speakers.map((s) => [s, 0]))
  const why: string[] = []
  for (const u of utterances) {
    const k = keyOf(u, false)
    for (const re of MANAGER_HINTS) if (re.test(u.text)) { score.set(k, score.get(k)! + 1); why.push(`${k}: "${re.source}"`) }
    for (const re of CUSTOMER_HINTS) if (re.test(u.text)) { score.set(k, score.get(k)! - 1); why.push(`${k}: customer-like "${re.source}"`) }
    if (COMPANY_RE.test(u.text) && u.text.includes('?')) { score.set(k, score.get(k)! - 2); why.push(`${k}: asks if this is the company`) }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length >= 2 && ranked[0][1] > ranked[1][1]) {
    return { method: 'phrases', managerKey: ranked[0][0], detail: why.slice(0, 4).join('; ') }
  }
  // Inbound: the office answers first. Outbound: the customer picks up first.
  const managerKey = direction === 'inbound' ? first : (speakers.find((s) => s !== first) ?? first)
  return { method: 'first speaker', managerKey, detail: `${direction} call, no stronger signal` }
}

// ---- personal data ----

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ноль: '0', один: '1', одна: '1', два: '2', две: '2', три: '3', четыре: '4', пять: '5', шесть: '6', семь: '7', восемь: '8', девять: '9',
}
const CARD_DETAILS = /(срок|действ|expir|valid (thru|until)|cvv|cvc|security code|код на обороте|три цифры)/i

/** Runs of spoken or written digits ("four two seven six, 3800, …"):
 * [start, end, digitCount] in character offsets. */
function digitRuns(text: string): [number, number, number][] {
  const runs: [number, number, number][] = []
  const re = /[\p{L}\d]+/gu
  let cur: [number, number, number] | null = null
  let lastEnd = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = m[0].toLowerCase()
    const digits = /^\d+$/.test(w) ? w.length : DIGIT_WORDS[w] ? 1 : 0
    const gap = text.slice(lastEnd, m.index)
    if (digits && cur && /^[\s,\-–.]*$/.test(gap) && !/\.\s/.test(gap)) {
      cur[1] = m.index + w.length
      cur[2] += digits
    } else if (digits) {
      if (cur) runs.push(cur)
      cur = [m.index, m.index + w.length, digits]
    } else if (cur) {
      runs.push(cur)
      cur = null
    }
    lastEnd = m.index + m[0].length
  }
  if (cur) runs.push(cur)
  return runs
}

const EMAIL_RE = /\b[\w.+-]+(?:@| at )[\w-]+(?:\.| dot )(?:[\w-]+(?:\.| dot ))*(?:com|net|org|io|ru|co|uk)\b/gi

export function redact(text: string): { text: string; kinds: string[] } {
  const kinds: string[] = []
  let out = text
  // Replace from the end so earlier offsets stay valid.
  for (const [s, e, n] of digitRuns(out).reverse()) {
    if (n >= 13 && n <= 19) {
      out = out.slice(0, s) + '[card number]' + out.slice(e)
      kinds.push('card number')
    } else if (n >= 7 && n <= 12) {
      out = out.slice(0, s) + '[phone]' + out.slice(e)
      kinds.push('phone')
    }
  }
  if (kinds.includes('card number')) {
    // Expiry and security code: from the keyword to the end of the sentence.
    out = out
      .split(/(?<=[.!?])\s+/)
      .map((s) => {
        const m = CARD_DETAILS.exec(s)
        return m ? `${s.slice(0, m.index)}[card details]` : s
      })
      .join(' ')
      .replace(/(\[card details\])(\s*\[card details\])+/g, '$1')
    if (out.includes('[card details]')) kinds.push('card details')
  }
  out = out.replace(EMAIL_RE, () => {
    kinds.push('email')
    return '[email]'
  })
  return { text: out, kinds }
}

// ---- assembly ----

export function prepare(record: CallRecord): Transcript {
  const sorted = [...record.stt.utterances].sort((a, b) => a.start - b.start)
  const kept: SttUtterance[] = []
  const dropped: DroppedUtterance[] = []
  sorted.forEach((u, i) => {
    const pause = i ? u.start - sorted[i - 1].end : 0
    const reason = hallucinationReason(u, pause, i === sorted.length - 1)
    if (reason) dropped.push({ start: u.start, text: u.text, reason })
    else kept.push(u)
  })
  const roles = detectRoles(kept, record.direction)
  const byChannel = roles.method === 'channel'
  const redactions: Transcript['redactions'] = []
  const utterances: Utterance[] = kept.map((u, i) => {
    const id = `U${i + 1}`
    const r = redact(u.text)
    for (const kind of new Set(r.kinds)) redactions.push({ utterance: id, kind })
    return {
      id,
      role: (keyOf(u, byChannel) === roles.managerKey ? 'manager' : 'customer') as Role,
      start: u.start,
      end: u.end,
      text: r.text,
      confidence: u.confidence,
    }
  })
  return { utterances, dropped, roles, redactions }
}

/** "[01:07] U5 Manager: …" lines: what the model sees. */
export function formatDialogue(t: Transcript): string {
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  return t.utterances.map((u) => `[${mmss(u.start)}] ${u.id} ${u.role === 'manager' ? 'Manager' : 'Customer'}: ${u.text}`).join('\n')
}

export function metricsOf(t: Transcript): Metrics {
  const us = t.utterances
  if (!us.length) return { durationSec: 0, managerTalkShare: 0, managerQuestions: 0, longestMonologueSec: 0, interruptions: 0, longestPauseSec: 0 }
  const talk = (role: Role) => us.filter((u) => u.role === role).reduce((s, u) => s + (u.end - u.start), 0)
  const m = talk('manager')
  const c = talk('customer')
  let longest = 0
  let runStart = us[0].start
  let interruptions = 0
  let pause = 0
  for (let i = 0; i < us.length; i++) {
    const u = us[i]
    const prev = us[i - 1]
    if (prev && prev.role !== u.role) runStart = u.start
    longest = Math.max(longest, u.end - runStart)
    if (prev && prev.role === 'customer' && u.role === 'manager' && u.start < prev.end - 0.5) interruptions++
    if (prev) pause = Math.max(pause, u.start - prev.end)
  }
  return {
    durationSec: Math.round(us.at(-1)!.end - us[0].start),
    managerTalkShare: m + c ? Math.round((m / (m + c)) * 100) / 100 : 0,
    managerQuestions: us.filter((u) => u.role === 'manager').reduce((s, u) => s + (u.text.match(/\?/g)?.length ?? 0), 0),
    longestMonologueSec: Math.round(longest),
    interruptions,
    longestPauseSec: Math.round(Math.max(0, pause) * 10) / 10,
  }
}

const VOICEMAIL = /leave (a|your) message|after the (tone|beep)|not available right now|оставьте (сообщение|ваше)|после (звукового )?сигнала|абонент не может/i

/** Calls that are not worth a model call. */
export function skipReason(t: Transcript, m: Metrics): string | null {
  const first = t.utterances.find((u) => u.role === 'customer')
  if (first && VOICEMAIL.test(first.text)) return 'voicemail'
  if (m.durationSec < 20) return `too short (${m.durationSec} s)`
  const roles = new Set(t.utterances.map((u) => u.role))
  if (roles.size < 2) return 'only one side of the call was recorded'
  const managerWords = t.utterances.filter((u) => u.role === 'manager').reduce((s, u) => s + u.text.split(/\s+/).length, 0)
  if (managerWords < 15) return 'the manager barely spoke'
  return null
}

// ---- pasted transcripts ----

const MANAGER_LABEL = /^(manager|agent|sales|менеджер|оператор)$/i
const CUSTOMER_LABEL = /^(customer|client|caller|клиент|покупатель)$/i

/** "Manager: …" / "Customer: …" lines become a stereo-like recording (the
 * roles are known); any other labels ("Speaker 1", "Anna", "A") become
 * diarized speakers whose roles the pipeline has to work out. An optional
 * "[01:05]" in front sets the time, otherwise it is estimated from length. */
export function parsePasted(text: string): SttUtterance[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const parsed = lines.flatMap((l) => {
    const m = /^(?:\[?(\d{1,2}):(\d{2})\]?\s*)?([^:]{1,30}):\s*(.+)$/.exec(l)
    return m ? [{ at: m[1] ? Number(m[1]) * 60 + Number(m[2]) : null, label: m[3].trim(), text: m[4].trim() }] : []
  })
  const labels = [...new Set(parsed.map((p) => p.label))]
  const known = labels.every((l) => MANAGER_LABEL.test(l) || CUSTOMER_LABEL.test(l))
  let clock = 1
  return parsed.map((p) => {
    const start = p.at ?? clock + 0.6
    const end = start + p.text.split(/\s+/).length / 2.5 + 0.3
    clock = Math.max(clock, end)
    const who = known ? { channel: MANAGER_LABEL.test(p.label) ? MANAGER_CHANNEL : 1 - MANAGER_CHANNEL } : { speaker: labels.indexOf(p.label) }
    return { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, ...who, text: p.text, confidence: 1 }
  })
}
