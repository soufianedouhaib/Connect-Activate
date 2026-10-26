'use strict';
/*
 * Example orders. Every name, address and number here is invented.
 * Each example exercises one path through the workflow; the expected outcome
 * follows from the workflow's own package logic (3 attempts, auto-fix, escalate).
 * Dates are stamped relative to the day the example is run.
 */

const ERROR_CATALOGUE = {
  'BIL-101': 'Invalid billing account number',
  'BIL-204': 'Plan code mismatch (retired or legacy code)',
  'BIL-310': 'Payment method rejected',
  'LOG-110': 'Delivery address unparseable',
  'LOG-220': 'Out of stock at assigned warehouse',
  'LOG-330': 'Carrier dispatch failure',
  'PRV-410': 'Existing active service at premises',
  'PRV-420': 'Address or LOC ID mismatch',
  'PRV-430': 'No technician slot in requested window',
  'SYS-900': 'No completion signal within window',
  'XNT-777': 'Service class conflict (unmapped wholesale code)'
};

const PLANS = {
  'STANDARD-50': { plan_code: 'STANDARD-50', name: 'Standard 50', speed_tier: 50, monthly_price_cents: 6900, tech_types: ['FTTN', 'FTTC', 'HFC', 'FTTP'] },
  'FAST-100': { plan_code: 'FAST-100', name: 'Fast 100', speed_tier: 100, monthly_price_cents: 8900, tech_types: ['FTTC', 'HFC', 'FTTP'] },
  'SUPERFAST-250': { plan_code: 'SUPERFAST-250', name: 'Superfast 250', speed_tier: 250, monthly_price_cents: 10900, tech_types: ['HFC', 'FTTP'] },
  'ULTRAFAST-1000': { plan_code: 'ULTRAFAST-1000', name: 'Ultrafast 1000', speed_tier: 1000, monthly_price_cents: 12900, tech_types: ['FTTP', 'HFC'] }
};

const MODEMS = {
  'MDM-G3': 'Orbit Smart Modem Gen 3',
  'MDM-G2': 'Orbit Smart Modem Gen 2'
};

function day(offset, hourUtc) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(hourUtc == null ? 0 : hourUtc, 0, 0, 0);
  return d;
}

function referenceData() {
  return {
    plan_code_mappings: { 'LEGACY-FAST-100': 'FAST-100', 'OLD-STD-50': 'STANDARD-50' },
    warehouse_stock: { 'WH-NORTH': { 'MDM-G3': 12, 'MDM-G2': 7 }, 'WH-SOUTH': { 'MDM-G3': 5, 'MDM-G2': 4 } },
    technician_slots: [day(7, 9).toISOString().replace('.000', ''), day(8, 13).toISOString().replace('.000', '')],
    queue_map: { BILLING: 'BILLING_OPS', LOGISTICS: 'DISPATCH_SUPPORT', PROVISIONING: 'NETWORK_COORDINATION' },
    error_catalogue: ERROR_CATALOGUE
  };
}

