'use strict';
/*
 * Connect & Activate console · Orbit Telecom
 * Express app in front of the Opus workflow
 *   "Connect and Activate - Order to Activation Orchestrator".
 * Holds the Opus service key; the browser only ever talks to /api here.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./lib/store');
const auth = require('./lib/auth');
const opus = require('./lib/opus');
const samples = require('./lib/samples');
const trace = require('./lib/trace');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const ORDERS_KEY = 'ca:orders';
const RUNLOG_INDEX = 'ca:runlogs';
const POLL_MS = 3000;
// Time the Fallout Desk has to decide. Keep it equal to the timeout on the
// "Fallout Desk Review" step in the workflow (60 minutes), so the console never
// promises more time than the workflow gives.
const REVIEW_WINDOW_MINUTES = Number(process.env.REVIEW_WINDOW_MINUTES || 60);
const OPUS_APP_URL = process.env.OPUS_REVIEW_URL || 'https://app.opus.com';
// Off-platform Fallout Desk Review: Opus posts the task to /api/opus/webhook with
// this header (set the same value in the node's Custom headers), then waits for
// the console to post the decision to the callback URL it supplied.
const WEBHOOK_HEADER = 'x-webhook-secret';
const WEBHOOK_SECRET = process.env.OPUS_WEBHOOK_SECRET || '';
const REVIEWS_KEY = 'ca:reviews';          // run id -> public review summary (no token)
const REVIEW_SECRET_KEY = 'ca:review-cb';  // run id -> callback { url, token, token_header }
const WEBHOOK_LOG = 'ca:webhook-log';

/* ------------------------------------------------------------------ helpers */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const now = () => new Date().toISOString();

function mask(s, head, tail) {
  s = String(s || '');
  if (s.length <= head + tail + 2) return s ? s.slice(0, 2) + '••••' : '';
  return s.slice(0, head) + '••••' + s.slice(-tail);
}
function maskUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol + '//' + x.hostname.slice(0, 3) + '•••••' + (x.pathname.replace(/\/+$/, '').match(/\/v\d+$/) || [''])[0];
  } catch (e) { return u ? '•••••' : ''; }
}

const need = (...roles) => wrap(async (req, res, next) => {
  const u = await auth.currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please sign in.' });
  if (roles.length && roles.indexOf(u.role) < 0) return res.status(403).json({ error: 'Your role cannot do this.' });
  req.user = u;
  next();
});

/* ------------------------------------------------------------------ run logs */
async function runlog(id, source, level, message, detail) {
  if (!id) return;
  const entry = { at: now(), source, level, message, detail: detail || null };
  try {
    await store.push('ca:runlog:' + id, JSON.stringify(entry), 400, 60 * 24 * 3600);
    const prev = await store.hget(RUNLOG_INDEX, id);
    const idx = prev ? JSON.parse(prev) : { id, first: entry.at, count: 0, errors: 0 };
    idx.last = entry.at; idx.count += 1; if (level === 'error') idx.errors += 1; idx.lastMessage = message;
    if (detail && detail.order_id) idx.orderId = detail.order_id;
    await store.hset(RUNLOG_INDEX, id, JSON.stringify(idx));
  } catch (e) { /* logging must never break a request */ }
}

/* ------------------------------------------------------------------ orders */
function parse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
async function getOrder(id) {
  const s = await store.hget(ORDERS_KEY, id);
  if (!s) return null;
  const o = parse(s);
  if (o) o.review = parse(await store.hget(REVIEWS_KEY, id));
  return o;
}
async function saveOrder(o) {
  o.updatedAt = now();
  const copy = Object.assign({}, o); delete copy.review; // reviews live in their own key
  await store.hset(ORDERS_KEY, o.id, JSON.stringify(copy));
  return o;
}
async function allOrders() {
  const all = await store.hgetall(ORDERS_KEY);
  const reviews = await store.hgetall(REVIEWS_KEY);
  return Object.values(all || {}).map(parse).filter(Boolean)
    .map((o) => { o.review = reviews && reviews[o.id] ? parse(reviews[o.id]) : null; return o; })
    .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
}
// A coordinator sees every run of an order they submitted, including runs the desk sent again.
function canSee(u, o) { return u.role !== 'coordinator' || (o.orderOwner || o.submittedBy) === u.id; }

const ACTIVE_STAGES = ['starting', 'running', 'with_desk'];

function stageFromStatus(s) {
  if (opus.RUNNING.indexOf(s) >= 0) return 'running';
  if (opus.WAITING.indexOf(s) >= 0) return 'with_desk';
  if (s === 'COMPLETED') return 'completed';
  if (s === 'TIMED_OUT') return 'timed_out';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'cancelled';
  if (s === 'FAILED' || s === 'ERROR') return 'failed';
  return 'running';
}

/* Read what each workflow step did (Case Audit Log) and keep a compact summary on the order. */
async function readTrace(o, why) {
  if (!o.caseId) return o;
  try {
    const a = await opus.audit(o.caseId);
    const t = trace.fromAudit(a);
    const firstRead = !o.trace;
    o.trace = t;
    if (firstRead || why === 'finished') {
      await runlog(o.id, 'opus', 'info', 'Steps read from Opus (' + why + ')', {
        steps: t.steps.map((s) => s.name + ': ' + s.status + (s.ms != null ? ' ' + s.ms + 'ms' : '')),
        packages: Object.keys(t.packages).map((k) => k + ' ' + t.packages[k].status + ' after ' + t.packages[k].attempts + ' attempt(s)'),
        fixes: trace.fixLines(t).map((f) => f.package + ' attempt ' + f.attempt + ': ' + f.summary)
      });
      t.steps.filter((s) => s.status === 'FAILED').forEach((s) => runlog(o.id, 'opus', 'error', 'Step failed: ' + s.name, {}));
    }
  } catch (e) {
    o.traceError = e.message;
    await runlog(o.id, 'opus', 'error', 'Reading the step log failed', { error: e.message, status: e.status || null });
  }
  return o;
}

