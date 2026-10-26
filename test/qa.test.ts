process.env.DATA_WRITE = '0'
process.env.LLM_CACHE_WRITE = '0'
// Scoring in these tests replays data/llm-cache.json, never a live model.
process.env.LLM_API_KEY = ''
process.env.OPENROUTER_API_KEY = ''

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CallResult } from '../src/types.ts'
const { calls, managerById, scorecard } = await import('../src/store.ts')
const { marginMarks, statusStrip } = await import('../src/margin.ts')
const { detectRoles, hallucinationReason, metricsOf, parsePasted, prepare, redact, skipReason } = await import('../src/transcript.ts')
const { percentages, ruleFlags } = await import('../src/rules.ts')
const { dueFromTranscript, mentionsTime, finalize, mergeFlags, reconcileDue, score, validate } = await import('../src/scorer.ts')

const call = (id: string) => calls.find((c) => c.id === id)!
const prepared = (id: string) => prepare(call(id))

test('stereo calls take roles from the channel, mono calls from what is said', () => {
  assert.equal(prepared('c-101').roles.method, 'channel')
  // c-102: the customer speaks first and asks "is this Northwind?".
  const r102 = prepared('c-102')
  assert.equal(r102.roles.method, 'phrases')
  assert.equal(r102.roles.managerKey, 'speaker 1')
  assert.equal(r102.utterances[0].role, 'customer')
  assert.equal(prepared('c-107').roles.managerKey, 'speaker 0')
  assert.equal(prepared('c-111').roles.managerKey, 'speaker 1')
  // No signal at all: inbound → whoever answered, outbound → the other side.
  const plain = [{ start: 0, end: 1, speaker: 0, text: 'Hello.', confidence: 1 }, { start: 2, end: 3, speaker: 1, text: 'Hi there.', confidence: 1 }]
  assert.equal(detectRoles(plain, 'inbound').managerKey, 'speaker 0')
  assert.equal(detectRoles(plain, 'outbound').managerKey, 'speaker 1')
})

test('recogniser hallucinations and filler are dropped, real speech is kept', () => {
  const t = prepared('c-110')
  assert.deepEqual(t.dropped.map((d) => d.text), ['Thanks for watching!'])
  assert.equal(hallucinationReason({ start: 0, end: 1, text: 'Thanks for watching, see you on Friday then.', confidence: 0.95 }, 0.5, false), null)
  assert.equal(hallucinationReason({ start: 0, end: 1, text: 'Продолжение следует...', confidence: 0.4 }, 0, false), 'known recogniser hallucination')
  assert.equal(hallucinationReason({ start: 0, end: 1, text: 'Umm...', confidence: 0.9 }, 0, false), 'filler')
})

test('card numbers, card details and emails are masked before the model sees them', () => {
  const t = prepared('c-108')
  const u = t.utterances.find((x) => x.id === t.redactions.find((r) => r.kind === 'card number')!.utterance)!
  assert.equal(u.text, '[card number]. [card details]')
  assert.ok(!/nine one two|four two seven six/i.test(JSON.stringify(t.utterances)))
  assert.equal(redact('My card is 4276 3800 1234 5678, expires 08/28.').text, 'My card is [card number], [card details]')
  assert.equal(redact('Email tom.keller at brightline dot com please').text, 'Email [email] please')
  assert.equal(redact('Call me on 555 0142 77').text, 'Call me on [phone]')
  // A serial number or a price is not personal data.
  assert.deepEqual(redact('Serial NWR4 0 8 8 2 1, price 355 dollars').kinds, [])
})

test('metrics come from timings: interruptions, monologues, talk share', () => {
  const m = metricsOf(prepared('c-109'))
  assert.equal(m.interruptions, 3)
  assert.ok(m.longestMonologueSec > 25)
  assert.equal(metricsOf(prepared('c-101')).interruptions, 0)
  assert.equal(metricsOf(prepared('c-102')).managerQuestions, 1)
})

test('voicemail, wrong numbers and one-sided calls are skipped without a model call', () => {
  const skip = (id: string) => {
    const t = prepared(id)
    return skipReason(t, metricsOf(t))
  }
  assert.equal(skip('c-105'), 'voicemail')
  assert.match(skip('c-106')!, /^too short/)
  assert.equal(skip('c-101'), null)
  const oneSided = prepare({ ...call('c-101'), stt: { provider: 'x', utterances: call('c-101').stt.utterances.filter((u) => u.channel === 0) } })
  assert.equal(skipReason(oneSided, metricsOf(oneSided)), 'only one side of the call was recorded')
})

