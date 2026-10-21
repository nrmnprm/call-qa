/** What the call view shows beside the transcript and above it: each
 * utterance gets a mark for every criterion that cites it (with the verified
 * score) and for every mask applied to it; the header gets one status line. */
import { ruleBreach } from './scorer.ts'
import type { Assessment, CallRecord, CallResult, Transcript } from './types.ts'

export interface MarginMark {
  label: string
  kind: 'pass' | 'partial' | 'fail' | 'none' | 'mask'
  /** Criterion id, so the client can jump to its scorecard row. */
  criterion?: string
  title: string
}

const STATUS_TAG: Partial<Record<string, string>> = { capped: 'CAPPED', unverified: 'UNVERIFIED' }

export function marginMarks(a: Assessment | undefined, t: Transcript): Record<string, MarginMark[]> {
  const marks: Record<string, MarginMark[]> = {}
  const add = (id: string, m: MarginMark) => (marks[id] ??= []).push(m)
  const known = new Set(t.utterances.map((u) => u.id))
  // Utterances where the rules (not just the model) confirmed a policy breach.
  const ruled = new Set((a?.redFlags ?? []).filter(ruleBreach).flatMap((f) => [f.utterance, ...(f.also ?? [])]).filter((x): x is string => !!x))
  for (const c of a?.criteria ?? []) {
    for (const id of new Set(c.evidence)) {
      if (!known.has(id)) continue
      const rule = c.id === 'compliance' && (c.status === 'overridden' || ruled.has(id))
      const tag = rule ? 'RULE' : STATUS_TAG[c.status]
      add(id, {
        label: `${c.id.toUpperCase()} ${c.score == null ? '—' : `${c.score}/2`}${tag ? ` · ${tag}` : ''}`,
        kind: c.score == null ? 'none' : c.score === 2 ? 'pass' : c.score === 1 ? 'partial' : 'fail',
        criterion: c.id,
        title: `${c.title}: ${c.score == null ? 'no score' : `${c.score} of 2`}${rule ? ', breach confirmed by the rules' : tag ? `, ${c.status}` : ''}`,
      })
    }
  }
  const kinds: Record<string, string[]> = {}
  for (const r of t.redactions) (kinds[r.utterance] ??= []).push(r.kind)
  for (const [id, k] of Object.entries(kinds)) {
    if (known.has(id)) add(id, { label: 'MASKED', kind: 'mask', title: `masked before analysis: ${[...new Set(k)].join(', ')}` })
  }
  return marks
}

/** One line of facts for the call header, in display order. */
export function statusStrip(c: CallRecord, r: CallResult | undefined): { text: string; tone?: 'good' | 'bad' }[] {
  const s: { text: string; tone?: 'good' | 'bad' }[] = [{ text: c.id }, { text: duration(c.audio.durationSec) }]
  if (r?.transcript) s.push({ text: `roles by ${r.transcript.roles.method}` })
  const a = r?.assessment
  if (!a) {
    s.push({ text: r?.status ?? 'queued' })
    return s
  }
  const na = a.criteria.filter((x) => x.status === 'not applicable').length
  s.push({ text: `${a.criteria.length} criteria${na ? ` · ${na} n/a` : ''}` })
  s.push({ text: `${a.redFlags.length} red flag${a.redFlags.length === 1 ? '' : 's'}`, tone: a.redFlags.length ? 'bad' : undefined })
  s.push({ text: `${a.total ?? '—'}/100 · ${a.passed ? 'pass' : 'fail'}`, tone: a.passed ? 'good' : 'bad' })
  return s
}

const duration = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`