/* The order's stage as every screen shows it: an open task from Opus means the desk has it. */
function rowStage(o) {
  return o.review && o.review.status === 'open' && ACTIVE_STAGES.indexOf(o.stage) >= 0 ? 'with_desk' : o.stage;
}
/* One category per order, used by every count on every page. */
function category(o) {
  const s = rowStage(o);
  if (s === 'activated') return 'activated';
  if ((s === 'held' || s === 'with_desk') && o.resolution && o.resolution.decision === 'cancel_order') return 'cancelled';
  if (s === 'held' || s === 'with_desk') return 'held';
  if (s === 'running' || s === 'starting') return 'running';
  return 'problem';
}
/* A reprocessed or repeated order number is one order: keep its newest run. */
function latestRuns(list) {
  const newest = {};
  list.forEach((o) => {
    const k = (o.record && o.record.order_id) || o.id;
    if (!newest[k] || (o.submittedAt || '') > (newest[k].submittedAt || '')) newest[k] = o;
  });
  return list.filter((o) => newest[(o.record && o.record.order_id) || o.id] === o);
}
function runCounts(list) {
  const m = {};
  list.forEach((o) => { const k = (o.record && o.record.order_id) || o.id; m[k] = (m[k] || 0) + 1; });
  return m;
}

/* The held output's error, queue, attempts and package lists can come back empty from
   the last steps of the run. Fill any blank field from what the run itself recorded
   earlier (the Hold step's output, then the review task), never from guesses. */
const HOLD_KEYS = ['held_packages', 'completed_packages', 'primary_error_code', 'escalation_reason', 'review_queue', 'attempts_made', 'escalated_fallout_ids'];
function isBlank(k, v) {
  return v == null || v === '' || (Array.isArray(v) && !v.length) || (k === 'attempts_made' && !Number(v));
}
function effective(o) {
  if (o.path === 'closed') return o.result || null;
  const sources = [o.trace && o.trace.hold, o.holdFacts, reviewFacts(o.review)].filter(Boolean);
  if (!o.result && !sources.length) return null;
  const base = Object.assign({}, o.result || {});
  const filled = [];
  HOLD_KEYS.forEach((k) => {
    if (!isBlank(k, base[k])) return;
    const src = sources.find((s) => !isBlank(k, s[k]));
    if (src) { base[k] = src[k]; filled.push(k); }
  });
  const pk = o.trace && o.trace.packages;
  if (pk && isBlank('held_packages', base.held_packages)) {
    const h = Object.keys(pk).filter((t) => pk[t].status && ['COMPLETED', 'NOT_REQUIRED'].indexOf(pk[t].status) < 0);
    if (h.length) { base.held_packages = h; filled.push('held_packages'); }
  }
  if (pk && isBlank('completed_packages', base.completed_packages)) {
    const c = Object.keys(pk).filter((t) => ['COMPLETED', 'NOT_REQUIRED'].indexOf(pk[t].status) >= 0);
    if (c.length) { base.completed_packages = c; filled.push('completed_packages'); }
  }
  if (filled.length) Object.defineProperty(base, '_filled', { value: filled, enumerable: false });
  return base;
}

async function refresh(o, force) {
  if (!o.caseId || ACTIVE_STAGES.indexOf(o.stage) < 0) return o;
  if (!force && o.lastPolled && Date.now() - Date.parse(o.lastPolled) < POLL_MS) return o;
  o.lastPolled = now();
  let st;
  try { st = await opus.status(o.caseId); }
  catch (e) {
    o.pollError = e.message;
    await saveOrder(o);
    await runlog(o.id, 'opus', 'error', 'Status check failed', { error: e.message });
    return o;
  }
  o.pollError = null;
  o.opusStatus = st.raw;
  let stage = stageFromStatus(st.raw);
  // Opus reports IN_PROGRESS while an off-platform step waits; an open task means the desk has it.
  if (stage === 'running' && o.review && o.review.status === 'open') stage = 'with_desk';
  if (stage !== 'completed') {
    if (stage !== o.stage) {
      await runlog(o.id, 'opus', stage === 'failed' || stage === 'timed_out' ? 'error' : 'info',
        'Status changed to ' + st.raw, { from: o.stage, to: stage });
      if (stage === 'with_desk' && !o.waitingSince) o.waitingSince = now();
      if (stage === 'with_desk' && !o.trace) await readTrace(o, 'held for review');
      if (stage === 'failed' || stage === 'timed_out' || stage === 'cancelled') {
        o.finishedAt = now();
        await readTrace(o, 'stopped');
        const why = st.data && (st.data.error || st.data.message || st.data.reason);
        if (why) o.failure = typeof why === 'string' ? why : JSON.stringify(why).slice(0, 400);
      }
      o.stage = stage;
    }
    return saveOrder(o);
  }
  // Completed: read the two outputs. The held output wins if both are present.
  try {
    const r = await opus.results(o.caseId);
    const held = r.held && typeof r.held === 'object' ? r.held : null;
    const closed = r.closed && typeof r.closed === 'object' ? r.closed : null;
    if (held) {
      o.result = held; o.path = 'held'; o.stage = 'held';
    } else if (closed) {
      o.result = closed; o.path = 'closed';
      o.stage = String(closed.order_status || 'CLOSED').toUpperCase() === 'VALIDATION_GAP' ? 'validation_gap' : 'activated';
    } else {
      o.stage = 'failed';
      o.failure = 'The run finished but returned neither output (order_state / held order state).';
    }
    o.finishedAt = now();
    if (o.waitingSince && !o.deskDoneAt) o.deskDoneAt = now();
    await readTrace(o, 'finished');
    // The run finished without a decision from the console (the review step closed): retire the task.
    if (o.review && o.review.status === 'open') {
      o.review.status = 'closed';
      o.review.error = 'The review step closed in the workflow before a decision was sent from the console.';
      await store.hset(REVIEWS_KEY, o.id, JSON.stringify(o.review));
      await store.hdel(REVIEW_SECRET_KEY, o.id);
      await runlog(o.id, 'opus', 'error', 'Review step closed without a console decision', {});
    }
    await runlog(o.id, 'opus', o.stage === 'failed' ? 'error' : 'info', 'Result read: ' + o.stage,
      { path: o.path || null, order_status: o.result ? o.result.order_status : null });
  } catch (e) {
    o.pollError = e.message;
    await runlog(o.id, 'opus', 'error', 'Reading results failed', { error: e.message });
  }
  return saveOrder(o);
}