test('rules flag unapproved discounts, guaranteed delivery and card details', () => {
  assert.deepEqual(percentages('I can do fifteen percent off, or 3% more, десять процентов'), [15, 3, 10])
  const types = (id: string) => ruleFlags(prepared(id)).map((f) => f.type)
  assert.deepEqual(types('c-103'), ['unapproved_discount', 'delivery_promise'])
  assert.deepEqual(types('c-108'), ['payment_data'])
  // Asking the head of sales for a discount is the right thing, not a breach.
  for (const id of ['c-101', 'c-104', 'c-107', 'c-110', 'c-111']) assert.deepEqual(types(id), [], id)
})

test('validation: invented ids, customer-only evidence and unknown criteria do not count', () => {
  const t = prepared('c-101')
  const raw = {
    summary: 'x',
    criteria: {
      greeting: { score: 2, evidence: ['U1'], comment: 'ok' },
      discovery: { score: '2', evidence: ['U2', 'U4'], comment: 'customer lines only' },
      recommendation: { score: 2, evidence: ['U99', 'U13'], comment: 'one invented id' },
      objections: { score: null, evidence: [], comment: 'none raised' },
      closing: { score: null, evidence: [], comment: 'not allowed' },
      listening: { score: 7, evidence: ["U3"] },
      compliance: { score: 2, evidence: [], comment: 'no breaches' },
      empathy: { score: 2, evidence: ['U1'] },
    },
  }
  const p = validate(raw, t, scorecard)
  const by = Object.fromEntries(p.assessment.criteria.map((c) => [c.id, c]))
  assert.equal(by.greeting.status, 'scored')
  assert.equal(by.discovery.status, 'unverified')
  assert.equal(by.recommendation.status, 'scored')
  assert.deepEqual(by.recommendation.evidence, ['U13'])
  assert.match(by.recommendation.notes[0], /U99/)
  assert.equal(by.objections.status, 'not applicable')
  assert.equal(by.closing.status, 'missing')
  assert.equal(by.listening.status, 'missing')
  assert.equal(by.compliance.status, 'scored', 'compliance is judged by the absence of breaches')
  assert.deepEqual(p.missing, ['closing', 'listening'])
  assert.match(p.problems[0], /empathy/)
  assert.ok(p.problems.some((x) => /^listening: score 7 is not 0, 1 or 2/.test(x)))
  // "3 of 3" from a model that took the weight for the scale.
  const top = validate({ criteria: { closing: { score: 3, evidence: ['U21'] } } }, t, scorecard).assessment.criteria.find((c) => c.id === 'closing')!
  assert.equal(top.score, 2)
  assert.equal(top.status, 'scored')
  assert.match(top.notes[0], /read as 2/)
})

test('the total is computed from verified scores; rule flags override compliance', () => {
  const t = prepared('c-103')
  const raw = {
    criteria: Object.fromEntries(scorecard.criteria.map((c) => [c.id, { score: 2, evidence: ['U2'], comment: '' }])),
    red_flags: [{ type: 'unapproved_discount', utterance: 'U6', note: '15% off' }],
  }
  const p = validate(raw, t, scorecard)
  p.assessment.redFlags = mergeFlags(ruleFlags(t), p.assessment.redFlags, t).flags
  assert.deepEqual(p.assessment.redFlags.map((f) => `${f.type}:${f.source}`), ['unapproved_discount:rules + model', 'delivery_promise:rules'])
  const { assessment } = finalize(p.assessment, scorecard, '2026-10-12', t)
  const compliance = assessment.criteria.find((c) => c.id === 'compliance')!
  assert.equal(compliance.status, 'overridden')
  assert.equal(compliance.score, 0)
  // Facts cap discovery at 1 (one question asked) and closing at 1 (no date):
  // greeting 2×1, discovery 1×3, recommendation 2×2, objections 2×2, closing 1×3, listening 2×1, compliance 0×2.
  assert.equal(assessment.total, Math.round((100 * (2 + 3 + 4 + 4 + 3 + 2 + 0)) / 28))
  assert.equal(assessment.passed, false, 'a critical zero fails the call whatever the total')
  // Below half of the weight verified: no number at all.
  const thin = validate({ criteria: { greeting: { score: 2, evidence: ['U2'] } } }, t, scorecard)
  assert.equal(finalize(thin.assessment, scorecard, '2026-10-12').assessment.total, null)
})

