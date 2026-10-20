/** What the speech-to-text provider returns for one utterance. Stereo
 * recordings carry the channel (one party per channel), mono recordings only
 * a diarized speaker index whose meaning is unknown. */
export interface SttUtterance {
  start: number
  end: number
  channel?: number
  speaker?: number
  text: string
  confidence: number
}

export interface CallRecord {
  id: string
  direction: 'inbound' | 'outbound'
  managerId: string
  customer: { company: string; contact: string; phone: string }
  /** Local time of the call, ISO without zone. */
  startedAt: string
  language: string
  audio: { channels: number; durationSec: number }
  /** Demo only: how many transcription attempts fail before one succeeds. */
  sttFailures?: number
  stt: { provider: string; utterances: SttUtterance[] }
  /** Pasted by a user instead of coming from the phone system. */
  custom?: boolean
}

export interface Manager {
  id: string
  name: string
  role: string
}

export interface Criterion {
  id: string
  title: string
  /** What "2 = done" looks like; shown to the model and to the reviewer. */
  description: string
  weight: number
  /** The model may answer "not applicable" (e.g. no objections were raised). */
  optional?: boolean
  /** A zero here fails the call regardless of the total. */
  critical?: boolean
  /** Judged by the absence of violations: a 2 needs no evidence. */
  scoredByAbsence?: boolean
}

export interface Scorecard {
  passMark: number
  criteria: Criterion[]
}

export type Role = 'manager' | 'customer'

export interface Utterance {
  id: string
  role: Role
  start: number
  end: number
  text: string
  confidence: number
}

export interface DroppedUtterance {
  start: number
  text: string
  reason: string
}

export interface RoleDetection {
  method: 'channel' | 'greeting' | 'phrases' | 'first speaker'
  managerKey: string
  detail: string
}

export interface Transcript {
  utterances: Utterance[]
  dropped: DroppedUtterance[]
  roles: RoleDetection
  /** Personal data replaced before anything reaches the model. */
  redactions: { utterance: string; kind: string }[]
}

export interface Metrics {
  durationSec: number
  managerTalkShare: number
  managerQuestions: number
  longestMonologueSec: number
  interruptions: number
  longestPauseSec: number
}

export type Score = 0 | 1 | 2

export interface CriterionResult {
  id: string
  title: string
  weight: number
  score: Score | null
  status: 'scored' | 'not applicable' | 'unverified' | 'missing' | 'overridden' | 'capped'
  evidence: string[]
  comment: string
  notes: string[]
}

export type FlagType = 'unapproved_discount' | 'delivery_promise' | 'payment_data' | 'rudeness' | 'other'

export interface RedFlag {
  type: FlagType
  utterance: string | null
  /** Further utterances with the same kind of breach. */
  also?: string[]
  note: string
  source: 'rules' | 'model' | 'rules + model'
}

export interface Assessment {
  summary: string
  customerNeed: string
  outcome: string
  nextStep: { action: string; due: string | null; owner: string | null } | null
  criteria: CriterionResult[]
  redFlags: RedFlag[]
  coaching: string
  /** 0–100, computed on the server from the weights. */
  total: number | null
  passed: boolean
}

export interface TraceStep {
  name: string
  ok: boolean
  ms: number
  detail: string
  data?: unknown
}

export type CallStatus = 'queued' | 'transcribing' | 'scoring' | 'retry' | 'scored' | 'skipped' | 'failed'

export interface Alert {
  id: string
  ts: string
  level: 'red' | 'amber' | 'info'
  callId: string | null
  text: string
}

export interface CallResult {
  id: string
  status: CallStatus
  attempts: { stt: number; llm: number }
  skipReason?: string
  error?: string
  transcript?: Transcript
  metrics?: Metrics
  assessment?: Assessment
  trace: TraceStep[]
  model?: string
  source?: 'live' | 'replay'
  usage?: { promptTokens: number; completionTokens: number; costUsd: number | null; latencyMs: number }
  /** Hash of transcript + scorecard + prompt version: a change re-scores the call. */
  key?: string
  /** Hash of the speech-to-text output: the transcript is reused while it matches. */
  sttKey?: string
  updatedAt: string
}