/* Projection used by every list and detail screen, so all screens agree. */
function toRow(o) {
  const rec = o.record || {};
  const cust = rec.customer || {};
  const plan = rec.plan || {};
  const res = effective(o) || {};
  const fixes = trace.fixLines(o.trace);
  return {
    id: o.id,
    orderId: rec.order_id,
    scenario: rec.scenario,
    customer: ((cust.first_name || '') + ' ' + (cust.last_name || '')).trim(),
    customerId: cust.customer_id || '',
    planName: plan.name || '',
    speed: plan.speed_tier || 0,
    techType: (rec.service || {}).tech_type || '',
    includeModem: !!rec.include_modem,
    stage: rowStage(o),
    category: category(o),
    opusStatus: o.opusStatus || null,
    autoFixed: fixes.some((f) => f.recovered),
    path: o.path || null,
    activationReference: res.activation_reference || '',
    errorCode: res.primary_error_code || '',
    errorText: samples.ERROR_CATALOGUE[res.primary_error_code] || '',
    escalationReason: res.escalation_reason || '',
    reviewQueue: res.review_queue || '',
    heldPackages: res.held_packages || [],
    attemptsMade: res.attempts_made == null ? null : Number(res.attempts_made),
    resolution: o.resolution || null,
    reprocessOf: o.reprocessOf || null,
    reprocessedAs: o.reprocessedAs || null,
    duplicateOf: o.duplicateOf || null,
    submittedBy: o.submittedByName,
    submittedById: o.submittedBy,
    submittedAt: o.submittedAt,
    finishedAt: o.finishedAt || null,
    waitingSince: o.waitingSince || null,
    failure: o.failure || null,
    pollError: o.pollError || null,
    reviewOpen: !!(o.review && o.review.status === 'open')
  };
}

/* What the Fallout Desk Review step received, shaped like the held output so the
   same screens can show it while the order waits. Only keys Opus passed through. */
function reviewFacts(r) {
  if (!r || !r.inputs) return null;
  const hc = (r.inputs.hold_ctx && typeof r.inputs.hold_ctx === 'object') ? r.inputs.hold_ctx : {};
  const os = (r.inputs.order_state && typeof r.inputs.order_state === 'object') ? r.inputs.order_state : {};
  return {
    order_id: hc.order_id || os.order_id || '',
    held_packages: hc.held_packages || [],
    completed_packages: hc.completed_packages || [],
    primary_error_code: hc.primary_error_code || '',
    escalation_reason: hc.escalation_reason || '',
    review_queue: hc.primary_queue || hc.alerted_team || '',
    attempts_made: hc.attempts_made == null ? null : hc.attempts_made,
    escalated_fallout_ids: hc.escalated_fallout_ids || [],
    hold_reasons: hc.hold_reasons || os.hold_reasons || []
  };
}

function toDetail(o) {
  const res = effective(o);
  return Object.assign(toRow(o), {
    record: o.record,
    result: res,
    outputRaw: o.result || null,
    filledFromRun: res && res._filled ? res._filled : [],
    trace: o.trace ? { packages: o.trace.packages, steps: o.trace.steps, fixes: trace.fixLines(o.trace), readAt: o.trace.readAt } : null,
    traceError: o.trace ? null : (o.traceError || null),
    resolutionCorrections: o.resolution && o.resolution.corrections ? o.resolution.corrections : null,
    corrections: o.corrections || null,
    caseRef: o.caseId ? mask(o.caseId, 2, 2) : null,
    deskDoneAt: o.deskDoneAt || null,
    reprocessedAs: o.reprocessedAs || null,
    lastPolled: o.lastPolled || null,
    reviewWindowMinutes: REVIEW_WINDOW_MINUTES,
    review: o.review ? {
      status: o.review.status, receivedAt: o.review.receivedAt, sentAt: o.review.sentAt || null,
      error: o.review.error || null, outputs: o.review.outputs || [], inputs: o.review.inputs || {},
      facts: reviewFacts(o.review)
    } : null
  });
}

/* ------------------------------------------------------------------ public */
app.get('/api/health', wrap(async (req, res) => {
  res.json({ ok: true, storage: store.kind, opusConnected: opus.missingEnv().length === 0, missing: opus.missingEnv() });
}));

app.get('/api/accounts', wrap(async (req, res) => {
  if (!auth.demoSignInEnabled()) return res.json({ demo: false, accounts: [] });
  res.json({ demo: true, accounts: auth.DEMO_USERS.map(auth.publicUser) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const b = req.body || {};
  let u = null;
  if (b.userId) {
    if (!auth.demoSignInEnabled()) return res.status(400).json({ error: 'Pick-an-account sign-in is turned off. Use your email and password.' });
    u = auth.DEMO_USERS.find((x) => x.id === b.userId) || null;
  } else {
    const found = await auth.findByEmail(b.email);
    if (found && !found.demo && !found.disabled && auth.checkPassword(b.password || '', found.passwordHash)) u = found;
  }
  if (!u) return res.status(401).json({ error: 'That email and password do not match an account.' });
  auth.setSession(res, u);
  res.json({ user: auth.publicUser(u) });
}));

app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

/* ------------------------------------------------------------------ signed in */
app.get('/api/me', need(), wrap(async (req, res) => {
  const orders = latestRuns(await allOrders());
  const deskCount = orders.filter((o) => category(o) === 'held' && !o.resolution).length;
  res.json({
    user: auth.publicUser(req.user),
    opusConnected: opus.missingEnv().length === 0,
    storage: store.kind,
    reviewWindowMinutes: REVIEW_WINDOW_MINUTES,
    webhookMode: !!WEBHOOK_SECRET,
    deskCount: req.user.role === 'coordinator' ? 0 : deskCount
  });
}));

app.get('/api/catalogue', need(), (req, res) => {
  res.json({ plans: samples.PLANS, modems: samples.MODEMS, errors: samples.ERROR_CATALOGUE, examples: samples.publicExamples() });
});

function validateRecord(rec) {
  const errs = [];
  if (!rec || typeof rec !== 'object') return ['The order record must be a JSON object.'];
  if (!rec.order_id) errs.push('order_id is missing.');
  const c = rec.customer || {};
  if (!c.first_name || !c.last_name) errs.push('Customer first and last name are required.');
  if (!c.mobile && !c.email) errs.push('A mobile number or an email is required.');
  if (!(rec.service || {}).loc_id) errs.push('The service LOC ID is required.');
  if (!(rec.plan || {}).plan_code) errs.push('A plan is required.');
  return errs;
}

async function startRun(rec, user, extra) {
  const id = 'R' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const existing = (await allOrders()).find((x) => x.record && x.record.order_id === rec.order_id && !(extra && extra.reprocessOf));
  const o = Object.assign({
    id, record: rec, stage: 'starting', submittedBy: user.id, submittedByName: user.name, submittedAt: now(),
    duplicateOf: existing ? existing.id : null
  }, extra || {});
  await saveOrder(o);
  await runlog(id, 'console', 'info', 'Order submitted', { order_id: rec.order_id, by: user.name, scenario: rec.scenario, reprocessOf: o.reprocessOf || null });
  const missing = opus.missingEnv();
  if (missing.length) {
    o.stage = 'failed'; o.failure = 'The console is not connected to Opus yet. An admin needs to finish the connection settings.';
    o.finishedAt = now();
    await runlog(id, 'console', 'error', 'Opus not configured', { missing });
    return saveOrder(o);
  }
  try {
    o.caseId = await opus.createCase('Order ' + rec.order_id);
    await runlog(id, 'opus', 'info', 'Case created', { case: mask(o.caseId, 2, 2) });
    const ex = await opus.execute(o.caseId, JSON.stringify(rec));
    o.inputType = ex.type;
    o.stage = 'running';
    await runlog(id, 'opus', 'info', 'Execution started', { inputType: ex.type });
  } catch (e) {
    o.stage = 'failed'; o.failure = e.message; o.finishedAt = now();
    await runlog(id, 'opus', 'error', 'Could not start the run', { error: e.message, status: e.status || null });
  }
  return saveOrder(o);
}

app.post('/api/orders', need('coordinator', 'admin', 'desk'), wrap(async (req, res) => {
  const b = req.body || {};
  let rec;
  if (b.form) {
    const ex = samples.EXAMPLES.find((e) => e.key === b.scenario);
    rec = samples.buildOrderRecord(b.form, ex ? { scenario: ex.key, scenarioName: ex.title + (b.edited ? ' (edited)' : '') } : { scenario: 'CONSOLE', scenarioName: 'Entered in the console' });
  } else if (b.example) {
    rec = samples.exampleRecord(b.example);
    if (!rec) return res.status(400).json({ error: 'Unknown example.' });
  } else if (b.recordText) {
    try { rec = JSON.parse(b.recordText); } catch (e) { return res.status(400).json({ error: 'The order record is not valid JSON: ' + e.message }); }
  } else {
    return res.status(400).json({ error: 'Nothing to submit.' });
  }
  const errs = validateRecord(rec);
  if (errs.length) return res.status(400).json({ error: errs.join(' ') });
  const o = await startRun(rec, req.user);
  res.status(o.stage === 'failed' ? 502 : 201).json({ order: toDetail(o) });
}));

// Shows the exact order_record a form would send, without running anything.
app.post('/api/orders/preview', need(), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.form) return res.status(400).json({ error: 'Nothing to preview.' });
  const ex = samples.EXAMPLES.find((e) => e.key === b.scenario);
  const rec = samples.buildOrderRecord(b.form, ex ? { scenario: ex.key, scenarioName: ex.title } : {});
  res.json({ record: rec, problems: validateRecord(rec) });
}));