const EXAMPLES = [
  {
    key: 'S1', title: 'Clean fibre order with modem', expect: 'Activated',
    blurb: 'FTTP, Ultrafast 1000, modem shipped. Every package completes first time and a technician slot is booked.',
    build: () => ({
      customer: { customer_id: 'ORB-CUS-41001', first_name: 'Hannah', last_name: 'Whitfield', email: 'hannah.whitfield@example.invalid', mobile: '+61 400 555 101', date_of_birth: '1988-03-14', service_address: '12 ORCHARD LANE, BRUNSWICK VIC 3056', delivery_address: '12 ORCHARD LANE, BRUNSWICK VIC 3056', preferred_channel: 'SMS' },
      service: { loc_id: 'LOC000555000101', tech_type: 'FTTP', max_speed_tier: 1000, existing_active_service: false, serviceable: true },
      plan: 'ULTRAFAST-1000', include_modem: true, modem: { sku: 'MDM-G3', assigned_warehouse: 'WH-NORTH' },
      payment_preference: 'DIRECT_DEBIT', fault_rules: []
    })
  },
  {
    key: 'S2', title: 'Legacy plan code, fixed automatically', expect: 'Activated',
    blurb: 'Billing rejects a retired plan code once (BIL-204); the code is remapped and the retry succeeds without a person.',
    build: () => ({
      customer: { customer_id: 'ORB-CUS-41002', first_name: 'Marcus', last_name: 'Delaney', email: 'marcus.delaney@example.invalid', mobile: '+61 400 555 202', date_of_birth: '1979-11-02', service_address: '4/27 HARBOUR STREET, PORT MELBOURNE VIC 3207', delivery_address: '4/27 HARBOUR STREET, PORT MELBOURNE VIC 3207', preferred_channel: 'EMAIL' },
      service: { loc_id: 'LOC000555000202', tech_type: 'HFC', max_speed_tier: 250, existing_active_service: false, serviceable: true },
      plan: 'FAST-100', plan_code_override: 'LEGACY-FAST-100', include_modem: true, modem: { sku: 'MDM-G2', assigned_warehouse: 'WH-SOUTH' },
      payment_preference: 'CARD',
      fault_rules: [{ package: 'BILLING', attempts_failing: [1], error_code: 'BIL-204', error_description: ERROR_CATALOGUE['BIL-204'], system_source: 'ORBIT_BILLING', fixable: true, fix_tool: 'remap_plan_code', fix_summary: 'Mapped retired code LEGACY-FAST-100 to FAST-100 from the plan code table.', fix_patch: { plan_code: 'FAST-100' } }]
    })
  },
  {
    key: 'S3', title: 'Customer keeps own modem', expect: 'Activated',
    blurb: 'HFC, Superfast 250, no modem. Logistics is not required and activation is remote.',
    build: () => ({
      customer: { customer_id: 'ORB-CUS-41004', first_name: 'Sofia', last_name: 'Marchetti', email: 'sofia.marchetti@example.invalid', mobile: '+61 400 555 404', date_of_birth: '1996-08-30', service_address: '9 WATTLE CRESCENT, FOOTSCRAY VIC 3011', delivery_address: '9 WATTLE CRESCENT, FOOTSCRAY VIC 3011', preferred_channel: 'EMAIL' },
      service: { loc_id: 'LOC000555000404', tech_type: 'HFC', max_speed_tier: 250, existing_active_service: false, serviceable: true },
      plan: 'SUPERFAST-250', include_modem: false, modem: { sku: '', assigned_warehouse: '' },
      payment_preference: 'INVOICE', fault_rules: []
    })
  },
  {
    key: 'S4', title: 'Existing service at the premises', expect: 'Held · no safe fix',
    blurb: 'Provisioning finds an active service at the address (PRV-410). There is no safe automatic fix, so it goes straight to a person.',
    build: () => ({
      customer: { customer_id: 'ORB-CUS-41005', first_name: 'Tom', last_name: 'Okonkwo', email: 'tom.okonkwo@example.invalid', mobile: '+61 400 555 505', date_of_birth: '1990-01-19', service_address: '51 RIVERBEND ROAD, ESSENDON VIC 3040', delivery_address: '51 RIVERBEND ROAD, ESSENDON VIC 3040', preferred_channel: 'SMS' },
      service: { loc_id: 'LOC000555000505', tech_type: 'FTTP', max_speed_tier: 1000, existing_active_service: true, serviceable: true },
      plan: 'SUPERFAST-250', include_modem: true, modem: { sku: 'MDM-G3', assigned_warehouse: 'WH-SOUTH' },
      payment_preference: 'DIRECT_DEBIT',
      fault_rules: [{ package: 'PROVISIONING', attempts_failing: [1, 2, 3], error_code: 'PRV-410', error_description: ERROR_CATALOGUE['PRV-410'], system_source: 'NETCO_GATEWAY', fixable: false, fix_tool: '', fix_summary: '', fix_patch: {} }]
    })
  },
  {
    key: 'S5', title: 'Modem out of stock everywhere', expect: 'Held · retry limit',
    blurb: 'Logistics fails with LOG-220 on all three attempts; the stock check finds no warehouse holding the modem.',
    build: () => ({
      customer: { customer_id: 'ORB-CUS-41003', first_name: 'Priya', last_name: 'Raghunathan', email: 'priya.raghunathan@example.invalid', mobile: '+61 400 555 666', date_of_birth: '1993-06-23', service_address: '88 LANTERN WAY, ASCOT VALE VIC 3032', delivery_address: '88 LANTERN WAY, ASCOT VALE VIC 3032', preferred_channel: 'SMS' },
      service: { loc_id: 'LOC000555000111', tech_type: 'FTTP', max_speed_tier: 1000, existing_active_service: false, serviceable: true },
      plan: 'ULTRAFAST-1000', include_modem: true, modem: { sku: 'MDM-G3', assigned_warehouse: 'WH-NORTH' },
      payment_preference: 'DIRECT_DEBIT',
      stock_override: { 'WH-NORTH': { 'MDM-G3': 0, 'MDM-G2': 7 }, 'WH-SOUTH': { 'MDM-G3': 0, 'MDM-G2': 4 } },
      fault_rules: [{ package: 'LOGISTICS', attempts_failing: [1, 2, 3], error_code: 'LOG-220', error_description: ERROR_CATALOGUE['LOG-220'], system_source: 'ORBIT_LOGISTICS', fixable: true, fix_tool: 'check_stock', fix_summary: 'Checked stock for MDM-G3 across WH-NORTH and WH-SOUTH, no warehouse holds stock.', fix_patch: {} }]
    })
  }
];

