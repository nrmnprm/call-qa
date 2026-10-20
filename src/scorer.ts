/** Transcript → assessment. The model reads the call and fills in the
 * scorecard; the server decides what to believe:
 *
 *  - every score above zero must cite utterance ids of the manager that exist
 *    in this call, otherwise it is "unverified" and left out of the total;
 *  - "not applicable" is accepted only where the scorecard allows it;
 *  - unknown criteria are dropped, missing ones get one corrective retry;
 *  - red flags found by rules are merged in and override a model that called
 *    the call compliant;
 *  - the total and pass/fail are computed here from the weights, never taken
 *    from the model;
 *  - the next-step date is checked against the weekday the manager named;
 *  - scores that contradict measured facts are capped (no questions asked,
 *    repeated interruptions, a next step without a date). */
import { createHash } from 'node:crypto'
import { extractJson } from './json.ts'
import { complete, LLM_MODEL, type Message } from './llm.ts'
import { DISCOUNT_LIMIT, percentages, ruleFlags } from './rules.ts'
import { formatDialogue, metricsOf } from './transcript.ts'
import type { Assessment, CallRecord, Criterion, CriterionResult, FlagType, Manager, Metrics, RedFlag, Score, Scorecard, TraceStep, Transcript } from './types.ts'

/** Part of the result key; bump when the prompt or the checks change. */
export const PROMPT_VERSION = 8
const REPORT_LANGUAGE = process.env.REPORT_LANGUAGE ?? 'English'
const FLAG_TYPES: FlagType[] = ['unapproved_discount', 'delivery_promise', 'payment_data', 'rudeness', 'other']
const COMPLIANCE_FLAGS: FlagType[] = ['unapproved_discount', 'delivery_promise', 'payment_data']
export const COUNTED: CriterionResult['status'][] = ['scored', 'overridden', 'capped']

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKDAY_RE: [RegExp, number][] = [
  [/\b(sunday|воскресень\w*)\b/i, 0], [/\b(monday|понедельник\w*)\b/i, 1], [/\b(tuesday|вторник\w*)\b/i, 2],
  [/\b(wednesday|сред[уаы])\b/i, 3], [/\b(thursday|четверг\w*)\b/i, 4], [/\b(friday|пятниц\w*)\b/i, 5], [/\b(saturday|суббот\w*)\b/i, 6],
]

const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return isoDay(d)
}
const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay()

export function calendar(callDay: string): string {
  return Array.from({ length: 8 }, (_, i) => {
    const d = addDays(callDay, i)
    return `${d} ${WEEKDAYS[weekdayOf(d)]}${i === 0 ? ' (day of the call)' : ''}`
  }).join('\n')
}

/** Small models count weekdays badly: "by Thursday" becomes the wrong date.
 * If the action names a weekday, the due date is the first such day after
 * the call. */
export function reconcileDue(due: string | null, action: string, callDay: string): { due: string | null; note: string | null } {
  const named = WEEKDAY_RE.find(([re]) => re.test(action))?.[1]
  // "2026-10-19 Monday" and similar: the date part is enough.
  const iso = due?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null
  const valid = iso && iso >= callDay && iso <= addDays(callDay, 90) ? iso : null
  if (named != null) {
    if (valid && weekdayOf(valid) === named) return { due: valid, note: null }
    let d = addDays(callDay, 1)
    while (weekdayOf(d) !== named) d = addDays(d, 1)
    return { due: d, note: `due date set to ${d}: the action says ${WEEKDAYS[named]}${due ? `, the model wrote ${due}` : ''}` }
  }
  if (due && !valid) return { due: null, note: `due date "${due}" ignored: not a date between the call and 90 days after it` }
  return { due: valid, note: null }
}