app.get('/api/orders', need(), wrap(async (req, res) => {
  try { await relinkReviews(); } catch (e) { /* never block the list */ }
  let list = (await allOrders()).filter((o) => canSee(req.user, o));
  // Refresh a few in-flight runs on each list load so the list moves on its own.
  const active = list.filter((o) => ACTIVE_STAGES.indexOf(o.stage) >= 0).slice(0, 6);
  await Promise.all(active.map((o) => refresh(o)));
  if (active.length) list = (await allOrders()).filter((o) => canSee(req.user, o));
  const latest = new Set(latestRuns(list).map((o) => o.id));
  const runs = runCounts(list);
  res.json({ orders: list.map((o) => Object.assign(toRow(o), { latest: latest.has(o.id), runs: runs[(o.record && o.record.order_id) || o.id] || 1 })) });
}));

app.get('/api/orders/:id', need(), wrap(async (req, res) => {
  try { await relinkReviews(); } catch (e) { /* never block the page */ }
  let o = await getOrder(req.params.id);
  if (!o || !canSee(req.user, o)) return res.status(404).json({ error: 'Order not found.' });
  o = await refresh(o, req.query.force === '1');
  const d = toDetail(o);
  if (o.reprocessOf) {
    const first = await getOrder(o.reprocessOf);
    if (first && first.trace) d.firstRunPackages = Object.keys(first.trace.packages).reduce((m, t) => { const p = first.trace.packages[t]; m[t] = { status: p.status, reference: p.reference }; return m; }, {});
  }
  res.json({ order: d });
}));

/* Field-level corrections the desk can make before an order runs again. */
function readCorrections(c, rec) {
  const out = {};
  const errs = [];
  c = c || {};
  const svc = (rec && rec.service) || {}, cust = (rec && rec.customer) || {}, modem = (rec && rec.modem) || {};
  if (c.loc_id != null && String(c.loc_id).trim()) {
    const v = String(c.loc_id).trim().toUpperCase();
    if (!/^LOC\d{12}$/.test(v)) errs.push('A LOC ID is LOC followed by 12 digits.');
    else if (v !== svc.loc_id) out.loc_id = v;
  }
  if (c.delivery_address != null && String(c.delivery_address).trim()) {
    const v = String(c.delivery_address).trim().toUpperCase().replace(/\s+/g, ' ');
    if (v.length < 8) errs.push('The delivery address looks too short.');
    else if (v !== cust.delivery_address) out.delivery_address = v;
  }
  if (c.modem_sku && rec && rec.include_modem && c.modem_sku !== modem.sku) {
    if (!samples.MODEMS[c.modem_sku]) errs.push('Choose a modem from the list.');
    else out.modem_sku = c.modem_sku;
  }
  if (typeof c.existing_active_service === 'boolean' && c.existing_active_service !== !!svc.existing_active_service) out.existing_active_service = c.existing_active_service;
  return { changes: out, errors: errs };
}
function applyCorrections(rec, changes, clearFaults) {
  const r = JSON.parse(JSON.stringify(rec));
  const notes = [];
  if (changes.loc_id) { r.service = Object.assign({}, r.service, { loc_id: changes.loc_id }); notes.push('LOC ID ' + changes.loc_id); }
  if (changes.delivery_address) { r.customer = Object.assign({}, r.customer, { delivery_address: changes.delivery_address }); notes.push('delivery address'); }
  if (changes.modem_sku) { r.modem = Object.assign({}, r.modem, { sku: changes.modem_sku, name: samples.MODEMS[changes.modem_sku] }); notes.push('modem ' + changes.modem_sku); }
  if (typeof changes.existing_active_service === 'boolean') { r.service = Object.assign({}, r.service, { existing_active_service: changes.existing_active_service }); notes.push(changes.existing_active_service ? 'existing service: yes' : 'existing service: none'); }
  const clear = Array.isArray(clearFaults) ? clearFaults.filter((p) => ['BILLING', 'LOGISTICS', 'PROVISIONING'].indexOf(p) >= 0) : [];
  if (clear.length && Array.isArray(r.fault_rules)) {
    const before = r.fault_rules.length;
    r.fault_rules = r.fault_rules.filter((f) => clear.indexOf(f.package) < 0);
    if (r.fault_rules.length < before) notes.push('simulated fault cleared on ' + clear.map((p) => p.toLowerCase()).join(', '));
  }
  return { record: r, notes };
}

