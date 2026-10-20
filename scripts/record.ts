/** Scores every bundled call with the live model so a deployment without a
 * key can replay the answers. Starts from an empty result file, so every call
 * really reaches the model; stop the demo server first.
 *
 *   npm run record           # with OPENROUTER_API_KEY or a local LLM_BASE_URL
 *
 * Recordings land in data/llm-cache.json (keyed by the exact request). */
import '../src/env.ts'
import { rmSync } from 'node:fs'
import { checkModels, llmStatus } from '../src/llm.ts'

for (const line of await checkModels()) console.log(line)
if (llmStatus().mode !== 'live') {
  console.error(`Cannot record: ${llmStatus().reason}`)
  process.exit(1)
}
process.env.RETRY_BASE_MS ??= '200'
process.env.STT_DELAY_MS ??= '0'
rmSync(new URL('../data/results.json', import.meta.url), { force: true })
// The store reads results.json on import, so import after removing it.
const { calls, results } = await import('../src/store.ts')
const { enqueueAll, idle } = await import('../src/pipeline.ts')
for (const c of calls.filter((x) => x.custom)) console.log(`note: custom call ${c.id} is recorded too`)
const started = Date.now()
enqueueAll(true)
await idle()
for (const c of calls) {
  const r = results[c.id]
  const a = r.assessment
  const counted = a?.criteria.filter((x) => x.status !== 'unverified' && x.status !== 'missing' && x.status !== 'not applicable').length
  console.log(
    `${c.id} ${r.status.padEnd(8)} ${a ? `${String(a.total ?? '—').padStart(3)} ${a.passed ? 'pass' : 'FAIL'} ${counted}/${a.criteria.length} verified, flags: ${a.redFlags.map((f) => `${f.type}(${f.source})`).join(', ') || '—'}, rounds: ${r.trace.filter((s) => s.name.startsWith('model')).length}` : (r.skipReason ?? r.error ?? '')}`,
  )
}
console.log(`done in ${Math.round((Date.now() - started) / 1000)} s: data/llm-cache.json`)
