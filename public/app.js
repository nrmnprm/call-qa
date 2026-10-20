/* Call QA demo — client. Plain ES module, no build step. */

const $ = (s, el = document) => el.querySelector(s)
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') n.className = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return n
}

const state = { meta: null, calls: [], selected: null, detail: null, view: 'calls', inspect: false, timer: null }
const FINAL = ['scored', 'skipped', 'failed']
const FLAG_NAMES = { unapproved_discount: 'Unapproved discount', delivery_promise: 'Delivery promise', payment_data: 'Card details on the phone', rudeness: 'Rudeness', other: 'Other' }
const STATUS_CHIP = { scored: 'verified', 'not applicable': 'n/a', unverified: 'unverified', missing: 'missing', overridden: 'overridden by rules', capped: 'capped by metrics' }
const STATUS_CLASS = { scored: 'green', 'not applicable': '', unverified: 'amber', missing: 'red', overridden: 'red', capped: 'amber' }

async function api(path, body, method) {
  const res = await fetch(path, body ? { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  return j
}

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`)
const when = (iso) => new Date(`${iso}:00`).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const dayOf = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
const scoreClass = (t, passed) => (t == null ? '' : passed && t >= 75 ? 'good' : passed ? 'mid' : 'low')

function scoreBadge(item, big = false) {
  const cls = `score${big ? ' big' : ''}`
  if (item.status === 'scored') return el('span', { class: `${cls} ${scoreClass(item.total, item.passed)}`, title: item.passed ? 'passed' : 'failed' }, item.total ?? '?')
  if (item.status === 'skipped') return el('span', { class: `${cls} wait`, title: item.skipReason }, 'skip')
  if (item.status === 'failed') return el('span', { class: `${cls} low wait`, title: item.error }, 'error')
  return el('span', { class: `${cls} wait` }, item.status === 'retry' ? 'retry' : '…')
}

/* ---------- header ---------- */

function renderMode() {
  const st = state.meta.llm
  const b = $('#mode')
  b.className = `badge ${st.mode}`
  b.textContent = st.mode === 'live' ? `Live · ${st.model}` : `Recorded answers · ${st.recordings} recordings`
  b.title = st.mode === 'live' ? 'Calls are scored by the live model' : `No live model (${st.reason}). Bundled calls replay recorded model output.`
}

function renderQueue(q) {
  const b = $('#queue')
  const busy = q.pending > 0 || q.running
  b.hidden = !busy && !q.outage
  b.className = `badge ${busy ? 'busy' : ''}`
  b.textContent = q.outage ? 'Outage simulated' : `Processing · ${q.pending + (q.running ? 1 : 0)} in queue`
  $('#outage').checked = q.outage
}

/* ---------- calls list ---------- */

async function loadCalls() {
  const j = await api('/api/calls')
  state.calls = j.calls
  renderQueue(j.queue)
  renderList()
  return j
}

function renderList() {
  const box = $('#calls')
  box.replaceChildren()
  let day = ''
  for (const c of state.calls) {
    const d = dayOf(c.startedAt)
    if (d !== day) box.append(el('div', { class: 'day' }, (day = d)))
    const sub = c.status === 'scored'
      ? [c.flags ? el('span', { class: 'chip red' }, `${c.flags} flag${c.flags > 1 ? 's' : ''}`) : null, ` ${c.outcome?.replace('_', ' ') ?? ''}`]
      : c.status === 'skipped' ? c.skipReason : c.status === 'failed' ? `failed: ${c.error}` : c.status
    box.append(
      el('button', { class: `call${c.id === state.selected ? ' on' : ''}`, onclick: () => select(c.id) },
        scoreBadge(c),
        el('div', {},
          el('b', {}, c.company),
          el('small', {}, `${c.manager} · ${c.direction} · ${dur(c.durationSec)} · ${c.startedAt.slice(11, 16)}${c.language !== 'en' ? ` · ${c.language.toUpperCase()}` : ''}`),
          el('small', {}, sub),
        ),
      ),
    )
  }
}

async function select(id) {
  state.selected = id
  history.replaceState(null, '', `#${id}`)
  renderList()
  const j = await api(`/api/calls/${id}`)
  state.detail = j
  renderDetail()
  if (innerWidth < 960) $('#detail').scrollTop = 0
}

/* ---------- call detail ---------- */

function textWithMasks(text) {
  return text.split(/(\[(?:card number|card details|email|phone)\])/).map((p) => (/^\[.*\]$/.test(p) ? el('span', { class: 'mask', title: 'masked before analysis' }, p) : p))
}

function highlight(ids) {
  document.querySelectorAll('.utt.hl').forEach((n) => n.classList.remove('hl'))
  const nodes = ids.map((id) => document.getElementById(`utt-${id}`)).filter(Boolean)
  nodes.forEach((n) => n.classList.add('hl'))
  nodes[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

const evChips = (ids) => ids.map((id) => el('span', { class: 'ev', onclick: () => highlight([id]), title: 'show in transcript' }, id))

function renderDetail() {
  const { call, item, result: r } = state.detail
  const box = $('#detail')
  box.replaceChildren()
  const a = r?.assessment

  box.append(
    el('div', { class: 'head' },
      el('div', {},
        el('h2', {}, call.customer.company),
        el('div', { class: 'facts' },
          el('span', {}, `${call.customer.contact}`),
          el('span', {}, `${call.manager}`),
          el('span', {}, when(call.startedAt)),
          el('span', {}, `${call.direction} · ${dur(call.audio.durationSec)} · ${call.audio.channels === 2 ? 'stereo' : 'mono'} · ${call.language.toUpperCase()}`),
        ),
      ),
      el('div', { class: 'row' },
        el('button', { class: 'ghost', onclick: () => { state.inspect = !state.inspect; renderDetail() } }, state.inspect ? 'Hide pipeline' : 'Pipeline'),
        el('button', { class: 'ghost', onclick: rescore, title: 'Run the whole pipeline again' }, 'Re-run'),
      ),
    ),
  )

  if (state.inspect || !FINAL.includes(item.status)) box.append(renderTrace(r))

  if (item.status === 'skipped') {
    box.append(el('div', { class: 'card' }, el('h3', {}, 'Not scored'), el('p', {}, `Skipped before the model: ${r.skipReason}. Saves a model call on voicemail, wrong numbers and one-sided recordings.`)))
  } else if (item.status === 'failed') {
    box.append(el('div', { class: 'card' }, el('h3', {}, 'Scoring failed'), el('p', {}, `${r.error} — ${r.attempts.stt} speech-to-text and ${r.attempts.llm} scoring attempt(s). The transcript and metrics below are kept; re-run when the provider is back.`)))
  } else if (!a) {
    box.append(el('div', { class: 'card' }, el('p', { class: 'muted' }, `In progress: ${item.status}…`)))
  }

  if (a) {
    box.append(
      el('div', { class: 'card verdict' },
        scoreBadge(item, true),
        el('div', { class: 'what' },
          el('div', { class: 'row' },
            el('b', {}, a.total == null ? 'No total: too few verified scores' : a.passed ? 'Passed' : 'Failed'),
            el('span', { class: 'chip blue' }, a.outcome.replace('_', ' ')),
            r.source === 'replay' ? el('span', { class: 'chip amber', title: 'replayed from a recording of the live model' }, 'recorded') : null,
            el('span', { class: 'muted' }, r.model),
          ),
          el('p', {}, a.summary),
          a.customerNeed ? el('p', { class: 'muted' }, `Need: ${a.customerNeed}`) : null,
          a.nextStep
            ? el('div', { class: 'next' }, el('b', {}, 'Next step: '), a.nextStep.action, a.nextStep.due ? ` — ${new Date(`${a.nextStep.due}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}` : ' — no date', a.nextStep.owner ? ` (${a.nextStep.owner})` : '')
            : el('div', { class: 'next none' }, el('b', {}, 'No next step agreed')),
        ),
      ),
    )
    if (a.redFlags.length) {
      box.append(el('div', { class: 'card' }, el('h3', {}, 'Red flags'),
        el('div', { class: 'flags' }, a.redFlags.map((f) =>
          el('div', { class: 'flag' }, el('b', {}, FLAG_NAMES[f.type] ?? f.type), el('span', {}, f.note), f.utterance ? evChips([f.utterance, ...(f.also ?? [])]) : null, el('span', { class: 'src' }, f.source)),
        )),
      ))
    }
    if (a.coaching) box.append(el('div', { class: 'card' }, el('h3', {}, 'Coaching tip'), el('div', { class: 'coach' }, a.coaching)))
    box.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Scorecard'),
        el('table', { class: 'crit' },
          el('tr', {}, el('th', {}, 'Criterion'), el('th', { class: 'w' }, 'Weight'), el('th', {}, 'Score'), el('th', {}, 'Why')),
          a.criteria.map((c) =>
            el('tr', {},
              el('td', {}, el('b', {}, c.title), el('br'), el('span', { class: `chip ${STATUS_CLASS[c.status]}` }, STATUS_CHIP[c.status])),
              el('td', { class: 'w' }, `×${c.weight}`),
              el('td', {}, c.score == null ? el('span', { class: 'muted' }, '—') : el('span', { class: `dots s${c.score}`, title: `${c.score} of 2` }, el('i'), el('i'))),
              el('td', {}, c.comment || el('span', { class: 'muted' }, 'no comment'), el('div', {}, evChips(c.evidence)), c.notes.map((n) => el('span', { class: 'note' }, n))),
            ),
          ),
        ),
      ),
    )
  }

  if (r?.metrics) box.append(renderMetrics(r.metrics))
  if (r?.transcript) box.append(renderTranscript(r.transcript))
}

function renderMetrics(m) {
  const share = Math.round(m.managerTalkShare * 100)
  const metric = (v, l, warn) => el('div', { class: `metric${warn ? ' warn' : ''}` }, el('div', { class: 'v' }, v), el('div', { class: 'l' }, l))
  return el('div', { class: 'card' },
    el('h3', {}, 'Conversation metrics ', el('span', { class: 'muted' }, '(from timings, no model)')),
    el('div', { class: 'metrics' },
      el('div', { class: `metric${share > 70 ? ' warn' : ''}` }, el('div', { class: 'v' }, `${share}%`), el('div', { class: 'l' }, 'manager talk time'), el('div', { class: 'talk' }, el('span', { style: `width:${share}%` }))),
      metric(m.managerQuestions, 'questions asked', m.managerQuestions < 2),
      metric(`${m.longestMonologueSec} s`, 'longest monologue', m.longestMonologueSec > 25),
      metric(m.interruptions, 'interruptions', m.interruptions > 1),
      metric(`${m.longestPauseSec} s`, 'longest pause'),
    ),
  )
}

function renderTranscript(t) {
  const rows = [
    ...t.utterances.map((u) => ({ start: u.start, node: el('div', { class: `utt ${u.role}`, id: `utt-${u.id}` },
      el('span', { class: 't' }, mmss(u.start)),
      el('span', { class: 'id' }, u.id),
      el('span', { class: u.confidence < 0.6 ? 'lowconf' : null, title: `confidence ${u.confidence}` }, el('span', { class: 'who' }, u.role), textWithMasks(u.text)),
    ) })),
    ...t.dropped.map((d) => ({ start: d.start, node: el('div', { class: 'utt dropped', title: d.reason },
      el('span', { class: 't' }, mmss(d.start)), el('span', { class: 'id' }, '—'), el('span', {}, `${d.text} `, el('span', { class: 'chip' }, `dropped: ${d.reason}`)),
    ) })),
  ].sort((a, b) => a.start - b.start)
  return el('div', { class: 'card' },
    el('h3', {}, 'Transcript'),
    el('p', { class: 'muted' }, `Roles by ${t.roles.method}: ${t.roles.detail}.`, t.redactions.length ? ` Masked before analysis: ${[...new Set(t.redactions.map((x) => x.kind))].join(', ')}.` : ''),
    el('div', { class: 'transcript' }, rows.map((r) => r.node)),
  )
}

function renderTrace(r) {
  if (!r?.trace?.length) return el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Waiting in the queue…'))
  return el('div', { class: 'card' },
    el('h3', {}, 'Pipeline'),
    el('div', { class: 'steps' },
      r.trace.map((s) =>
        el('div', { class: 'step' },
          el('span', { class: s.ok ? 'ok' : 'no' }, s.ok ? '✓' : '✗'),
          el('b', {}, s.name),
          el('span', { class: 'ms' }, s.ms ? `${(s.ms / 1000).toFixed(1)} s` : ''),
          el('div', {}, s.detail, s.data ? el('details', {}, el('summary', {}, 'data'), el('pre', {}, traceData(s))) : null),
        ),
      ),
    ),
    r.usage ? el('p', { class: 'muted' }, `${r.usage.promptTokens + r.usage.completionTokens} tokens${r.usage.costUsd != null ? ` · $${r.usage.costUsd.toFixed(5)}` : ''}${r.usage.latencyMs ? ` · ${(r.usage.latencyMs / 1000).toFixed(1)} s model time` : ' · replayed from a recording'}`) : null,
  )
}

function traceData(s) {
  if (s.name === 'prompt') return s.data.map((m) => `--- ${m.role} ---\n${m.content}`).join('\n\n')
  if (s.data?.reply != null) return `${s.data.problems?.length ? `Problems:\n- ${s.data.problems.join('\n- ')}\n\n` : ''}Reply:\n${s.data.reply}`
  return JSON.stringify(s.data, null, 1)
}

async function rescore() {
  try {
    await api(`/api/calls/${state.selected}/rescore`, {})
    state.inspect = true
    poll()
  } catch (e) {
    alert(e.message)
  }
}

/* ---------- polling while the queue works ---------- */

async function poll() {
  clearTimeout(state.timer)
  const j = await loadCalls().catch(() => null)
  if (state.selected) {
    const d = await api(`/api/calls/${state.selected}`).catch(() => null)
    if (d && JSON.stringify(d.result) !== JSON.stringify(state.detail?.result)) {
      state.detail = d
      renderDetail()
    }
  }
  if (state.view === 'team') loadTeam()
  if (state.view === 'alerts') loadAlerts()
  const busy = j && (j.queue.pending > 0 || j.queue.running)
  if (busy) state.timer = setTimeout(poll, 1500)
  else updateAlertCount()
}

/* ---------- team ---------- */

async function loadTeam() {
  const t = await api('/api/team')
  const kpi = (v, l) => el('div', { class: 'kpi' }, el('div', { class: 'v' }, v ?? '—'), el('div', { class: 'l' }, l))
  $('#kpis').replaceChildren(...[
    kpi(t.totals.calls, 'calls'),
    kpi(t.totals.scored, 'scored by the model'),
    kpi(t.totals.skipped, 'skipped without a model call'),
    kpi(t.totals.avgTotal, 'average score'),
    kpi(t.totals.passRate == null ? null : `${t.totals.passRate}%`, 'passed'),
    kpi(t.totals.redFlags, 'red flags'),
    kpi(t.totals.tokensPerCall, 'tokens per scored call'),
    t.totals.avgLatencyMs ? kpi(`${(t.totals.avgLatencyMs / 1000).toFixed(1)} s`, 'model time per call') : null,
  ].filter(Boolean))
  $('#managers').replaceChildren(
    el('tr', {}, ['Manager', 'Calls', 'Scored', 'Avg score', 'Passed', 'Red flags', 'Talk time', 'Coaching focus'].map((h) => el('th', {}, h))),
    ...t.byManager.map((m) => el('tr', {},
      el('td', {}, el('b', {}, m.name)), el('td', {}, m.calls), el('td', {}, m.scored),
      el('td', {}, m.avgTotal == null ? '—' : el('span', { class: `chip ${m.avgTotal >= 75 ? 'green' : m.avgTotal >= 60 ? 'amber' : 'red'}` }, m.avgTotal)),
      el('td', {}, `${m.passed}/${m.scored}`), el('td', {}, m.redFlags ? el('span', { class: 'chip red' }, m.redFlags) : '0'),
      el('td', {}, m.talkShare == null ? '—' : `${m.talkShare}%`), el('td', {}, m.focus ?? el('span', { class: 'muted' }, '—')),
    )),
  )
  const heat = (v) => (v == null ? '' : v >= 75 ? 'h3' : v >= 50 ? 'h2' : 'h1')
  $('#heatmap').replaceChildren(
    el('tr', {}, el('th', {}, ''), t.criteria.map((c) => el('th', { class: 'c', title: `weight ${c.weight}` }, c.title))),
    ...t.byManager.map((m) => el('tr', {}, el('td', {}, el('b', {}, m.name)), t.criteria.map((c) => el('td', { class: `c ${heat(m.criteria[c.id])}` }, m.criteria[c.id] == null ? '—' : `${m.criteria[c.id]}%`)))),
    el('tr', {}, el('td', {}, el('b', {}, 'Team')), t.criteria.map((c) => el('td', { class: `c ${heat(c.pct)}` }, c.pct == null ? '—' : `${c.pct}%`))),
  )
}

/* ---------- alerts ---------- */

async function loadAlerts() {
  const t = await api('/api/team')
  const box = $('#alerts')
  box.replaceChildren()
  if (!t.alerts.length) box.append(el('p', { class: 'muted' }, 'No alerts.'))
  for (const a of t.alerts) {
    box.append(el('div', { class: `alert ${a.level}` },
      el('time', {}, new Date(a.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      el('span', {}, a.text),
      a.callId ? el('a', { onclick: () => { show('calls'); select(a.callId) } }, 'Open call') : null,
    ))
  }
  updateAlertCount(t.alerts)
}

async function updateAlertCount(list) {
  const alerts = list ?? (await api('/api/team').catch(() => ({ alerts: [] }))).alerts
  const n = alerts.filter((a) => a.level === 'red').length
  const c = $('#alert-count')
  c.hidden = !n
  c.textContent = n
}

$('#outage').addEventListener('change', async (e) => {
  renderQueue(await api('/api/outage', { on: e.target.checked }))
})

/* ---------- scorecard ---------- */

function renderScorecard() {
  const sc = state.meta.scorecard
  const live = state.meta.llm.mode === 'live'
  $('#scorecard-note').textContent = live
    ? 'Weights and descriptions go into the prompt. Saving re-queues every call; calls whose audio did not change keep their transcript and only the scoring runs again.'
    : 'Read-only here: re-scoring with a changed scorecard needs a live model (a key in .env or a local Ollama). The recorded answers match this exact scorecard.'
  $('#pass-mark').value = sc.passMark
  $('#criteria-edit').replaceChildren(
    ...sc.criteria.map((c) =>
      el('div', { class: 'crit-edit', 'data-id': c.id },
        el('div', {}, el('b', {}, c.title), ' ', el('code', {}, c.id), c.optional ? el('span', { class: 'chip' }, 'may be n/a') : null, c.critical ? el('span', { class: 'chip red' }, 'critical') : null),
        el('label', {}, 'Weight', el('input', { type: 'number', min: 0, max: 5, value: c.weight, name: 'weight' })),
        el('textarea', { name: 'description', maxlength: 600 }, c.description),
      ),
    ),
  )
  for (const n of document.querySelectorAll('#scorecard-form input, #scorecard-form textarea, #save-scorecard')) n.disabled = !live
}

$('#scorecard-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const criteria = [...document.querySelectorAll('.crit-edit')].map((n) => ({
    id: n.dataset.id,
    weight: Number($('[name=weight]', n).value),
    description: $('[name=description]', n).value,
  }))
  try {
    const j = await api('/api/scorecard', { passMark: Number($('#pass-mark').value), criteria }, 'PUT')
    state.meta.scorecard = j.scorecard
    $('#scorecard-status').textContent = `Saved; ${j.queue.pending} call(s) queued.`
    poll()
  } catch (err) {
    $('#scorecard-status').textContent = err.message
  }
})

/* ---------- add a call ---------- */

const SAMPLE = `Manager: Northwind Air, good morning, this is Anna.
Customer: Hi Anna, it's Paul from Cedar Kitchens. We're fitting out a restaurant kitchen and need an extract fan for the hood.
Manager: Great. How big is the hood, and do you know the airflow the designer specified?
Customer: Two metres long, the drawing says about three thousand cubic metres an hour.
Manager: And will the fan sit on the roof or inside the building?
Customer: On the roof, it's a single-storey building.
Manager: Then I'd suggest the roof fan NW-RF-500E, it handles warm kitchen air and you can control the speed. It's in stock.
Customer: What does it cost? We have another quote that's cheaper.
Manager: The list price is eighteen hundred seventy. I can give you five percent today; anything above that I'd need to get approved by my head of sales.
Customer: Okay, send me the quote and I'll compare.
Manager: I'll send it today and call you on Thursday morning to go through it. Does that work?
Customer: Thursday works. Thanks.`

function renderAdd() {
  const live = state.meta.llm.mode === 'live'
  $('#add-manager').replaceChildren(...state.meta.managers.map((m) => el('option', { value: m.id }, m.name)))
  $('#add-submit').disabled = !live
  $('#add-status').textContent = live ? '' : 'Needs a live model: recorded answers only cover the bundled calls.'
}

$('#add-sample').addEventListener('click', () => {
  $('#add-text').value = SAMPLE
  $('#add-company').value = 'Cedar Kitchens'
  $('#add-contact').value = 'Paul'
})

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('#add-status').textContent = 'Queued…'
  try {
    const j = await api('/api/calls', {
      managerId: $('#add-manager').value,
      direction: $('#add-direction').value,
      company: $('#add-company').value,
      contact: $('#add-contact').value,
      text: $('#add-text').value,
    })
    show('calls')
    state.inspect = true
    await select(j.id)
    poll()
    $('#add-status').textContent = ''
  } catch (err) {
    $('#add-status').textContent = err.message
  }
})

/* ---------- navigation ---------- */

function show(view) {
  state.view = view
  for (const b of document.querySelectorAll('.nav')) b.classList.toggle('on', b.dataset.view === view)
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== `view-${view}`
  if (view === 'team') loadTeam()
  if (view === 'alerts') loadAlerts()
  if (view === 'scorecard') renderScorecard()
  if (view === 'add') renderAdd()
  if (view === 'calls') loadCalls()
  history.replaceState(null, '', view === 'calls' && state.selected ? `#${state.selected}` : `#${view}`)
}
for (const b of document.querySelectorAll('.nav')) b.addEventListener('click', () => show(b.dataset.view))

async function init() {
  state.meta = await api('/api/meta')
  $('#company').textContent = state.meta.company
  renderMode()
  renderQueue(state.meta.queue)
  await loadCalls()
  const hash = location.hash.slice(1)
  if (['team', 'alerts', 'scorecard', 'add'].includes(hash)) show(hash)
  else {
    const first = state.calls.find((c) => c.id === hash) ?? state.calls.find((c) => c.status === 'scored') ?? state.calls[0]
    if (first) await select(first.id)
  }
  poll()
}

// Links and the back button change only the hash.
addEventListener('hashchange', () => {
  const hash = location.hash.slice(1)
  if (['team', 'alerts', 'scorecard', 'add', 'calls'].includes(hash)) { if (hash !== state.view) show(hash) }
  else if (state.calls.some((c) => c.id === hash) && hash !== state.selected) { if (state.view !== 'calls') show('calls'); select(hash) }
})

init().catch((e) => {
  $('#detail').replaceChildren(el('div', { class: 'card' }, el('b', {}, 'Cannot reach the demo server. '), e.message))
})