const DECISIONS = {
  reprocess: 'Reprocess the order',
  cancel_package: 'Cancel the affected package',
  cancel_order: 'Cancel the entire order'
};

app.post('/api/orders/:id/resolution', need('desk', 'admin'), wrap(async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.stage !== 'held' && o.stage !== 'with_desk') return res.status(400).json({ error: 'Only held orders take a Fallout Desk resolution.' });
  const d = String((req.body || {}).decision || '');
  const note = String((req.body || {}).note || '').trim().slice(0, 2000);
  if (!DECISIONS[d]) return res.status(400).json({ error: 'Choose one resolution.' });
  if (note.length < 5) return res.status(400).json({ error: 'Add a short reviewer note.' });
  o.resolution = { decision: d, label: DECISIONS[d], note, by: req.user.name, byId: req.user.id, at: now() };
  await saveOrder(o);
  await runlog(o.id, 'console', 'info', 'Fallout Desk resolution recorded', { decision: d, by: req.user.name });
  res.json({ order: toDetail(o) });
}));

app.post('/api/orders/:id/resubmit', need('desk', 'admin'), wrap(async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  let rec = o.record;
  const b = req.body || {};
  let notes = [];
  if (b.recordText && req.user.role === 'admin') {
    try { rec = JSON.parse(b.recordText); } catch (e) { return res.status(400).json({ error: 'The corrected record is not valid JSON: ' + e.message }); }
    notes = ['full record edited'];
  } else {
    const c = readCorrections(b.corrections, rec);
    if (c.errors.length) return res.status(400).json({ error: c.errors.join(' ') });
    const a = applyCorrections(rec, c.changes, b.clearFaults);
    rec = a.record; notes = a.notes;
  }
  const errs = validateRecord(rec);
  if (errs.length) return res.status(400).json({ error: errs.join(' ') });
  const n = await startRun(rec, req.user, { reprocessOf: o.id, corrections: notes, orderOwner: o.orderOwner || o.submittedBy, orderOwnerName: o.orderOwnerName || o.submittedByName });
  o.reprocessedAs = n.id;
  await saveOrder(o);
  await runlog(o.id, 'console', 'info', 'Order sent for reprocessing', { newRun: n.id, corrections: notes });
  res.status(201).json({ order: toDetail(n) });
}));

app.delete('/api/orders/:id', need('admin'), wrap(async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  await store.hdel(ORDERS_KEY, o.id);
  await runlog(o.id, 'console', 'info', 'Order deleted from the console', { by: req.user.name });
  res.json({ ok: true });
}));

app.post('/api/orders-clear', need('admin'), wrap(async (req, res) => {
  const all = await allOrders();
  for (const o of all) { await store.hdel(ORDERS_KEY, o.id); await store.hdel(REVIEWS_KEY, o.id); await store.hdel(REVIEW_SECRET_KEY, o.id); }
  // Unmatched tasks and the list of calls from Opus go too; run logs are kept for engineering.
  const reviews = await store.hgetall(REVIEWS_KEY);
  for (const k of Object.keys(reviews || {})) { await store.hdel(REVIEWS_KEY, k); await store.hdel(REVIEW_SECRET_KEY, k); }
  await store.del(WEBHOOK_LOG);
  res.json({ ok: true, removed: all.length });
}));

/* ------------------------------------------------------------------ Fallout Desk webhook
 * Opus "Off-Platform Task" contract:
 *   Opus  -> POST /api/opus/webhook  { execution_id, workflow_id, inputs, callback{url,token,token_header}, expected_output_schema }
 *   we    -> 200 straight away (Opus retries 5xx; any other 4xx fails the step)
 *   later -> POST callback.url with header <token_header>: <token> and { output_data: {...bare values}, status: 'success' }
 * The callback token is single-use and never leaves the server.
 */
