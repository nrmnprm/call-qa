/** Demo data in JSON files under data/: calls as the phone system and the
 * speech-to-text provider would deliver them, the team, the scorecard and the
 * processing results. Writes are skipped with DATA_WRITE=0. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Alert, CallRecord, CallResult, Manager, Scorecard } from './types.ts'

export const DATA = new URL('../data/', import.meta.url)
export const COMPANY = 'Northwind Air'

function read<T>(name: string, fallback?: T): T {
  const url = new URL(name, DATA)
  if (fallback !== undefined && !existsSync(url)) return fallback
  return JSON.parse(readFileSync(url, 'utf8')) as T
}

function write(name: string, value: unknown) {
  if (process.env.DATA_WRITE === '0') return
  try {
    writeFileSync(new URL(name, DATA), JSON.stringify(value, null, 1))
  } catch {
    /* read-only deployment: keep it in memory */
  }
}

export const managers: Manager[] = read('managers.json')
export const scorecard: Scorecard = read('scorecard.json')
export const managerById = (id: string) => managers.find((m) => m.id === id)

const callDir = new URL('calls/', DATA)
export const calls: CallRecord[] = [
  ...readdirSync(callDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(new URL(f, callDir), 'utf8')) as CallRecord),
  ...read<CallRecord[]>('custom-calls.json', []),
].sort((a, b) => a.startedAt.localeCompare(b.startedAt))

export function addCustomCall(c: CallRecord) {
  calls.push(c)
  write('custom-calls.json', calls.filter((x) => x.custom))
}

export function saveScorecard() {
  write('scorecard.json', scorecard)
}

interface Saved {
  results: Record<string, CallResult>
  alerts: Alert[]
}
const saved = read<Saved>('results.json', { results: {}, alerts: [] })
export const results: Record<string, CallResult> = saved.results
export const alerts: Alert[] = saved.alerts

export function saveResults() {
  write('results.json', { results, alerts })
}
