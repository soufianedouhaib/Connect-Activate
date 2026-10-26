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

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const ORDERS_KEY = 'ca:orders';
const RUNLOG_INDEX = 'ca:runlogs';
const POLL_MS = 3000;
// The Fallout Desk Review step in the workflow times out after 10 minutes.
// Keep this equal to that step's timeout so the console never promises more time.
const REVIEW_WINDOW_MINUTES = Number(process.env.REVIEW_WINDOW_MINUTES || 10);
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
function canSee(u, o) { return u.role !== 'coordinator' || o.submittedBy === u.id; }

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
  const stage = stageFromStatus(st.raw);
  if (stage !== 'completed') {
    if (stage !== o.stage) {
      await runlog(o.id, 'opus', stage === 'failed' || stage === 'timed_out' ? 'error' : 'info',
        'Status changed to ' + st.raw, { from: o.stage, to: stage });
      if (stage === 'with_desk' && !o.waitingSince) o.waitingSince = now();
      if (stage === 'failed' || stage === 'timed_out' || stage === 'cancelled') {
        o.finishedAt = now();
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
  const res = o.result || reviewFacts(o.review) || {};
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
    stage: o.stage,
    opusStatus: o.opusStatus || null,
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
  return Object.assign(toRow(o), {
    record: o.record,
    result: o.result || null,
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
  const orders = await allOrders();
  const deskCount = orders.filter((o) => (o.review && o.review.status === 'open') || o.stage === 'with_desk' || (o.stage === 'held' && !o.resolution)).length;
  res.json({
    user: auth.publicUser(req.user),
    opusConnected: opus.missingEnv().length === 0,
    storage: store.kind,
    reviewWindowMinutes: REVIEW_WINDOW_MINUTES,
    opusReviewUrl: OPUS_APP_URL,
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
  let list = (await allOrders()).filter((o) => canSee(req.user, o));
  // Refresh a few in-flight runs on each list load so the list moves on its own.
  const active = list.filter((o) => ACTIVE_STAGES.indexOf(o.stage) >= 0).slice(0, 6);
  await Promise.all(active.map((o) => refresh(o)));
  if (active.length) list = (await allOrders()).filter((o) => canSee(req.user, o));
  res.json({ orders: list.map(toRow) });
}));

app.get('/api/orders/:id', need(), wrap(async (req, res) => {
  let o = await getOrder(req.params.id);
  if (!o || !canSee(req.user, o)) return res.status(404).json({ error: 'Order not found.' });
  o = await refresh(o, req.query.force === '1');
  res.json({ order: toDetail(o) });
}));

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
  if (b.recordText) {
    try { rec = JSON.parse(b.recordText); } catch (e) { return res.status(400).json({ error: 'The corrected record is not valid JSON: ' + e.message }); }
    const errs = validateRecord(rec);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
  }
  const n = await startRun(rec, req.user, { reprocessOf: o.id });
  o.reprocessedAs = n.id;
  await saveOrder(o);
  await runlog(o.id, 'console', 'info', 'Order sent for reprocessing', { newRun: n.id, corrected: !!b.recordText });
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
function unwrapInputs(inputs) {
  const out = {};
  Object.keys(inputs || {}).forEach((k) => {
    const v = inputs[k];
    let val = v && typeof v === 'object' && 'value' in v ? v.value : v;
    if (typeof val === 'string' && /^[\[{]/.test(val.trim())) { try { val = JSON.parse(val); } catch (e) { /* keep text */ } }
    out[k] = val;
  });
  return out;
}

app.post('/api/opus/webhook', wrap(async (req, res) => {
  const headerNames = Object.keys(req.headers).filter((h) => /^x-|^authorization$/.test(h));
  if (!WEBHOOK_SECRET) {
    await webhookLog({ accepted: false, reason: 'Webhook secret not set on the console', headers: headerNames });
    return res.status(503).json({ error: 'Webhook not configured.' });
  }
  if (!sameSecret(req.headers[WEBHOOK_HEADER], WEBHOOK_SECRET)) {
    await webhookLog({ accepted: false, reason: 'Missing or wrong ' + WEBHOOK_HEADER + ' header', headers: headerNames });
    return res.status(401).json({ error: 'Not authorised.' });
  }
  const b = req.body || {};
  const cb = b.callback || {};
  if (!b.execution_id || !cb.url || !cb.token) {
    await webhookLog({ accepted: false, reason: 'Body has no execution_id or callback', headers: headerNames });
    return res.status(400).json({ error: 'execution_id and callback are required.' });
  }
  if (!callbackAllowed(cb.url)) {
    await webhookLog({ accepted: false, reason: 'Callback address is not an Opus address', execution: mask(b.execution_id, 4, 4) });
    return res.status(400).json({ error: 'Callback URL not allowed.' });
  }
  const inputs = unwrapInputs(b.inputs);
  const orderId = (inputs.hold_ctx && inputs.hold_ctx.order_id) || (inputs.order_state && inputs.order_state.order_id) || '';
  // Match the newest console run of this order that is still in progress.
  const orders = await allOrders();
  const o = orders.find((x) => x.record && x.record.order_id === orderId && ACTIVE_STAGES.indexOf(x.stage) >= 0)
    || orders.find((x) => x.record && x.record.order_id === orderId);
  const key = o ? o.id : 'X-' + b.execution_id;
  const review = {
    status: 'open', receivedAt: now(), executionId: b.execution_id, workflowId: b.workflow_id || null,
    orderId, inputs, outputs: Object.keys(b.expected_output_schema || {}),
    schema: b.expected_output_schema || null, unmatched: !o
  };
  await store.hset(REVIEW_SECRET_KEY, key, JSON.stringify({ url: cb.url, token: cb.token, token_header: cb.token_header || 'X-Opus-Callback-Token' }));
  await store.hset(REVIEWS_KEY, key, JSON.stringify(review));
  await webhookLog({ accepted: true, reason: o ? 'Matched order ' + orderId : 'No console order for ' + (orderId || 'this task'), execution: mask(b.execution_id, 4, 4), headers: headerNames });
  if (o) {
    await runlog(o.id, 'opus', 'info', 'Fallout Desk task received from Opus', { execution: b.execution_id, outputs: review.outputs, inputs: Object.keys(inputs) });
    if (o.stage === 'running' || o.stage === 'starting') { o.stage = 'with_desk'; o.waitingSince = o.waitingSince || now(); await saveOrder(o); }
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
    if (k in values) {
      const spec = (review.schema || {})[k] || {};
      // A non-nullable object with nothing to send gets an empty object rather than null.
      out[k] = values[k] === null && spec.is_nullable === false && /object/.test(spec.type || '') ? {} : values[k];
    } else {
      const spec = review.schema[k] || {};
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
  let corrected = null;
  if (b.correctedText && String(b.correctedText).trim()) {
    try { corrected = JSON.parse(b.correctedText); } catch (e) { return res.status(400).json({ error: 'The corrected details are not valid JSON: ' + e.message }); }
    if (!corrected || typeof corrected !== 'object' || Array.isArray(corrected)) return res.status(400).json({ error: 'The corrected details must be a JSON object.' });
  }
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
  o.resolution = { decision: d, label: DECISIONS[d], note, by: req.user.name, byId: req.user.id, at: now(), sentToOpus: true, corrected: !!corrected };
  await saveOrder(o);
  await runlog(o.id, 'opus', 'info', 'Decision sent to Opus and accepted', meta);
  o.review = review;
  res.json({ order: toDetail(await refresh(o, true)) });
}));

app.get('/api/webhook-log', need('admin'), wrap(async (req, res) => {
  const list = (await store.list(WEBHOOK_LOG)).map(parse).filter(Boolean).reverse();
  res.json({ calls: list.slice(0, 20), secretSet: !!WEBHOOK_SECRET, header: 'X-Webhook-Secret', path: '/api/opus/webhook', storage: store.kind });
}));

/* ------------------------------------------------------------------ reports */
function monthKey(iso) { return (iso || '').slice(0, 7); }

app.get('/api/report', need(), wrap(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : now().slice(0, 7);
  const mine = (await allOrders()).filter((o) => canSee(req.user, o));
  const months = Array.from(new Set(mine.map((o) => monthKey(o.submittedAt)).concat([now().slice(0, 7)]))).sort().reverse();
  const list = mine.filter((o) => monthKey(o.submittedAt) === month && !o.duplicateOf);
  const count = (f) => list.filter(f).length;
  const finished = list.filter((o) => ['activated', 'held', 'validation_gap'].indexOf(o.stage) >= 0);
  const tally = (arr, key) => {
    const m = {};
    arr.forEach((o) => { const k = key(o); if (k) m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
  };
  const held = list.filter((o) => o.stage === 'held');
  // Daily series for the month: activated vs held vs other.
  // Every day of the month up to today, so the chart has a real time axis.
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
    if (o.stage === 'activated') days[d].activated++; else if (o.stage === 'held') days[d].held++; else days[d].other++;
  });
  const avgAttempts = held.length ? held.reduce((s, o) => s + Number((o.result || {}).attempts_made || 0), 0) / held.length : 0;
  res.json({
    month, months, scope: req.user.role === 'coordinator' ? 'mine' : 'all',
    totals: {
      submitted: list.length,
      finished: finished.length,
      activated: count((o) => o.stage === 'activated'),
      held: held.length,
      validationGap: count((o) => o.stage === 'validation_gap'),
      inFlight: count((o) => ACTIVE_STAGES.indexOf(o.stage) >= 0),
      failed: count((o) => ['failed', 'timed_out', 'cancelled'].indexOf(o.stage) >= 0),
      resolved: held.filter((o) => o.resolution).length,
      avgAttemptsHeld: Math.round(avgAttempts * 10) / 10
    },
    byErrorCode: tally(held, (o) => (o.result || {}).primary_error_code).map((x) => Object.assign(x, { text: samples.ERROR_CATALOGUE[x.key] || '' })),
    byQueue: tally(held, (o) => (o.result || {}).review_queue),
    byReason: tally(held, (o) => (o.result || {}).escalation_reason),
    byResolution: tally(held, (o) => (o.resolution ? o.resolution.decision : 'awaiting')),
    byPlan: tally(finished, (o) => ((o.record || {}).plan || {}).name),
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
    missing: opus.missingEnv().map((m) => m === 'OPUS_API_BASE' ? 'The Opus API address (OPUS_API_BASE)' : 'The Opus service key (OPUS_SERVICE_KEY)'),
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
    .map((x) => { const o = orders.find((y) => y.id === x.id); return Object.assign(x, { orderId: o ? o.record.order_id : null, stage: o ? o.stage : 'deleted' }); })
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
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server: ' + (err.message || 'unknown error') });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Connect & Activate console on http://localhost:' + port));
}
module.exports = app;