function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function callbackAllowed(u) {
  try {
    const x = new URL(u);
    const base = opus.base() ? new URL(opus.base()) : null;
    if (base && x.origin === base.origin) return true;
    return x.protocol === 'https:' && (x.hostname === 'opus.com' || x.hostname.endsWith('.opus.com'));
  } catch (e) { return false; }
}
async function webhookLog(entry) {
  try { await store.push(WEBHOOK_LOG, JSON.stringify(Object.assign({ at: now() }, entry)), 50, 30 * 24 * 3600); } catch (e) { /* never break the webhook */ }
}
// Opus may key fields by generated ids (workflow_input_xxxx, route UUIDs); the display
// name ("Hold Ctx", "Reviewer Note", "r_reprocess") is what identifies them.
function fieldName(key, spec) {
  const label = (spec && (spec.display_name || spec.displayName)) || key;
  return String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
// Input ids of the off-platform "Fallout Desk Review" node, used when Opus sends no display name.
const KNOWN_INPUTS = { workflow_input_nvt4xa64h: 'order_state', workflow_input_3t25o528j: 'hold_ctx' };
function unwrapInputs(inputs) {
  const out = {};
  const src = Array.isArray(inputs) ? inputs.reduce((m, v, i) => { m[(v && (v.variable_name || v.id)) || ('input_' + i)] = v; return m; }, {}) : (inputs || {});
  Object.keys(src).forEach((k) => {
    const v = src[k];
    let val = v && typeof v === 'object' && 'value' in v ? v.value : v;
    if (typeof val === 'string' && /^[\[{]/.test(val.trim())) { try { val = JSON.parse(val); } catch (e) { /* keep text */ } }
    const hasLabel = v && typeof v === 'object' && (v.display_name || v.displayName);
    const name = hasLabel ? fieldName(k, v) : (KNOWN_INPUTS[k] || KNOWN_INPUTS[(v && v.variable_name) || ''] || fieldName(k, null));
    out[name] = val;
  });
  return out;
}
// The order number can sit anywhere in the task; look for an order_id (or an ORB- number) at any depth.
function findOrderId(x, depth) {
  if (depth > 6 || x == null) return '';
  if (typeof x === 'string') { const m = x.match(/ORB-\d{4}-\d{4,}/); return m ? m[0] : ''; }
  if (typeof x !== 'object') return '';
  if (typeof x.order_id === 'string' && x.order_id) return x.order_id;
  for (const k of Object.keys(x)) { const f = findOrderId(x[k], depth + 1); if (f) return f; }
  return '';
}

// The secret can come in the X-Webhook-Secret header or as the last part of the URL
// (/api/opus/webhook/<secret>) for setups that cannot send custom headers.
// Keys and types only (never values) — lets support see how Opus shaped a task.
function describeShape(x, depth) {
  depth = depth || 0;
  if (x == null || typeof x !== 'object' || depth > 3) return typeof x;
  if (Array.isArray(x)) return ['array', x.length ? describeShape(x[0], depth + 1) : 'empty'];
  const o = {};
  Object.keys(x).slice(0, 30).forEach((k) => { o[k] = describeShape(x[k], depth + 1); });
  return o;
}
// Tasks that arrived before their order could be matched: re-read the order number and attach them.
async function relinkReviews() {
  const all = await store.hgetall(REVIEWS_KEY);
  const orphans = Object.keys(all || {}).filter((k) => k.indexOf('X-') === 0);
  if (!orphans.length) return 0;
  const orders = await allOrders();
  let linked = 0;
  for (const k of orphans) {
    const r = parse(all[k]);
    if (!r || r.status !== 'open') continue;
    const id = r.orderId || findOrderId(r.inputs, 0);
    let o = id ? (orders.find((x) => x.record && x.record.order_id === id && ACTIVE_STAGES.indexOf(x.stage) >= 0) || orders.find((x) => x.record && x.record.order_id === id)) : null;
    // Last resort: exactly one order in progress and no task of its own yet.
    if (!o) {
      const waiting = orders.filter((x) => ACTIVE_STAGES.indexOf(x.stage) >= 0 && !x.review);
      if (waiting.length === 1) o = waiting[0];
    }
    if (!o || (o.review && o.review.status === 'open')) continue;
    const cb = await store.hget(REVIEW_SECRET_KEY, k);
    r.orderId = o.record.order_id; r.unmatched = false; r.linkedLater = true;
    await store.hset(REVIEWS_KEY, o.id, JSON.stringify(r));
    if (cb) await store.hset(REVIEW_SECRET_KEY, o.id, cb);
    await store.hdel(REVIEWS_KEY, k); await store.hdel(REVIEW_SECRET_KEY, k);
    o.holdFacts = reviewFacts(r);
    if (o.stage === 'running' || o.stage === 'starting') { o.stage = 'with_desk'; o.waitingSince = o.waitingSince || r.receivedAt; }
    await saveOrder(o);
    await runlog(o.id, 'opus', 'info', 'Fallout Desk task linked to this order', { execution: r.executionId, by: id ? 'order number' : 'only order in progress' });
    await webhookLog({ accepted: true, reason: 'Linked earlier task to order ' + o.record.order_id, execution: mask(r.executionId, 4, 4) });
    linked++;
  }
  return linked;
}

app.post(['/api/opus/webhook', '/api/opus/webhook/:key'], wrap(async (req, res) => {
  if (!WEBHOOK_SECRET) {
    await webhookLog({ accepted: false, reason: 'The console has no webhook secret yet' });
    return res.status(503).json({ error: 'Webhook not configured.' });
  }
  if (!sameSecret(req.headers[WEBHOOK_HEADER], WEBHOOK_SECRET) && !sameSecret(req.params.key, WEBHOOK_SECRET)) {
    await webhookLog({ accepted: false, reason: req.params.key ? 'Wrong secret in the webhook address' : 'No secret in the address or header' });
    return res.status(401).json({ error: 'Not authorised.' });
  }
  const b = req.body || {};
  const cb = b.callback || {};
  if (!b.execution_id || !cb.url || !cb.token) {
    await webhookLog({ accepted: false, reason: 'The task had no execution id or reply address' });
    return res.status(400).json({ error: 'execution_id and callback are required.' });
  }
  if (!callbackAllowed(cb.url)) {
    await webhookLog({ accepted: false, reason: 'Callback address is not an Opus address', execution: mask(b.execution_id, 4, 4) });
    return res.status(400).json({ error: 'Callback URL not allowed.' });
  }
  const inputs = unwrapInputs(b.inputs);
  const orderId = (inputs.hold_ctx && inputs.hold_ctx.order_id) || (inputs.order_state && inputs.order_state.order_id) || findOrderId(b.inputs, 0) || findOrderId(b, 0);
  // Match the newest console run of this order that is still in progress.
  const orders = await allOrders();
  const o = orders.find((x) => x.record && x.record.order_id === orderId && ACTIVE_STAGES.indexOf(x.stage) >= 0)
    || orders.find((x) => x.record && x.record.order_id === orderId);
  const key = o ? o.id : 'X-' + b.execution_id;
  const review = {
    status: 'open', receivedAt: now(), executionId: b.execution_id, workflowId: b.workflow_id || null,
    inputShape: describeShape(b.inputs),
    orderId, inputs, outputs: Object.keys(b.expected_output_schema || {}).map((k) => fieldName(k, b.expected_output_schema[k])),
    schema: b.expected_output_schema || null, unmatched: !o
  };
  await store.hset(REVIEW_SECRET_KEY, key, JSON.stringify({ url: cb.url, token: cb.token, token_header: cb.token_header || 'X-Opus-Callback-Token' }));
  await store.hset(REVIEWS_KEY, key, JSON.stringify(review));
  await webhookLog({ accepted: true, reason: o ? 'Matched order ' + orderId : 'No console order for ' + (orderId || 'this task') + ' yet', execution: mask(b.execution_id, 4, 4) });
  if (o) {
    o.holdFacts = reviewFacts(review);
    await runlog(o.id, 'opus', 'info', 'Fallout Desk task received from Opus', { execution: b.execution_id, outputs: review.outputs, inputs: Object.keys(inputs) });
    if (o.stage === 'running' || o.stage === 'starting') { o.stage = 'with_desk'; o.waitingSince = o.waitingSince || now(); }
    await saveOrder(o);
  }
  res.json({ received: true });
}));

/* Build output_data from what the step declared, so Opus never gets an undeclared key (422). */
function buildOutputs(review, decision, note, corrected) {
  const routes = { r_reprocess: decision === 'reprocess', r_cancel_package: decision === 'cancel_package', r_cancel_order: decision === 'cancel_order' };
  const values = Object.assign({
    reviewer_note: note,
    corrected_payload: corrected || null,
    hold_ctx: review.inputs.hold_ctx == null ? null : review.inputs.hold_ctx
  }, routes);
  const declared = review.schema ? Object.keys(review.schema) : Object.keys(values);
  const out = {};
  declared.forEach((k) => {
    const spec = (review.schema || {})[k] || {};
    const name = fieldName(k, spec); // send under Opus's own key, chosen by display name
    if (name in values) {
      // A non-nullable object with nothing to send gets an empty object rather than null.
      out[k] = values[name] === null && spec.is_nullable === false && /object/.test(spec.type || '') ? {} : values[name];
    } else {
      out[k] = spec.is_nullable === false ? (/bool/.test(spec.type || '') ? false : /object/.test(spec.type || '') ? {} : /float|int/.test(spec.type || '') ? 0 : '') : null;
    }
  });
  return out;
}

app.post('/api/orders/:id/decide', need('desk', 'admin'), wrap(async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  const review = o.review;
  if (!review || review.status !== 'open') return res.status(400).json({ error: 'There is no open Fallout Desk task from Opus for this order.' });
  const b = req.body || {};
  const d = String(b.decision || '');
  const note = String(b.note || '').trim().slice(0, 4000);
  if (!DECISIONS[d]) return res.status(400).json({ error: 'Choose one resolution.' });
  if (note.length < 5) return res.status(400).json({ error: 'Add a short reviewer note.' });
  const c = readCorrections(b.corrections, o.record);
  if (c.errors.length) return res.status(400).json({ error: c.errors.join(' ') });
  const corrected = Object.keys(c.changes).length ? Object.assign({ order_id: o.record.order_id }, c.changes) : null;
  const cb = parse(await store.hget(REVIEW_SECRET_KEY, o.id));
  if (!cb) return res.status(400).json({ error: 'The callback for this task is missing, so the decision cannot be sent.' });
  const output = buildOutputs(review, d, note, corrected);
  let r, text = '';
  try {
    r = await fetch(cb.url, { method: 'POST', headers: { 'Content-Type': 'application/json', [cb.token_header]: cb.token }, body: JSON.stringify({ output_data: output, status: 'success' }) });
    text = await r.text();
  } catch (e) {
    await runlog(o.id, 'opus', 'error', 'Sending the decision to Opus failed', { error: e.message });
    return res.status(502).json({ error: 'Could not reach Opus to send the decision. Try again in a moment.' });
  }
  const meta = { decision: d, by: req.user.name, status: r.status, keys: Object.keys(output) };
  if (r.status === 422) {
    await runlog(o.id, 'opus', 'error', 'Opus refused the decision fields', Object.assign(meta, { answer: text.slice(0, 400) }));
    return res.status(422).json({ error: 'Opus refused the fields sent (' + text.slice(0, 300) + '). Nothing was stored; the task is still open.' });
  }
  if (!r.ok) {
    const closed = r.status === 401 || r.status === 404;
    review.status = closed ? 'closed' : 'open';
    review.error = closed ? 'Opus no longer accepts a decision for this task (it was already answered or has closed).' : 'Opus answered ' + r.status + '.';
    await store.hset(REVIEWS_KEY, o.id, JSON.stringify(review));
    if (closed) await store.hdel(REVIEW_SECRET_KEY, o.id);
    await runlog(o.id, 'opus', 'error', 'Decision not accepted by Opus', Object.assign(meta, { answer: text.slice(0, 400) }));
    return res.status(409).json({ error: review.error });
  }
  review.status = 'sent'; review.sentAt = now(); review.error = null;
  await store.hset(REVIEWS_KEY, o.id, JSON.stringify(review));
  await store.hdel(REVIEW_SECRET_KEY, o.id); // single-use
  // Keep what the review task showed, so the hold detail survives whatever the last steps return.
  o.holdFacts = o.holdFacts || reviewFacts(review);
  o.resolution = { decision: d, label: DECISIONS[d], note, by: req.user.name, byId: req.user.id, at: now(), sentToOpus: true, corrected: !!corrected, corrections: corrected ? c.changes : null };
  await saveOrder(o);
  await runlog(o.id, 'opus', 'info', 'Decision sent to Opus and accepted', meta);
  o.review = review;
  res.json({ order: toDetail(await refresh(o, true)) });
}));

app.get('/api/reviews-unmatched', need('admin'), wrap(async (req, res) => {
  const all = await store.hgetall(REVIEWS_KEY);
  res.json({ tasks: Object.keys(all || {}).filter((k) => k.indexOf('X-') === 0).map((k) => {
    const r = parse(all[k]) || {};
    return { key: mask(k, 6, 4), receivedAt: r.receivedAt, status: r.status, orderId: r.orderId || '', inputKeys: Object.keys(r.inputs || {}), inputShape: r.inputShape || null, outputs: r.outputs || [] };
  }) });
}));

app.get('/api/webhook-log', need('admin'), wrap(async (req, res) => {
  const list = (await store.list(WEBHOOK_LOG)).map(parse).filter(Boolean).reverse();
  res.json({ calls: list.slice(0, 20).map((c) => ({ at: c.at, accepted: c.accepted, reason: c.reason, execution: c.execution || '' })), secretSet: !!WEBHOOK_SECRET, path: '/api/opus/webhook', storage: store.kind });
}));

/* ------------------------------------------------------------------ reports */
function monthKey(iso) { return (iso || '').slice(0, 7); }

app.get('/api/report', need(), wrap(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : now().slice(0, 7);
  let mine = (await allOrders()).filter((o) => canSee(req.user, o));
  // Bring in-flight runs up to date first, so "still running" is never stale.
  const active = mine.filter((o) => ACTIVE_STAGES.indexOf(o.stage) >= 0).slice(0, 10);
  if (active.length) { await Promise.all(active.map((o) => refresh(o))); mine = (await allOrders()).filter((o) => canSee(req.user, o)); }
  const months = Array.from(new Set(mine.map((o) => monthKey(o.submittedAt)).concat([now().slice(0, 7)]))).sort().reverse();
  // One order = one order number. Reprocessed and repeated submissions count once, by their newest run.
  const monthRuns = mine.filter((o) => monthKey(o.submittedAt) === month);
  const list = latestRuns(mine).filter((o) => monthKey(o.submittedAt) === month);
  const by = (cat) => list.filter((o) => category(o) === cat);
  const held = by('held');
  const activated = by('activated');
  const cancelled = by('cancelled');
  const eff = (o) => effective(o) || {};
  // Why orders were held: every order that was held at some point this month, once each,
  // by its first held run — including orders that were sent again and activated since.
  const heldRuns = monthRuns.filter((o) => o.path === 'held' || ['held', 'cancelled'].indexOf(category(o)) >= 0)
    .sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || ''));
  const heldOnce = [];
  const seen = {};
  heldRuns.forEach((o) => { const k = (o.record && o.record.order_id) || o.id; if (!seen[k]) { seen[k] = 1; heldOnce.push(o); } });
  const decided = monthRuns.filter((o) => o.resolution);
  const tally = (arr, key) => {
    const m = {};
    arr.forEach((o) => { const k = key(o); if (k) m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
  };
  const days = {};
  const [yy, mm] = month.split('-').map(Number);
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const todayKey = now().slice(0, 10);
  for (let d = 1; d <= last; d++) {
    const k = month + '-' + String(d).padStart(2, '0');
    if (k > todayKey) break;
    days[k] = { day: k, activated: 0, held: 0, other: 0 };
  }
  list.forEach((o) => {
    const d = (o.submittedAt || '').slice(0, 10);
    days[d] = days[d] || { day: d, activated: 0, held: 0, other: 0 };
    const c = category(o);
    if (c === 'activated') days[d].activated++; else if (c === 'held') days[d].held++; else days[d].other++;
  });
  const attempts = heldOnce.map((o) => Number(eff(o).attempts_made || 0)).filter((n) => n > 0);
  const autoFixed = activated.filter((o) => trace.fixLines(o.trace).some((f) => f.recovered));
  res.json({
    month, months, scope: req.user.role === 'coordinator' ? 'mine' : 'all',
    totals: {
      submitted: list.length,
      activated: activated.length,
      held: held.length,
      cancelled: cancelled.length,
      awaitingDecision: held.filter((o) => !o.resolution).length,
      inFlight: by('running').length,
      failed: by('problem').length,
      heldAtSomePoint: heldOnce.length,
      decisions: decided.length,
      resolved: held.filter((o) => o.resolution).length,
      autoFixed: autoFixed.length,
      reprocessed: list.filter((o) => o.reprocessOf).length,
      avgAttemptsHeld: attempts.length ? Math.round(attempts.reduce((a, b) => a + b, 0) / attempts.length * 10) / 10 : 0
    },
    byErrorCode: tally(heldOnce, (o) => eff(o).primary_error_code).map((x) => Object.assign(x, { text: samples.ERROR_CATALOGUE[x.key] || '' })),
    byQueue: tally(heldOnce, (o) => eff(o).review_queue),
    byReason: tally(heldOnce, (o) => eff(o).escalation_reason),
    byResolution: tally(heldOnce, (o) => { const r = monthRuns.find((x) => x.record && o.record && x.record.order_id === o.record.order_id && x.resolution); return r ? r.resolution.decision : 'awaiting'; }),
    byPlan: tally(activated, (o) => ((o.record || {}).plan || {}).name),
    daily: Object.values(days).sort((a, b) => a.day.localeCompare(b.day))
  });
}));

app.get('/api/export.csv', need(), wrap(async (req, res) => {
  const list = (await allOrders()).filter((o) => canSee(req.user, o)).map(toRow);
  const cols = ['orderId', 'customer', 'customerId', 'planName', 'speed', 'techType', 'stage', 'activationReference', 'errorCode', 'escalationReason', 'reviewQueue', 'submittedBy', 'submittedAt', 'finishedAt'];
  const esc = (v) => { const s = Array.isArray(v) ? v.join(' ') : String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.concat(['resolution']).join(',')].concat(list.map((r) => cols.map((c) => esc(r[c])).concat([esc(r.resolution ? r.resolution.label : '')]).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders-' + now().slice(0, 10) + '.csv"');
  res.send(lines.join('\n'));
}));

/* ------------------------------------------------------------------ users */
app.get('/api/users', need('admin'), wrap(async (req, res) => {
  const users = await auth.allUsers();
  res.json({ users: users.map((u) => Object.assign(auth.publicUser(u), { disabled: !!u.disabled, createdAt: u.createdAt || null })), roles: auth.ROLES });
}));

app.post('/api/users', need('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A name and a valid email are required.' });
  if (!auth.ROLES[b.role]) return res.status(400).json({ error: 'Choose a role.' });
  if (String(b.password || '').length < 10) return res.status(400).json({ error: 'Passwords need at least 10 characters.' });
  if (await auth.findByEmail(email)) return res.status(400).json({ error: 'An account with that email already exists.' });
  const u = { id: 'u-' + crypto.randomBytes(5).toString('hex'), name, email, role: b.role, passwordHash: auth.hashPassword(b.password), createdAt: now() };
  await auth.saveUser(u);
  res.status(201).json({ user: auth.publicUser(u) });
}));