let counter = 0;
function newOrderId() {
  const d = new Date();
  counter = (counter + 1) % 100;
  const n = String((Date.now() % 100000) * 10 + (counter % 10)).padStart(6, '0').slice(-6);
  return 'ORB-' + d.getUTCFullYear() + '-' + n;
}

/* Turn the simple form shape (also used by the examples) into the order_record
   the workflow's "Normalise Order" step reads. */
function buildOrderRecord(form, opts) {
  const o = opts || {};
  const plan = PLANS[form.plan] || PLANS['FAST-100'];
  const planBlock = Object.assign({}, plan);
  if (form.plan_code_override) planBlock.plan_code = form.plan_code_override;
  const ref = referenceData();
  if (form.stock_override) ref.warehouse_stock = form.stock_override;
  const include = !!form.include_modem;
  const sku = include ? (form.modem && form.modem.sku) || 'MDM-G3' : '';
  return {
    order_id: o.orderId || newOrderId(),
    created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    scenario: o.scenario || 'CONSOLE',
    scenario_name: o.scenarioName || 'Submitted from the console',
    brand: 'Orbit Telecom',
    customer: Object.assign({}, form.customer),
    service: Object.assign({ ready_for_service_date: day(7).toISOString().slice(0, 10) }, form.service),
    plan: planBlock,
    include_modem: include,
    modem: include ? { sku, name: MODEMS[sku] || sku, assigned_warehouse: (form.modem && form.modem.assigned_warehouse) || 'WH-NORTH' } : { sku: '', name: '', assigned_warehouse: '' },
    payment_preference: form.payment_preference || 'DIRECT_DEBIT',
    retry_policy: { max_attempts: 3, sla_hours: 24 },
    fault_rules: Array.isArray(form.fault_rules) ? form.fault_rules : [],
    reference_data: ref
  };
}

function exampleRecord(key) {
  const ex = EXAMPLES.find((e) => e.key === key);
  if (!ex) return null;
  return buildOrderRecord(ex.build(), { scenario: ex.key, scenarioName: ex.title });
}

function publicExamples() {
  return EXAMPLES.map((e) => ({ key: e.key, title: e.title, expect: e.expect, blurb: e.blurb, form: e.build() }));
}

module.exports = { ERROR_CATALOGUE, PLANS, MODEMS, EXAMPLES, buildOrderRecord, exampleRecord, publicExamples, newOrderId };
