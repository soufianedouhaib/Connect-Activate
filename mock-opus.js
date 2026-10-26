'use strict';
/*
 * Local stand-in for the Opus Case API, for testing the console only.
 * It runs a JavaScript port of the workflow's own Code Node logic
 * (Normalise -> Decompose -> 3 packages -> Consolidate -> Close or Hold),
 * so each example produces the same output shape the real workflow returns.
 *
 *   node mock-opus.js            (port 4100, base http://localhost:4100/v1)
 *   MOCK_WAIT_MS   how long a held order waits "with the Fallout Desk" (default 6000)
 *   MOCK_FILTER_CLOSED=1  return only the keys the Output node's order_state schema lists
 */
const express = require('express');

const CATEGORY_BY_PREFIX = { BIL: 'BILLING', LOG: 'LOGISTICS', PRV: 'PROVISIONING' };
const QUEUE_BY_CATEGORY = { BILLING: 'BILLING_OPS', LOGISTICS: 'DISPATCH_SUPPORT', PROVISIONING: 'NETWORK_COORDINATION' };

function normalise(rec) {
  const cust = rec.customer || {}, svc = rec.service || {}, plan = rec.plan || {}, modem = rec.modem || {}, policy = rec.retry_policy || {};
  return {
    order_id: rec.order_id || 'ORB-UNKNOWN', brand: rec.brand || 'Orbit Telecom',
    customer_id: cust.customer_id || '', customer_name: ((cust.first_name || '') + ' ' + (cust.last_name || '')).trim(),
    email: cust.email || '', mobile: cust.mobile || '', preferred_channel: cust.preferred_channel || 'SMS',
    delivery_address: cust.delivery_address || '', loc_id: svc.loc_id || '', tech_type: String(svc.tech_type || 'FTTN').toUpperCase(),
    plan_code: plan.plan_code || '', plan_name: plan.name || '', speed_tier: Number(plan.speed_tier || 0),
    monthly_price_cents: Number(plan.monthly_price_cents || 0), include_modem: !!rec.include_modem,
    modem_sku: modem.sku || '', modem_name: modem.name || '', assigned_warehouse: modem.assigned_warehouse || '',
    payment_preference: rec.payment_preference || 'INVOICE', max_attempts: Number(policy.max_attempts || 3),
    fault_rules: rec.fault_rules || [], reference_data: rec.reference_data || {},
    activation_mode: String(svc.tech_type || '').toUpperCase() === 'FTTP' ? 'TECHNICIAN' : 'REMOTE'
  };
}

function runPackage(os, type) {
  const oid = os.order_id;
  const pkg = { type, status: type === 'LOGISTICS' && !os.include_modem ? 'NOT_REQUIRED' : 'PENDING' };
  if (pkg.status === 'NOT_REQUIRED') return { pkg, fallout: null };
  const rules = os.fault_rules.filter((r) => r.package === type);
  let attempts = 0, status = 'PENDING', fallout = null, reference = null;
  while (attempts < os.max_attempts) {
    attempts++;
    const fired = rules.find((r) => (r.attempts_failing || []).indexOf(attempts) >= 0);
    if (!fired) {
      status = 'COMPLETED';
      reference = (type === 'BILLING' ? 'BILL-' : type === 'LOGISTICS' ? 'SWP-' : 'ACT-') + oid.slice(-6);
      if (fallout) { fallout.status = 'RESOLVED'; }
      break;
    }
    const cat = CATEGORY_BY_PREFIX[String(fired.error_code).slice(0, 3)] || type;
    if (!fallout) fallout = { fallout_id: 'FO-' + oid.slice(-6) + '-' + type.slice(0, 3), failed_step: type, error_code: fired.error_code, error_description: fired.error_description, queue: QUEUE_BY_CATEGORY[cat] || 'NETWORK_COORDINATION', status: 'OPEN' };
    if (!fired.fixable) { fallout.status = 'ESCALATED'; fallout.escalation_reason = 'NO_SAFE_FIX'; status = 'ESCALATED'; break; }
    if (attempts >= os.max_attempts) { fallout.status = 'ESCALATED'; fallout.escalation_reason = 'RETRY_LIMIT'; status = 'ESCALATED'; break; }
  }
  pkg.status = status; pkg.attempts = attempts; pkg.reference = reference;
  return { pkg, fallout };
}