app.delete('/api/users/:id', need('admin'), wrap(async (req, res) => {
  const u = await auth.findUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.demo) return res.status(400).json({ error: 'Built-in accounts cannot be removed. Turn off pick-an-account sign-in instead.' });
  await auth.removeUser(u.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ system (admin) */
app.get('/api/system', need('admin'), wrap(async (req, res) => {
  res.json({
    workflow: { name: 'Connect and Activate - Order to Activation Orchestrator', id: mask(opus.WORKFLOW_ID, 4, 4) },
    apiBase: maskUrl(opus.base()),
    variables: {
      input: mask(opus.INPUT_ORDER_RECORD, 6, 2),
      closedOutput: mask(opus.OUTPUT_CLOSED, 6, 2),
      heldOutput: mask(opus.OUTPUT_HELD, 18, 2)
    },
    opusConnected: opus.missingEnv().length === 0,
    missing: opus.missingEnv().map((m) => m === 'OPUS_API_BASE' ? 'the Opus API address' : 'the Opus service key'),
    storage: store.kind,
    sessionSecretSet: !auth.secretIsEphemeral,
    demoSignIn: auth.demoSignInEnabled(),
    reviewWindowMinutes: REVIEW_WINDOW_MINUTES,
    webhookSecretSet: !!WEBHOOK_SECRET
  });
}));

app.get('/api/runlogs', need('admin'), wrap(async (req, res) => {
  const idx = await store.hgetall(RUNLOG_INDEX);
  const orders = await allOrders();
  const list = Object.values(idx || {}).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)
    .map((x) => { const o = orders.find((y) => y.id === x.id); return Object.assign(x, { orderId: o ? o.record.order_id : (x.orderId || null), stage: o ? rowStage(o) : 'deleted' }); })
    .sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  res.json({ runs: list.slice(0, 200) });
}));

app.get('/api/runlogs/:id', need('admin'), wrap(async (req, res) => {
  const raw = await store.list('ca:runlog:' + req.params.id);
  const o = await getOrder(req.params.id);
  res.json({
    id: req.params.id,
    orderId: o ? o.record.order_id : null,
    stage: o ? o.stage : 'deleted',
    // Engineering download: the full case id is kept here on purpose.
    caseId: o ? o.caseId || null : null,
    events: raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean)
  });
}));

/* ------------------------------------------------------------------ static */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
// Any other unknown address gets the console's own "page not found", inside the app.
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server: ' + (err.message || 'unknown error') });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Connect & Activate console on http://localhost:' + port));
}
module.exports = app;