export function buildMessages(record: CallRecord, t: Transcript, card: Scorecard, manager: Manager | undefined): Message[] {
  const callDay = record.startedAt.slice(0, 10)
  const criteria = card.criteria
    // Weights stay on the server: in the prompt small models mistake them for the scale.
    .map((c) => {
      const extra = [c.optional ? 'may be null = not applicable' : '', c.scoredByAbsence ? '2 needs no evidence, 0 must cite the utterance' : ''].filter(Boolean)
      return `- ${c.id}: ${c.title}${extra.length ? ` (${extra.join('; ')})` : ''}. ${c.description}`
    })
    .join('\n')
  const system = [
    'You review recorded sales calls of Northwind Air, a distributor of ventilation equipment, for the head of sales.',
    'Score the manager against the scorecard using only what is said in the transcript. Do not assume anything that was not said.',
    'Each line of the transcript has an utterance id (U1, U2, …). Cite these ids as evidence. Never cite an id that is not in the transcript.',
    'Evidence for a score of 1 or 2 must include at least one Manager utterance that shows the behaviour (except where the scorecard says evidence is not needed).',
    'Fragments like [card number] or [email] were masked for privacy; take them as what they name.',
    `Write every text field in ${REPORT_LANGUAGE}, whatever the language of the call.`,
    'Reply with a single JSON object and nothing else.',
  ].join('\n')
  const user = [
    `Call: ${record.direction}, ${callDay} (${WEEKDAYS[weekdayOf(callDay)]}) at ${record.startedAt.slice(11, 16)}, manager ${manager?.name ?? record.managerId}, customer ${record.customer.company}.`,
    '',
    'Calendar for dating the next step:',
    calendar(callDay),
    '',
    'Scorecard. Scores: 0 = not done, 1 = partly, 2 = done well.',
    criteria,
    '',
    'Red flag types: unapproved_discount, delivery_promise, payment_data, rudeness, other.',
    '',
    'JSON shape:',
    '{"summary": "2-3 sentences: who called, what they need, how it ended",',
    ' "customer_need": "one line",',
    ' "outcome": "quote_requested | order | follow_up | service | lost | no_outcome",',
    ' "next_step": {"action": "what happens next", "due": "YYYY-MM-DD or null", "owner": "manager | customer | null"},',
    ' "criteria": {',
    card.criteria.map((c) => `   "${c.id}": {"score": 0 | 1 | 2${c.optional ? ' | null' : ''}, "evidence": ["U…"], "comment": "why"}`).join(',\n'),
    ' },',
    ' "red_flags": [{"type": "…", "utterance": "U7", "note": "what happened"}],',
    ' "coaching": "one concrete thing the manager should do differently next time"}',
    '',
    'Transcript:',
    formatDialogue(t),
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function keyOf(record: CallRecord, card: Scorecard): string {
  return createHash('sha256')
    .update(JSON.stringify([PROMPT_VERSION, LLM_MODEL, REPORT_LANGUAGE, record.direction, record.startedAt, record.managerId, record.stt.utterances, card]))
    .digest('hex')
    .slice(0, 16)
}

// ---- validation ----

interface Parsed {
  assessment: Omit<Assessment, 'total' | 'passed'>
  problems: string[]
  missing: string[]
}

const asText = (v: unknown, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function asScore(v: unknown): { score: Score | null; note?: string } | undefined {
  if (v === null || v === 'null' || v === 'n/a' || v === 'N/A') return { score: null }
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  if (n === 0 || n === 1 || n === 2) return { score: n }
  // "3 out of 3": the model used a longer scale for the top mark.
  if (typeof n === 'number' && Number.isInteger(n) && n > 2 && n <= 5) return { score: 2, note: `score ${n} read as 2 (the scale is 0–2)` }
  return undefined
}

export function validate(raw: Record<string, unknown>, t: Transcript, card: Scorecard): Parsed {
  const problems: string[] = []
  const ids = new Map(t.utterances.map((u) => [u.id, u]))
  const byId = new Map<string, Record<string, unknown>>()
  // Small models often return {"greeting": {...}} instead of a list.
  const list = Array.isArray(raw.criteria)
    ? raw.criteria
    : raw.criteria && typeof raw.criteria === 'object'
      ? 'id' in raw.criteria
        ? [raw.criteria]
        : Object.entries(raw.criteria as Record<string, unknown>).map(([id, v]) => (v && typeof v === 'object' ? { id, ...(v as object) } : { id, score: v }))
      : []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const id = asText(o.id, 40)
    if (!card.criteria.some((x) => x.id === id)) {
      if (id) problems.push(`unknown criterion "${id}" dropped`)
      continue
    }
    if (!byId.has(id)) byId.set(id, o)
  }
  const missing: string[] = []
  const criteria: CriterionResult[] = card.criteria.map((c: Criterion) => {
    const base = { id: c.id, title: c.title, weight: c.weight, evidence: [] as string[], comment: '', notes: [] as string[] }
    const o = byId.get(c.id)
    if (!o) {
      missing.push(c.id)
      return { ...base, score: null, status: 'missing' }
    }
    const comment = asText(o.comment, 400)
    const cited = (Array.isArray(o.evidence) ? o.evidence : []).map((e) => asText(e, 10).toUpperCase().replace(/^(\d+)$/, 'U$1'))
    const evidence = [...new Set(cited.filter((e) => ids.has(e)))]
    const notes: string[] = []
    const invented = cited.filter((e) => e && !ids.has(e))
    if (invented.length) notes.push(`ids not in the call dropped: ${invented.join(', ')}`)
    const parsedScore = asScore(o.score)
    if (parsedScore === undefined) {
      missing.push(c.id)
      problems.push(`${c.id}: score ${JSON.stringify(o.score ?? null)} is not 0, 1 or 2`)
      return { ...base, comment, notes: [...notes, `invalid score ${JSON.stringify(o.score)}`], score: null, status: 'missing' }
    }
    const score = parsedScore.score
    if (parsedScore.note) notes.push(parsedScore.note)
    if (score === null) {
      if (c.optional) return { ...base, comment, evidence, notes, score: null, status: 'not applicable' }
      missing.push(c.id)
      problems.push(`${c.id}: null (not applicable) is not allowed, score it 0, 1 or 2`)
      return { ...base, comment, notes: [...notes, '"not applicable" is not allowed for this criterion'], score: null, status: 'missing' }
    }
    if (score > 0 && !c.scoredByAbsence && !evidence.some((e) => ids.get(e)!.role === 'manager')) {
      notes.push('no manager utterance cited for a positive score')
      return { ...base, comment, evidence, notes, score, status: 'unverified' }
    }
    return { ...base, comment, evidence, notes, score, status: 'scored' }
  })

  const modelFlags: RedFlag[] = (Array.isArray(raw.red_flags) ? raw.red_flags : []).flatMap((f) => {
    if (!f || typeof f !== 'object') return []
    const o = f as Record<string, unknown>
    const type = FLAG_TYPES.includes(o.type as FlagType) ? (o.type as FlagType) : 'other'
    const u = asText(o.utterance, 10).toUpperCase()
    const note = asText(o.note, 300)
    if (!note && type === 'other') return []
    return [{ type, utterance: ids.has(u) ? u : null, note, source: 'model' as const }]
  })

  const ns = raw.next_step && typeof raw.next_step === 'object' ? (raw.next_step as Record<string, unknown>) : null
  const action = asText(ns?.action, 300)
  return {
    problems,
    missing,
    assessment: {
      summary: asText(raw.summary, 800),
      customerNeed: asText(raw.customer_need, 300),
      outcome: asText(raw.outcome, 40) || 'no_outcome',
      nextStep: action ? { action, due: asText(ns?.due, 20) || null, owner: asText(ns?.owner, 20) || null } : null,
      criteria,
      redFlags: modelFlags,
      coaching: asText(raw.coaching, 500),
    },
  }
}

/** Rules + model flags, one per type and utterance. A model's discount flag
 * is checked against the percentages actually said: "5% off" is within the
 * manager's limit, however the model reads the policy. */
export function mergeFlags(rules: RedFlag[], model: RedFlag[], t: Transcript): { flags: RedFlag[]; rejected: string[] } {
  const out = rules.map((f) => ({ ...f }))
  const rejected: string[] = []
  for (const f of model) {
    if (f.type === 'unapproved_discount') {
      const said = t.utterances.filter((u) => u.role === 'manager' && (!f.utterance || u.id === f.utterance)).flatMap((u) => percentages(u.text))
      if (said.length && said.every((p) => p <= DISCOUNT_LIMIT)) {
        rejected.push(`model flag "${f.note || f.type}" rejected: ${said.join('%, ')}% is within the ${DISCOUNT_LIMIT}% limit`)
        continue
      }
    }
    // One flag per kind of breach ("other" stays separate: they are unrelated).
    const same = f.type === 'other' ? null : out.find((r) => r.type === f.type)
    if (!same) {
      out.push({ ...f })
      continue
    }
    if (same.source === 'rules') same.source = 'rules + model'
    if (!same.utterance) same.utterance = f.utterance
    else if (f.utterance && f.utterance !== same.utterance && !same.also?.includes(f.utterance)) same.also = [...(same.also ?? []), f.utterance]
  }
  return { flags: out, rejected }
}

const COMMITMENT = /\b(I'?ll|I will|we'?ll|we will|I'?m going to|let'?s|call you|get back)\b|пришлю|отправлю|позвоню|перезвоню|созвонимся|отгрузим|приедет/i
const RELATIVE_DAY: [RegExp, number][] = [[/\b(today|tonight)\b|сегодня/i, 0], [/\btomorrow\b|завтра/i, 1]]

const MONTHS = /\b(january|february|march|april|may|june|july|august|september|october|november|december|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\b/i
const TIME_WORDS = /\b(today|tonight|tomorrow|within (the|an|the next) hours?|this (morning|afternoon|evening|week)|next week|end of (the )?day)\b|сегодня|завтра|до вечера|в течение (часа|дня)|на этой неделе|на следующей неделе/i

/** Does the call name any day or time at all? A model that dates a next
 * step nobody dated is making it up. */
export function mentionsTime(t: Transcript): boolean {
  return t.utterances.some((u) => TIME_WORDS.test(u.text) || MONTHS.test(u.text) || WEEKDAY_RE.some(([re]) => re.test(u.text)) || /\b\d{1,2}[./]\d{1,2}\b/.test(u.text))
}

/** When the model gives no date, the manager's own promise near the end of
 * the call ("I'll send it today and call you on Thursday") supplies one. */
export function dueFromTranscript(t: Transcript, callDay: string): { due: string; utterance: string } | null {
  const tail = t.utterances.filter((u) => u.role === 'manager').slice(-4)
  for (const u of tail) {
    for (const sentence of u.text.split(/(?<=[.!?])\s+/).filter((x) => COMMITMENT.test(x))) {
      const hits: [number, string][] = []
      for (const [re, n] of RELATIVE_DAY) {
        const m = re.exec(sentence)
        if (m) hits.push([m.index, addDays(callDay, n)])
      }
      for (const [re, wd] of WEEKDAY_RE) {
        const m = re.exec(sentence)
        if (!m) continue
        let d = addDays(callDay, 1)
        while (weekdayOf(d) !== wd) d = addDays(d, 1)
        hits.push([m.index, d])
      }
      if (hits.length) return { due: hits.sort((a, b) => a[0] - b[0])[0][1], utterance: u.id }
    }
  }
  return null
}

/** Caps from facts measured without the model: a model that calls a
 * monologue "good discovery" is overruled by the question count. */
function capByFacts(a: Omit<Assessment, 'total' | 'passed'>, m: Metrics, notes: string[]) {
  const cap = (id: string, max: Score, why: string) => {
    const c = a.criteria.find((x) => x.id === id)
    if (!c || c.score == null || c.score <= max || c.status !== 'scored') return
    c.notes.push(`model said ${c.score}, capped at ${max}: ${why}`)
    c.score = max
    c.status = 'capped'
    notes.push(`${id} capped: ${why}`)
  }
  if (m.managerQuestions === 0) cap('discovery', 0, 'the manager asked no questions')
  else if (m.managerQuestions === 1) cap('discovery', 1, 'the manager asked one question')
  if (m.interruptions >= 3) cap('listening', 0, `${m.interruptions} interruptions measured from timings`)
  else if (m.interruptions === 2) cap('listening', 1, '2 interruptions measured from timings')
  if (!a.nextStep?.due) cap('closing', 1, a.nextStep ? 'the next step has no date' : 'no next step')
}

export function finalize(a: Omit<Assessment, 'total' | 'passed'>, card: Scorecard, callDay: string, t?: Transcript): { assessment: Assessment; notes: string[] } {
  const notes: string[] = []
  const compliance = a.criteria.find((c) => c.id === 'compliance')
  // Only what the rules confirmed may overrule the model's own judgement.
  const breaches = a.redFlags.filter((f) => COMPLIANCE_FLAGS.includes(f.type) && f.source !== 'model')
  if (compliance && breaches.length && compliance.score !== 0) {
    compliance.notes.push(`model said ${compliance.score ?? 'nothing'}; set to 0: ${breaches.map((f) => f.note || f.type).join('; ')}`)
    compliance.score = 0
    compliance.status = 'overridden'
    compliance.evidence = [...new Set([...compliance.evidence, ...breaches.flatMap((f) => (f.utterance ? [f.utterance] : []))])]
    notes.push('compliance overridden by red flags')
  }
  if (a.nextStep) {
    const r = reconcileDue(a.nextStep.due, a.nextStep.action, callDay)
    a.nextStep.due = r.due
    if (r.note) notes.push(r.note)
    if (a.nextStep.due && t && !mentionsTime(t)) {
      notes.push(`due date ${a.nextStep.due} dropped: no day or time is named in the call`)
      a.nextStep.due = null
    }
    const said = !r.due && t ? dueFromTranscript(t, callDay) : null
    if (said) {
      a.nextStep.due = said.due
      notes.push(`due date ${said.due} taken from the manager's promise in ${said.utterance}`)
    }
  }
  if (t) capByFacts(a, metricsOf(t), notes)
  const counted = a.criteria.filter((c) => COUNTED.includes(c.status) && c.score != null)
  const possible = a.criteria.filter((c) => c.status !== 'not applicable').reduce((s, c) => s + c.weight, 0)
  const countedWeight = counted.reduce((s, c) => s + c.weight, 0)
  // Below half of the weight verified, a number would be misleading.
  const total = countedWeight * 2 >= possible && countedWeight > 0
    ? Math.round((100 * counted.reduce((s, c) => s + c.weight * c.score!, 0)) / (2 * countedWeight))
    : null
  if (total == null) notes.push('not enough verified scores for a total')
  const criticalZero = a.criteria.some((c) => card.criteria.find((x) => x.id === c.id)?.critical && c.score === 0)
  if (!a.coaching) {
    const weakest = [...counted].sort((x, y) => x.score! - y.score! || y.weight - x.weight)[0]
    if (weakest && weakest.score! < 2) a.coaching = `Work on "${weakest.title}": ${card.criteria.find((c) => c.id === weakest.id)?.description}`
  }
  return { assessment: { ...a, total, passed: total != null && total >= card.passMark && !criticalZero }, notes }
}

// ---- the whole step ----

export type ScoreOutcome =
  | { ok: true; assessment: Assessment; model: string; source: 'live' | 'replay'; usage: { promptTokens: number; completionTokens: number; costUsd: number | null; latencyMs: number }; steps: TraceStep[] }
  | { ok: false; error: string; steps: TraceStep[] }

/** Simulated provider outage, toggled from the UI to show retries and alerts. */
export const outage = { on: false }

export async function score(record: CallRecord, t: Transcript, card: Scorecard, manager: Manager | undefined): Promise<ScoreOutcome> {
  const steps: TraceStep[] = []
  const messages = buildMessages(record, t, card, manager)
  steps.push({ name: 'prompt', ok: true, ms: 0, detail: `${messages[1].content!.length} chars, ${t.utterances.length} utterances`, data: messages })
  const usage = { promptTokens: 0, completionTokens: 0, costUsd: null as number | null, latencyMs: 0 }
  let parsed: Parsed | null = null
  let model = LLM_MODEL
  let source: 'live' | 'replay' = 'live'
  for (let round = 1; round <= 2; round++) {
    if (outage.on) {
      steps.push({ name: `model, round ${round}`, ok: false, ms: 0, detail: 'simulated outage: HTTP 503' })
      return { ok: false, error: 'HTTP 503 (simulated outage)', steps }
    }
    // Reasoning models spend part of the budget thinking before the JSON.
    const r = await complete({ messages, json: true, temperature: 0.1, maxTokens: 4000 })
    if (!r.ok) {
      steps.push({ name: `model, round ${round}`, ok: false, ms: r.latencyMs, detail: r.error })
      if (parsed) break // keep what the first round gave
      return { ok: false, error: r.error, steps }
    }
    model = r.model
    source = r.source
    usage.latencyMs += r.latencyMs
    usage.promptTokens += r.usage?.promptTokens ?? 0
    usage.completionTokens += r.usage?.completionTokens ?? 0
    if (r.usage?.costUsd != null) usage.costUsd = (usage.costUsd ?? 0) + r.usage.costUsd
    const content = r.message.content ?? ''
    const raw = extractJson(content)
    const p = raw ? validate(raw, t, card) : null
    const bad = p
      ? [...p.problems, ...p.missing.filter((m) => !p.problems.some((x) => x.startsWith(`${m}:`))).map((m) => `criterion "${m}" is missing`)]
      : ['reply is not a JSON object']
    const unverified = p?.assessment.criteria.filter((c) => c.status === 'unverified') ?? []
    const roleOf = (id: string) => (t.utterances.find((u) => u.id === id)?.role === 'manager' ? 'Manager' : 'Customer')
    for (const c of unverified) {
      bad.push(`${c.id}: score ${c.score} cites ${c.evidence.length ? c.evidence.map((e) => `${e} (${roleOf(e)})`).join(', ') : 'nothing'}; cite the Manager utterance(s) that show it, or lower the score`)
    }
    steps.push({
      name: `model, round ${round}`,
      ok: !!p,
      ms: r.latencyMs,
      detail: `${r.source}${r.source === 'replay' ? ` (recorded ${r.recordedAt?.slice(0, 10)})` : ''}, ${r.usage ? `${r.usage.promptTokens}+${r.usage.completionTokens} tokens` : 'no usage report'}${bad.length ? `; ${bad.length} problem(s)` : ''}`,
      data: { reply: content, problems: bad },
    })
    // Keep the better of the two rounds: fewer missing and unverified criteria.
    const quality = (x: Parsed) => x.missing.length * 2 + x.assessment.criteria.filter((c) => c.status === 'unverified').length
    if (p && (!parsed || quality(p) < quality(parsed))) parsed = p
    if (p && !p.missing.length && !unverified.length) break
    if (round === 1) {
      messages.push(
        { role: 'assistant', content },
        {
          role: 'user',
          content: `Your reply has problems:\n- ${bad.join('\n- ')}\nReply again with the complete JSON object in the same shape. "criteria" must have exactly these keys: ${card.criteria.map((c) => c.id).join(', ')}.`,
        },
      )
    }
  }
  if (!parsed) return { ok: false, error: 'the model did not return a usable JSON object', steps }
  const rules = ruleFlags(t)
  const merged = mergeFlags(rules, parsed.assessment.redFlags, t)
  parsed.assessment.redFlags = merged.flags
  const { assessment, notes } = finalize(parsed.assessment, card, record.startedAt.slice(0, 10), t)
  notes.unshift(...merged.rejected)
  steps.push({
    name: 'checks',
    ok: true,
    ms: 0,
    detail: [
      `${assessment.criteria.filter((c) => c.status === 'scored').length}/${assessment.criteria.length} verified`,
      rules.length ? `${rules.length} rule flag(s)` : 'no rule flags',
      ...notes,
    ].join('; '),
    data: { criteria: assessment.criteria.map(({ id, score, status, evidence, notes }) => ({ id, score, status, evidence, notes })), ruleFlags: rules },
  })
  return { ok: true, assessment, model, source, usage, steps }
}