test('the next-step date follows the weekday the manager named', () => {
  // 2026-10-12 is a Monday.
  assert.deepEqual(reconcileDue('2026-10-15', 'Email the quote by Thursday', '2026-10-12'), { due: '2026-10-15', note: null })
  assert.equal(reconcileDue('2026-10-16', 'Email the quote by Thursday', '2026-10-12').due, '2026-10-15')
  assert.equal(reconcileDue(null, 'Engineer visit on Wednesday morning', '2026-10-13').due, '2026-10-14')
  assert.equal(reconcileDue('2025-01-01', 'Send the quote', '2026-10-12').due, null)
  assert.equal(reconcileDue('soon', 'Send the quote', '2026-10-12').due, null)
  assert.equal(reconcileDue('2026-10-19 Monday', 'Send the quote', '2026-10-12').due, '2026-10-19')
})

test('pasted transcripts: labelled roles become channels, other labels speakers', () => {
  const labelled = parsePasted('Manager: Northwind Air, Anna.\nCustomer: Hi, I need a fan.\n[00:20] Manager: Sure.')
  assert.deepEqual(labelled.map((u) => u.channel), [0, 1, 0])
  assert.equal(labelled[2].start, 20)
  const named = parsePasted('Paul: Hi, is this Northwind?\nAnna: Yes, Northwind Air, Anna speaking.')
  assert.deepEqual(named.map((u) => u.speaker), [0, 1])
  assert.equal(detectRoles(named, 'inbound').managerKey, 'speaker 1')
})

test('scores that contradict measured facts are capped', () => {
  // c-109: the manager asks no questions and interrupts three times.
  const t = prepared('c-109')
  const raw = {
    next_step: { action: 'Customer sends the drawings', due: null },
    criteria: Object.fromEntries(scorecard.criteria.map((c) => [c.id, { score: 2, evidence: ['U3'], comment: '' }])),
  }
  const p = validate(raw, t, scorecard)
  const { assessment } = finalize(p.assessment, scorecard, '2026-10-14', t)
  const by = Object.fromEntries(assessment.criteria.map((c) => [c.id, c]))
  assert.deepEqual([by.discovery.score, by.listening.score, by.closing.score], [0, 0, 1])
  assert.equal(by.discovery.status, 'capped')
  assert.match(by.listening.notes[0], /3 interruptions/)
  assert.match(by.closing.notes[0], /no date/)
  assert.equal(by.greeting.status, 'scored')
})

test('a model flag for a discount within the limit is rejected and overrides nothing', () => {
  const t = prepare({ ...call('c-101'), stt: { provider: 'pasted text', utterances: parsePasted('Manager: Northwind Air, Anna.\nCustomer: It is too expensive.\nManager: I can give you five percent today; above that I need approval.\nCustomer: Fine.') } })
  const m = mergeFlags([], [{ type: 'unapproved_discount', utterance: 'U3', note: '5% discount', source: 'model' }], t)
  assert.equal(m.flags.length, 0)
  assert.match(m.rejected[0], /within the 5% limit/)
  // A model-only compliance flag does not overrule the model's compliance score.
  const raw = { criteria: { compliance: { score: 2, evidence: [] } }, red_flags: [{ type: 'delivery_promise', note: 'maybe' }] }
  const p = validate(raw, t, scorecard)
  p.assessment.redFlags = mergeFlags([], p.assessment.redFlags, t).flags
  assert.equal(finalize(p.assessment, scorecard, '2026-10-12', t).assessment.criteria.find((c) => c.id === 'compliance')!.score, 2)
})

