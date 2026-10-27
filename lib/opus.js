'use strict';
/*
 * Opus Case API client. The service key never leaves the server.
 *
 * Workflow: "Connect and Activate - Order to Activation Orchestrator"
 *   Input   order_record                (JSON String)  the full order record
 *   Output  order_state                 (Object)       closed path, from "Close Order"
 *   Output  workflow_output_9kelk13s4   (Object)       held path, from "Record Hold"
 *
 * OPUS_API_BASE is everything before "/case", for example
 *   https://operator.opus.com/v1   or   https://opus-operator.<domain>/api/v1
 */

const WORKFLOW_ID = process.env.OPUS_WORKFLOW_ID || '288070de-fbcc-479a-aaab-13725ba7531a';
const INPUT_ORDER_RECORD = 'order_record';
const OUTPUT_CLOSED = 'order_state';
const OUTPUT_HELD = 'workflow_output_9kelk13s4';

const RUNNING = ['PENDING', 'IN_PROGRESS', 'QUEUED', 'RUNNING'];
const WAITING = ['WAITING', 'WAITING_FOR_INPUT', 'PAUSED'];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'CANCELED', 'TIMED_OUT', 'ERROR'];

function base() { return String(process.env.OPUS_API_BASE || '').replace(/\/+$/, ''); }
function key() { return process.env.OPUS_SERVICE_KEY || ''; }

function missingEnv() {
  const m = [];
  if (!base()) m.push('OPUS_API_BASE');
  if (!key()) m.push('OPUS_SERVICE_KEY');
  return m;
}

async function call(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let r;
  try {
    r = await fetch(base() + path, {
      method,
      headers: { 'x-service-key': key(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
  } catch (e) {
    throw Object.assign(new Error(e.name === 'AbortError' ? 'Opus did not answer within 30 seconds' : 'Could not reach Opus: ' + e.message), { status: 0 });
  } finally { clearTimeout(t); }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) {
    const msg = (data && (data.message || data.error || data.detail)) || text.slice(0, 200) || ('HTTP ' + r.status);
    throw Object.assign(new Error('Opus ' + r.status + ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg))), { status: r.status, body: data });
  }
  return data;
}

async function createCase(title) {
  const d = await call('POST', '/case', { workflowId: WORKFLOW_ID, title: title || undefined, description: 'Submitted from the Connect & Activate console' });
  const id = d && (d.caseId || d.id || (d.case && d.case.id));
  if (!id) throw new Error('Opus did not return a case id');
  return String(id);
}

// The input is a JSON String variable. Send it as "json_string"; if Opus rejects
// the type, retry once as plain text ("str"), which is how JSON text also travels.
async function execute(caseId, orderRecordText) {
  const send = (type) => call('POST', '/case/' + encodeURIComponent(caseId) + '/execute', {
    payload: { [INPUT_ORDER_RECORD]: { value: orderRecordText, type, displayName: 'Order Record' } }
  });
  try { return { data: await send('json_string'), type: 'json_string' }; }
  catch (e) {
    if (e.status >= 400 && e.status < 500) return { data: await send('str'), type: 'str' };
    throw e;
  }
}

async function status(caseId) {
  const d = await call('GET', '/case/' + encodeURIComponent(caseId) + '/status');
  const s = String((d && (d.status || (d.case && d.case.status))) || '').toUpperCase();
  return { raw: s, data: d };
}

function parseMaybe(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } }
  return v;
}

// Find an output by id anywhere in the results body, and unwrap { value }.
function pick(results, id) {
  if (!results || typeof results !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(results, id)) {
    const v = results[id];
    return parseMaybe(v && typeof v === 'object' && 'value' in v ? v.value : v);
  }
  for (const k of Object.keys(results)) {
    const v = results[k];
    if (v && typeof v === 'object') {
      if ((v.variable_name === id || v.id === id) && 'value' in v) return parseMaybe(v.value);
      const inner = pick(v, id);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

async function results(caseId) {
  const d = await call('GET', '/case/' + encodeURIComponent(caseId) + '/results');
  const r = (d && (d.results || d.outputs || d)) || {};
  return { closed: pick(r, OUTPUT_CLOSED) || null, held: pick(r, OUTPUT_HELD) || null, raw: d };
}

/* Case Audit Log: what each step received and returned.
   GET /case/{id}/audit -> { audit: { nodesExecutionData: { <node name or id>: {
     executionStatus, executionStartTime, executionTime, executionIndex,
     executionInput: [{variableName, displayName, value, type}], executionOutput: [...] } } } } */
async function audit(caseId) {
  const d = await call('GET', '/case/' + encodeURIComponent(caseId) + '/audit');
  const nodes = (d && d.audit && d.audit.nodesExecutionData) || (d && d.nodesExecutionData) || {};
  const vars = (list) => {
    const out = {};
    (Array.isArray(list) ? list : []).forEach((v) => {
      if (!v) return;
      const val = parseMaybe(v.value);
      if (v.variableName) out[v.variableName] = val;
      if (v.displayName) out['@' + v.displayName] = val;
    });
    return out;
  };
  const steps = Object.keys(nodes).map((k) => {
    const n = nodes[k] || {};
    return {
      key: k,
      status: String(n.executionStatus || '').toUpperCase(),
      start: n.executionStartTime || null,
      ms: n.executionTime == null ? null : Number(n.executionTime),
      index: n.executionIndex == null ? null : Number(n.executionIndex),
      inputs: vars(n.executionInput),
      outputs: vars(n.executionOutput)
    };
  }).sort((a, b) => (a.index == null ? 1e9 : a.index) - (b.index == null ? 1e9 : b.index));
  return {
    steps,
    failedNodes: (d && d.failedNodes) || [],
    runningNode: (d && d.runningNode) || '',
    executedNodeCount: d && d.executedNodeCount
  };
}

module.exports = {
  WORKFLOW_ID, INPUT_ORDER_RECORD, OUTPUT_CLOSED, OUTPUT_HELD,
  RUNNING, WAITING, TERMINAL,
  base, missingEnv, createCase, execute, status, results, audit
};
