/** Team analytics computed from the scored calls: per manager and per
 * criterion, so the head of sales sees who needs coaching on what. */
import { COUNTED } from './scorer.ts'
import { alerts, calls, managers, results, scorecard } from './store.ts'

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null)

export function teamSummary() {
  const rows = calls.map((c) => ({ call: c, result: results[c.id] }))
  const scored = rows.filter((r) => r.result?.status === 'scored' && r.result.assessment)
  /** Share of the maximum on one criterion, over calls where it was counted. */
  const criterionPct = (list: typeof scored, id: string) =>
    avg(
      list.flatMap((r) => {
        const c = r.result.assessment!.criteria.find((x) => x.id === id)
        return c && COUNTED.includes(c.status) && c.score != null ? [(c.score / 2) * 100] : []
      }),
    )
  const byManager = managers.map((m) => {
    const mine = scored.filter((r) => r.call.managerId === m.id)
    const totals = mine.flatMap((r) => (r.result.assessment!.total != null ? [r.result.assessment!.total!] : []))
    const criteria = Object.fromEntries(scorecard.criteria.map((c) => [c.id, criterionPct(mine, c.id)]))
    const weakest = scorecard.criteria
      .filter((c) => criteria[c.id] != null)
      .sort((a, b) => criteria[a.id]! - criteria[b.id]! || b.weight - a.weight)[0]
    return {
      id: m.id,
      name: m.name,
      calls: rows.filter((r) => r.call.managerId === m.id).length,
      scored: mine.length,
      avgTotal: avg(totals),
      passed: mine.filter((r) => r.result.assessment!.passed).length,
      redFlags: mine.reduce((s, r) => s + r.result.assessment!.redFlags.length, 0),
      talkShare: avg(mine.map((r) => (r.result.metrics?.managerTalkShare ?? 0) * 100)),
      criteria,
      focus: weakest && criteria[weakest.id]! < 75 ? weakest.title : null,
    }
  })
  const usage = scored.reduce(
    (s, r) => {
      const u = r.result.usage
      if (!u) return s
      s.promptTokens += u.promptTokens
      s.completionTokens += u.completionTokens
      s.costUsd += u.costUsd ?? 0
      s.latencyMs += u.latencyMs
      return s
    },
    { promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0 },
  )
  const statuses: Record<string, number> = {}
  for (const r of rows) statuses[r.result?.status ?? 'queued'] = (statuses[r.result?.status ?? 'queued'] ?? 0) + 1
  return {
    totals: {
      calls: rows.length,
      scored: scored.length,
      skipped: statuses.skipped ?? 0,
      avgTotal: avg(scored.flatMap((r) => (r.result.assessment!.total != null ? [r.result.assessment!.total!] : []))),
      passRate: scored.length ? Math.round((scored.filter((r) => r.result.assessment!.passed).length / scored.length) * 100) : null,
      redFlags: scored.reduce((s, r) => s + r.result.assessment!.redFlags.length, 0),
      tokensPerCall: scored.length ? Math.round((usage.promptTokens + usage.completionTokens) / scored.length) : 0,
      costUsd: usage.costUsd,
      avgLatencyMs: scored.length ? Math.round(usage.latencyMs / scored.length) : 0,
    },
    statuses,
    criteria: scorecard.criteria.map((c) => ({ id: c.id, title: c.title, weight: c.weight, pct: criterionPct(scored, c.id) })),
    byManager,
    alerts: alerts.slice(0, 50),
  }
}
