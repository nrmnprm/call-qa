/** OpenAI-compatible client (OpenRouter by default), shared with the CRM
 * assistant demo. The same rules as in production:
 *  - fail-soft: every error becomes `{ ok: false }`, callers have a fallback;
 *  - paid models are refused unless ALLOW_PAID_MODELS=1;
 *  - cost comes from the provider's usage report, not from a local price list;
 *  - configured models are checked against the provider's list at startup.
 *
 * Added for the demo: a record/replay cache keyed by a hash of the exact
 * request, so a deployment without a key can replay real model output. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  /** USD as reported by OpenRouter (`usage.cost`); null for other providers. */
  costUsd: number | null
}

export type CompletionResult =
  | { ok: true; message: Message; model: string; latencyMs: number; usage: Usage | null; source: 'live' | 'replay'; recordedAt?: string }
  | { ok: false; error: string; latencyMs: number }

export interface CompletionRequest {
  messages: Message[]
  tools?: ToolDef[]
  /** 'none' forbids tool calls: used for the forced final answer. */
  toolChoice?: 'auto' | 'none'
  maxTokens?: number
  temperature?: number
  model?: string
  /** Ask for a JSON object (`response_format`); the parser copes either way. */
  json?: boolean
}

const BASE_URL = (process.env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
const IS_OPENROUTER = BASE_URL.includes('openrouter.ai')
export const LLM_MODEL = process.env.LLM_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b:free'
const CACHE_FILE = process.env.LLM_CACHE_FILE ?? fileURLToPath(new URL('../data/llm-cache.json', import.meta.url))

function apiKey(): string | null {
  return process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || null
}

const missing = new Set<string>()

/** Why a live call with this model is impossible right now, or null. */
function liveBlocker(model: string): string | null {
  if (!model) return 'no model configured'
  // A local OpenAI-compatible server (Ollama, LM Studio) needs no key.
  if (!apiKey() && IS_OPENROUTER) return 'no API key (set OPENROUTER_API_KEY or LLM_API_KEY)'
  if (IS_OPENROUTER && !model.endsWith(':free') && process.env.ALLOW_PAID_MODELS !== '1') {
    return `paid model ${model} refused (set ALLOW_PAID_MODELS=1 to allow)`
  }
  if (missing.has(model)) return `model ${model} is not in the provider's model list`
  return null
}

// ---- record / replay ----

interface Recorded {
  message?: Message
  model: string
  usage: Usage | null
  recordedAt: string
}

let cache: Record<string, Recorded> = {}
try {
  if (existsSync(CACHE_FILE)) cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
} catch {
  cache = {}
}

function hashOf(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
}

function completionKey(req: CompletionRequest, model: string): string {
  return hashOf(['chat', model, req.messages, req.tools ?? null, req.toolChoice ?? 'auto', req.json ?? false])
}

function remember(key: string, entry: Recorded) {
  cache[key] = entry
  if (process.env.LLM_CACHE_WRITE === '0') return
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache))
  } catch {
    /* read-only deployment: keep it in memory */
  }
}

/** Without a key any model's recording of this exact request will do. */
function findRecording(keyFor: (model: string) => string, model: string): Recorded | null {
  const models = new Set([model, ...Object.values(cache).map((e) => e.model)])
  for (const m of models) {
    const hit = cache[keyFor(m)]
    if (hit) return hit
  }
  return null
}

// ---- model check ----

export async function checkModels(): Promise<string[]> {
  const out: string[] = []
  const headers: Record<string, string> = apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}
  const list = async (path: string) => {
    const res = await fetch(`${BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id)
  }
  for (const [what, model, path] of [['chat', LLM_MODEL, '/models']] as const) {
    if (!model) continue
    try {
      const ids = await list(path)
      if (ids.includes(model)) out.push(`${what}: ${model}`)
      else {
        missing.add(model)
        out.push(`${what}: ${model} NOT FOUND at ${BASE_URL}`)
      }
    } catch (e) {
      out.push(`${what}: ${model} (model list unavailable: ${(e as Error).message})`)
    }
  }
  return out
}

export function llmStatus() {
  const chat = liveBlocker(LLM_MODEL)
  return {
    mode: chat ? ('replay' as const) : ('live' as const),
    model: LLM_MODEL,
    reason: chat,
    recordings: Object.keys(cache).length,
  }
}

// ---- chat completion (with optional tools) ----

export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  const started = Date.now()
  const model = req.model ?? LLM_MODEL
  const blocker = liveBlocker(model)
  const key = completionKey(req, model)
  const rec = blocker ? findRecording((m) => completionKey(req, m), model) : (cache[key] ?? null)
  if (rec?.message) {
    return { ok: true, message: rec.message, model: rec.model, usage: rec.usage, latencyMs: 0, source: 'replay', recordedAt: rec.recordedAt }
  }
  if (blocker) return { ok: false, error: blocker, latencyMs: 0 }
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...(apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}),
        'Content-Type': 'application/json',
        ...(IS_OPENROUTER ? { 'X-Title': 'Call QA demo' } : {}),
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        ...(req.tools?.length ? { tools: req.tools, tool_choice: req.toolChoice ?? 'auto' } : {}),
        max_tokens: req.maxTokens ?? 1500,
        temperature: req.temperature ?? 0.3,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        ...(IS_OPENROUTER ? { usage: { include: true } } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    })
    let latencyMs = Date.now() - started
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, latencyMs }
    const j = (await res.json()) as {
      model?: string
      choices?: { message?: Message }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
    }
    // The body of a long reply streams in after the headers.
    latencyMs = Date.now() - started
    const raw = j.choices?.[0]?.message
    if (process.env.LLM_DEBUG === '1') {
      console.error('[llm]', JSON.stringify(j).slice(0, 1500))
      writeFileSync(process.env.LLM_DEBUG_FILE ?? '/dev/null', JSON.stringify({ model, messages: req.messages, tools: req.tools }))
    }
    if (!raw) return { ok: false, error: 'empty completion', latencyMs }
    const message: Message = {
      role: 'assistant',
      content: raw.content ?? null,
      ...(raw.tool_calls?.length ? { tool_calls: raw.tool_calls } : {}),
    }
    if (!message.content && !message.tool_calls) return { ok: false, error: 'empty completion', latencyMs }
    const usage: Usage | null = j.usage
      ? { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0, costUsd: j.usage.cost ?? null }
      : null
    remember(key, { message, model, usage, recordedAt: new Date().toISOString() })
    return { ok: true, message, model: j.model ?? model, usage, latencyMs, source: 'live' }
  } catch (e) {
    return { ok: false, error: (e as Error).message, latencyMs: Date.now() - started }
  }
}
