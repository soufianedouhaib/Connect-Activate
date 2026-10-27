'use strict';
/*
 * Turns the Opus Case Audit Log into what the console shows:
 *   packages  BILLING / LOGISTICS / PROVISIONING: status, attempts, reference,
 *             error, and every automatic fix the package applied
 *   hold      the hold context the "Hold Order and Alert Team" step produced
 *   steps     step name, status and duration, in run order
 * It reads step outputs by variable name (billing_result, hold_ctx, ...) so it
 * does not depend on how Opus keys the steps (by name or by id).
 */

const PACKAGE_OUTPUTS = { BILLING: 'billing_result', LOGISTICS: 'logistics_result', PROVISIONING: 'provisioning_result' };
const STEP_NAMES = [
  'Normalise Order', 'Decompose Into Work Packages', 'Execute Billing Package', 'Execute Logistics Package',
  'Execute Provisioning Package', 'Consolidate Package Results', 'Final Validation', 'Draft Welcome Message',
  'Close Order', 'Hold Order and Alert Team', 'Fallout Desk Review', 'Draft Customer Delay Notice', 'Record Hold'
];

function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : null; }
function pick(step, name) {
  if (!step || !step.outputs) return undefined;
  if (name in step.outputs) return step.outputs[name];
  const lower = Object.keys(step.outputs).find((k) => k.toLowerCase() === name.toLowerCase() || k.toLowerCase() === '@' + name.replace(/_/g, ' '));
  return lower ? step.outputs[lower] : undefined;
}
function findStepWith(steps, outName) { return steps.find((s) => pick(s, outName) !== undefined); }
function stepLabel(s) {
  if (STEP_NAMES.indexOf(s.key) >= 0) return s.key;
  if (pick(s, 'billing_result') !== undefined) return 'Execute Billing Package';
  if (pick(s, 'logistics_result') !== undefined) return 'Execute Logistics Package';
  if (pick(s, 'provisioning_result') !== undefined) return 'Execute Provisioning Package';
  if (pick(s, 'hold_ctx') !== undefined && pick(s, 'order_state') !== undefined && !/review/i.test(s.key)) return 'Hold Order and Alert Team';
  if (pick(s, 'close_ctx') !== undefined) return 'Final Validation';
  return s.key;
}

function packageFrom(result, type) {
  const r = obj(result);
  if (!r) return null;
  const pkg = obj(r.package) || {};
  const fo = obj(r.fallout);
  const payload = obj(pkg.payload) || {};
  return {
    type,
    status: pkg.status || '',
    attempts: pkg.attempts == null ? null : Number(pkg.attempts),
    reference: pkg.reference || '',
    lastError: pkg.last_error_code || (fo && fo.error_code) || '',
    payload: { plan_code: payload.plan_code, sku: payload.sku, warehouse: payload.warehouse, loc_id: payload.loc_id, delivery_address: payload.delivery_address, appointment_slot: payload.appointment_slot },
    fallout: fo ? {
      id: fo.fallout_id || '', errorCode: fo.error_code || '', status: fo.status || '', resolvedBy: fo.resolved_by || '',
      reason: fo.escalation_reason || '', queue: fo.queue || '',
      fixes: (Array.isArray(fo.fix_history) ? fo.fix_history : []).map((f) => ({
        attempt: f.attempt, tool: f.tool || '', summary: f.fix_summary || '', applied: !!f.fix_applied
      }))
    } : null,
    events: (Array.isArray(r.events) ? r.events : []).map((e) => ({ status: e.status || '', detail: e.detail || '' })).slice(0, 12)
  };
}

function holdFrom(hc) {
  const h = obj(hc);
  if (!h) return null;
  return {
    order_id: h.order_id || '',
    held_packages: Array.isArray(h.held_packages) ? h.held_packages : [],
    completed_packages: Array.isArray(h.completed_packages) ? h.completed_packages : [],
    primary_error_code: h.primary_error_code || '',
    escalation_reason: h.escalation_reason || '',
    review_queue: h.primary_queue || h.review_queue || '',
    attempts_made: h.attempts_made == null ? null : Number(h.attempts_made),
    escalated_fallout_ids: Array.isArray(h.escalated_fallout_ids) ? h.escalated_fallout_ids : []
  };
}

function fromAudit(a) {
  const steps = (a && a.steps) || [];
  const packages = {};
  Object.keys(PACKAGE_OUTPUTS).forEach((t) => {
    const s = findStepWith(steps, PACKAGE_OUTPUTS[t]);
    const p = s ? packageFrom(pick(s, PACKAGE_OUTPUTS[t]), t) : null;
    if (p) packages[t] = p;
  });
  // Fallback: the consolidated order state carries every package and fallout too.
  const cons = steps.find((s) => /consolidate/i.test(stepLabel(s)));
  const cos = cons ? obj(pick(cons, 'order_state')) : null;
  if (cos && obj(cos.packages)) {
    Object.keys(cos.packages).forEach((t) => {
      if (packages[t]) return;
      const fo = (Array.isArray(cos.fallouts) ? cos.fallouts : []).find((f) => f && f.failed_step === t) || null;
      const p = packageFrom({ package: cos.packages[t], fallout: fo }, t);
      if (p) packages[t] = p;
    });
  }
  const holdStep = steps.find((s) => stepLabel(s) === 'Hold Order and Alert Team');
  const hold = holdStep ? holdFrom(pick(holdStep, 'hold_ctx')) : null;
  return {
    readAt: new Date().toISOString(),
    packages,
    hold,
    steps: steps.map((s) => ({ name: stepLabel(s), status: s.status, ms: s.ms })).filter((s) => s.status),
    failedNodes: (a && a.failedNodes) || []
  };
}

/* Short sentences for the trace, one per automatic fix that was applied or tried. */
function fixLines(trace) {
  const out = [];
  if (!trace || !trace.packages) return out;
  Object.keys(trace.packages).forEach((t) => {
    const p = trace.packages[t];
    if (!p.fallout || !p.fallout.fixes.length) return;
    p.fallout.fixes.forEach((f) => {
      out.push({ package: t, attempt: f.attempt, summary: f.summary, applied: f.applied, recovered: p.status === 'COMPLETED', errorCode: p.fallout.errorCode });
    });
  });
  return out;
}

module.exports = { fromAudit, holdFrom, fixLines, PACKAGE_OUTPUTS };