test('without a date from the model, the manager\'s promise at the end supplies one', () => {
  const t = prepared('c-111')
  // "I'll email the quote today" (2026-10-14) comes before "If you confirm by Friday".
  assert.deepEqual(dueFromTranscript(t, '2026-10-14')?.due, '2026-10-14')
  const pasted = prepare({ ...call('c-101'), stt: { provider: 'x', utterances: parsePasted('Manager: Hello.\nCustomer: Hi.\nManager: I can give five percent today.\nCustomer: Ok.\nManager: I will call you on Thursday morning.') } })
  assert.equal(dueFromTranscript(pasted, '2026-10-12')?.due, '2026-10-15')
  assert.equal(dueFromTranscript(prepared('c-107'), '2026-10-13'), null, '"let\'s talk again sometime" has no date')
})

test('a next-step date is kept only if the call names a day or time', () => {
  assert.equal(mentionsTime(prepared('c-109')), false)
  for (const id of ['c-101', 'c-103', 'c-104', 'c-108', 'c-111']) assert.ok(mentionsTime(prepared(id)), id)
  const t = prepared('c-109')
  const p = validate({ next_step: { action: 'Customer sends drawings', due: '2026-10-15' }, criteria: { closing: { score: 2, evidence: ['U15'] } } }, t, scorecard)
  const { assessment, notes } = finalize(p.assessment, scorecard, '2026-10-14', t)
  assert.equal(assessment.nextStep!.due, null)
  assert.ok(notes.some((n) => /no day or time/.test(n)))
  assert.equal(assessment.criteria.find((c) => c.id === 'closing')!.score, 1)
})

test('flags of the same kind merge into one, with every utterance kept', () => {
  const t = prepared('c-108')
  const m = mergeFlags(ruleFlags(t), [
    { type: 'payment_data', utterance: 'U4', note: 'asked for the card number', source: 'model' },
    { type: 'rudeness', utterance: 'U2', note: 'a', source: 'model' },
    { type: 'rudeness', utterance: 'U6', note: 'b', source: 'model' },
  ], t)
  assert.deepEqual(m.flags.map((f) => `${f.type}:${f.source}:${f.utterance}:${(f.also ?? []).join(',')}`), ['payment_data:rules + model:U5:U4', 'rudeness:model:U2:U6'])
})

/** c-108 as the demo shows it without a key: the recorded model answer, verified. */
async function scored108(): Promise<CallResult> {
  const c = call('c-108')
  const transcript = prepare(c)
  const out = await score(c, transcript, scorecard, managerById(c.managerId))
  assert.ok(out.ok && out.source === 'replay', 'c-108 replays from the recording')
  return { id: c.id, status: 'scored', attempts: { stt: 1, llm: 1 }, transcript, assessment: out.assessment, trace: [], updatedAt: '' }
}

test('the transcript margin shows each citing criterion with its verified score, and masks', async () => {
  const r = await scored108()
  const marks = marginMarks(r.assessment, r.transcript!)
  const labels = (id: string) => (marks[id] ?? []).map((m) => m.label)
  assert.ok(labels('U2').includes('GREETING 2/2'))
  // Card details read out: the rules confirmed the breach, so the zero is theirs too.
  assert.deepEqual(labels('U4'), ['COMPLIANCE 0/2 · RULE'])
  assert.deepEqual(labels('U5'), ['COMPLIANCE 0/2 · RULE', 'MASKED'])
  assert.equal(marks.U5.find((m) => m.label === 'MASKED')!.title, 'masked before analysis: card number, card details')
  assert.equal(marks.U1, undefined)
  // A model-only flag does not make the zero a rule's, and unknown ids are ignored.
  const a = structuredClone(r.assessment!)
  a.redFlags = a.redFlags.map((f) => ({ ...f, source: 'model' as const }))
  a.criteria.find((c) => c.id === 'compliance')!.evidence.push('U99')
  const m2 = marginMarks(a, r.transcript!)
  assert.deepEqual(m2.U4.map((m) => m.label), ['COMPLIANCE 0/2'])
  assert.equal(m2.U99, undefined)
})

test('the call header strip sums up id, duration, roles, criteria, flags and verdict', async () => {
  const s = statusStrip(call('c-108'), await scored108()).map((x) => x.text)
  assert.deepEqual(s, ['c-108', `${Math.floor(call('c-108').audio.durationSec / 60)}:${String(call('c-108').audio.durationSec % 60).padStart(2, '0')}`, 'roles by channel', '7 criteria · 1 n/a', '1 red flag', '42/100 · fail'])
  assert.deepEqual(statusStrip(call('c-108'), undefined).map((x) => x.text).slice(2), ['queued'])
})
