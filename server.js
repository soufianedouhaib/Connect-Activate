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
async function getOrder(id) {
  const s = await store.hget(ORDERS_KEY, id);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}
async function saveOrder(o) { o.updatedAt = now(); await store.hset(ORDERS_KEY, o.id, JSON.stringify(o)); return o; }
async function allOrders() {
  const all = await store.hgetall(ORDERS_KEY);
  return Object.values(all || {}).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
    .filter(Boolean).sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
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
  const res = o.result || {};
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
    pollError: o.pollError || null
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
    reviewWindowMinutes: REVIEW_WINDOW_MINUTES
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
  const deskCount = orders.filter((o) => o.stage === 'with_desk' || (o.stage === 'held' && !o.resolution)).length;
  res.json({
    user: auth.publicUser(req.user),
    opusConnected: opus.missingEnv().length === 0,
    storage: store.kind,
    reviewWindowMinutes: REVIEW_WINDOW_MINUTES,
    opusReviewUrl: OPUS_APP_URL,
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
  for (const o of all) await store.hdel(ORDERS_KEY, o.id);
  res.json({ ok: true, removed: all.length });
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
    reviewWindowMinutes: REVIEW_WINDOW_MINUTES
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