function runWorkflow(rec) {
  const os = normalise(rec);
  const packages = {}, fallouts = [];
  ['BILLING', 'LOGISTICS', 'PROVISIONING'].forEach((t) => {
    const r = runPackage(os, t); packages[t] = r.pkg; if (r.fallout) fallouts.push(r.fallout);
  });
  const escalated = Object.keys(packages).filter((k) => ['COMPLETED', 'NOT_REQUIRED'].indexOf(packages[k].status) < 0);
  const first = name(os);
  if (!escalated.length) {
    const passed = packages.BILLING.status === 'COMPLETED' && ['COMPLETED', 'NOT_REQUIRED'].indexOf(packages.LOGISTICS.status) >= 0 && packages.PROVISIONING.status === 'COMPLETED';
    const welcome = 'Hi ' + first + ', welcome to ' + os.brand + '! Your ' + os.plan_name + ' service (' + os.speed_tier + ' Mbps) is now active. Enjoy the speed, and reach out anytime if you need a hand.';
    return {
      held: false,
      order_state: {
        order_id: os.order_id, order_status: passed ? 'CLOSED' : 'VALIDATION_GAP',
        activation_reference: packages.PROVISIONING.reference || '', plan_name: os.plan_name, speed_tier: os.speed_tier,
        tech_type: os.tech_type, activation_mode: os.activation_mode, welcome_message: welcome.slice(0, 320),
        welcome_channel: os.preferred_channel || 'SMS', escalated_fallout_ids: [], manual_review_required: false
      }
    };
  }
  const esc = fallouts.filter((f) => f.status === 'ESCALATED');
  const f0 = esc[0] || {};
  const delay = 'Hi ' + first + ', we are sorry, your ' + os.brand + ' connection is taking a little longer than expected. A specialist is already working on it and we will update you as soon as it is sorted. Thank you for your patience.';
  return {
    held: true,
    order_state: {
      order_id: os.order_id, order_status: 'HELD', activation_reference: '', manual_review_required: true,
      escalated_fallout_ids: esc.map((f) => f.fallout_id), held_packages: escalated,
      completed_packages: Object.keys(packages).filter((k) => ['COMPLETED', 'NOT_REQUIRED'].indexOf(packages[k].status) >= 0),
      primary_error_code: f0.error_code || '', escalation_reason: f0.escalation_reason || '', review_queue: f0.queue || '',
      attempts_made: (packages[f0.failed_step] || {}).attempts || 0, customer_message: delay.slice(0, 320), customer_channel: os.preferred_channel || 'SMS'
    }
  };
}
function name(os) { return (os.customer_name || 'there').split(' ')[0]; }

function createMock() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const cases = new Map();
  let seq = 1000;
  const WAIT = Number(process.env.MOCK_WAIT_MS || 6000);
  app.use((req, res, next) => {
    if (req.headers['x-service-key'] !== (process.env.MOCK_KEY || 'test-key')) return res.status(401).json({ message: 'Invalid service key' });
    next();
  });
  app.post('/v1/case', (req, res) => {
    if (!req.body || !req.body.workflowId) return res.status(400).json({ message: 'workflowId is required' });
    const id = String(++seq);
    cases.set(id, { id, created: Date.now(), workflowId: req.body.workflowId });
    res.status(201).json({ caseId: id });
  });
  app.post('/v1/case/:id/execute', (req, res) => {
    const c = cases.get(req.params.id);
    if (!c) return res.status(404).json({ message: 'Case not found' });
    const v = req.body && req.body.payload && req.body.payload.order_record;
    if (!v) return res.status(400).json({ message: 'order_record missing from payload' });
    if (process.env.MOCK_REJECT_JSON_STRING === '1' && v.type === 'json_string') return res.status(422).json({ message: 'TYPE_MISMATCH' });
    let rec;
    try { rec = typeof v.value === 'string' ? JSON.parse(v.value) : v.value; } catch (e) { return res.status(400).json({ message: 'order_record is not JSON' }); }
    c.started = Date.now(); c.type = v.type;
    c.fail = ((rec.customer || {}).last_name || '').toUpperCase() === 'FAILTEST';
    c.out = runWorkflow(rec);
    res.status(201).json({ success: true, caseId: c.id, message: 'Job execution started' });
  });
  function statusOf(c) {
    if (!c.started) return 'PENDING';
    const t = Date.now() - c.started;
    if (t < 800) return 'PENDING';
    if (t < 2500) return 'IN_PROGRESS';
    if (c.fail) return 'FAILED';
    if (c.out.held && t < 2500 + WAIT) return 'WAITING';
    if (c.out.held && t < 3500 + WAIT) return 'IN_PROGRESS';
    return 'COMPLETED';
  }
  app.get('/v1/case/:id/status', (req, res) => {
    const c = cases.get(req.params.id);
    if (!c) return res.status(404).json({ message: 'Case not found' });
    const s = statusOf(c);
    res.json(Object.assign({ caseId: c.id, status: s }, s === 'FAILED' ? { error: 'Execute Provisioning Package: NETCO gateway returned 503 three times' } : {}));
  });
  app.get('/v1/case/:id/results', (req, res) => {
    const c = cases.get(req.params.id);
    if (!c || statusOf(c) !== 'COMPLETED') return res.status(409).json({ message: 'Not completed' });
    let closed = c.out.held ? null : c.out.order_state;
    if (closed && process.env.MOCK_FILTER_CLOSED === '1') closed = { order_id: closed.order_id };
    res.json({ results: {
      order_state: { value: closed },
      workflow_output_9kelk13s4: { value: c.out.held ? JSON.stringify(c.out.order_state) : null }
    } });
  });
  app.cases = cases;
  return app;
}

if (require.main === module) createMock().listen(4100, () => console.log('mock Opus on :4100'));
module.exports = { createMock, runWorkflow };
