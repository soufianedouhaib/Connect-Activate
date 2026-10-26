(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;

  CA.boot({ roles: ['coordinator', 'admin'] }).then(function (me) {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="page-head"><div><p class="crumb"><a href="/">Orders</a> / New order</p><h1>New order</h1>' +
      '<p>Enter a broadband connection order. It runs through billing, logistics and provisioning; anything that cannot be fixed automatically is held for the Fallout Desk.</p></div></div>' +
      '<div class="stack" id="body"><div class="card">Loading…</div></div>';

    CA.api('GET', '/api/catalogue').then(function (cat) { build(cat, me); }).catch(function (e) {
      document.getElementById('body').innerHTML = '<div class="alert bad">' + esc(e.message) + '</div>';
    });
  });

  function build(cat, me) {
    var state = { scenario: null, extras: {}, edited: false, mode: 'form' };
    var planOpts = Object.keys(cat.plans).map(function (k) {
      var p = cat.plans[k];
      return '<option value="' + esc(k) + '">' + esc(p.name) + ' · ' + p.speed_tier + ' Mbps · ' + CA.money(p.monthly_price_cents) + '/mo</option>';
    }).join('');
    var modemOpts = Object.keys(cat.modems).map(function (k) { return '<option value="' + esc(k) + '">' + esc(cat.modems[k]) + ' (' + esc(k) + ')</option>'; }).join('');

    document.getElementById('body').innerHTML =
      '<section class="card"><div class="card-head"><div><h2>Example orders</h2><p>Each one takes a different path through the workflow. Pick one to fill the form, then change anything you like.</p></div></div>' +
      '<div class="samples" id="samples">' + cat.examples.map(function (x) {
        var cls = /^Activated/.test(x.expect) ? 'ok' : 'warn';
        return '<button class="sample" type="button" data-k="' + esc(x.key) + '"><span class="sample-title">' + esc(x.title) + '</span><span class="sample-desc">' + esc(x.blurb) + '</span><span class="pill ' + cls + '">Expected: ' + esc(x.expect) + '</span></button>';
      }).join('') + '</div></section>' +

      '<section class="card"><div class="card-head"><div><h2>Order details</h2><p id="mode-note">Fill in the order, or paste a full order record.</p></div>' +
      '<div class="seg-choice" role="group" aria-label="Entry mode"><button type="button" data-mode="form" aria-pressed="true">Form</button><button type="button" data-mode="json" aria-pressed="false">Paste order record</button></div></div>' +
      '<form id="f" novalidate>' +
      '<div id="form-mode" class="stack">' +
      '<div><h3 class="section-title">Customer</h3><div class="form-grid">' +
      field('First name', '<input type="text" name="first_name" required>', true) +
      field('Last name', '<input type="text" name="last_name" required>', true) +
      field('Customer ID', '<input type="text" name="customer_id" placeholder="ORB-CUS-00000">') +
      field('Mobile', '<input type="tel" name="mobile" placeholder="+61 400 000 000">', true) +
      field('Email', '<input type="email" name="email">') +
      field('Date of birth', '<input type="text" name="date_of_birth" placeholder="YYYY-MM-DD">') +
      field('Preferred channel', '<select name="preferred_channel"><option value="SMS">SMS</option><option value="EMAIL">Email</option></select>') +
      '<label class="field span-2"><span>Service address <span class="req">*</span></span><input type="text" name="service_address" required></label>' +
      '<label class="field span-3"><span>Delivery address</span><input type="text" name="delivery_address" placeholder="Same as the service address if left blank"></label>' +
      '</div></div>' +

      '<div><h3 class="section-title">Service at the premises</h3><div class="form-grid">' +
      field('LOC ID', '<input type="text" name="loc_id" placeholder="LOC000000000000" required>', true) +
      field('Technology', '<select name="tech_type"><option>FTTP</option><option>HFC</option><option>FTTC</option><option>FTTN</option></select>') +
      field('Fastest speed available (Mbps)', '<input type="number" name="max_speed_tier" min="0" step="1" value="1000">') +
      '<label class="check span-3"><input type="checkbox" name="existing_active_service"> There is already an active service at this address</label>' +
      '</div><p class="hint" id="act-hint"></p></div>' +

      '<div><h3 class="section-title">Plan, modem and payment</h3><div class="form-grid">' +
      '<label class="field span-2"><span>Plan <span class="req">*</span></span><select name="plan">' + planOpts + '</select></label>' +
      field('Payment', '<select name="payment_preference"><option value="DIRECT_DEBIT">Direct debit</option><option value="CARD">Card</option><option value="INVOICE">Invoice</option></select>') +
      '<label class="check span-3"><input type="checkbox" name="include_modem" checked> Send an Orbit modem</label>' +
      '<label class="field modem-f"><span>Modem</span><select name="sku">' + modemOpts + '</select></label>' +
      '<label class="field modem-f"><span>Ship from</span><select name="assigned_warehouse"><option value="WH-NORTH">North warehouse</option><option value="WH-SOUTH">South warehouse</option></select></label>' +
      '</div><p class="hint" id="plan-hint"></p></div>' +

      '<div id="extras" hidden><div class="alert info"><strong>Test conditions from the example</strong><span id="extras-text"></span></div></div>' +
      '</div>' +

      '<div id="json-mode" hidden><label class="field"><span>Order record (JSON)</span><textarea class="code" name="record" spellcheck="false" placeholder="{ &quot;order_id&quot;: &quot;ORB-2026-000123&quot;, &quot;customer&quot;: { … }, … }"></textarea></label>' +
      '<p class="hint">Sent to the workflow exactly as pasted. It needs order_id, customer, service, plan, include_modem, modem, payment_preference, retry_policy, fault_rules and reference_data.</p></div>' +

      '<div id="err" class="alert bad" hidden style="margin-top:16px"></div>' +
      '<div class="toolbar" style="margin-top:18px"><button class="btn" type="button" id="preview">' + icon('file') + 'Preview the order record</button><span class="spacer"></span>' +
      '<a class="btn" href="/">Cancel</a><button class="btn primary" type="submit" id="go">' + icon('send') + 'Submit order</button></div>' +
      '</form></section>';

    var f = document.getElementById('f');
    var err = document.getElementById('err');

    function field(label, control, req) {
      return '<label class="field"><span>' + esc(label) + (req ? ' <span class="req">*</span>' : '') + '</span>' + control + '</label>';
    }

    function syncHints() {
      var plan = cat.plans[f.plan.value];
      var tech = f.tech_type.value;
      var notes = [];
      if (plan && plan.tech_types.indexOf(tech) < 0) notes.push(plan.name + ' is not sold on ' + tech + '.');
      if (plan && Number(f.max_speed_tier.value || 0) && plan.speed_tier > Number(f.max_speed_tier.value)) notes.push('The premises tops out at ' + f.max_speed_tier.value + ' Mbps, below this plan.');
      document.getElementById('plan-hint').textContent = notes.join(' ');
      document.getElementById('act-hint').textContent = tech === 'FTTP' ? 'Fibre to the premises: a technician visit is booked to activate the service.' : 'Activation is done remotely; no technician visit.';
      Array.prototype.forEach.call(document.querySelectorAll('.modem-f'), function (el) { el.hidden = !f.include_modem.checked; });
    }
    f.addEventListener('change', syncHints);
    f.addEventListener('input', function () { if (state.scenario) state.edited = true; });

    function fill(x) {
      var c = x.form.customer, s = x.form.service;
      ['first_name', 'last_name', 'customer_id', 'mobile', 'email', 'date_of_birth', 'preferred_channel', 'service_address', 'delivery_address'].forEach(function (k) { f[k].value = c[k] || ''; });
      f.loc_id.value = s.loc_id; f.tech_type.value = s.tech_type; f.max_speed_tier.value = s.max_speed_tier;
      f.existing_active_service.checked = !!s.existing_active_service;
      f.plan.value = x.form.plan; f.payment_preference.value = x.form.payment_preference;
      f.include_modem.checked = !!x.form.include_modem;
      if (x.form.modem && x.form.modem.sku) { f.sku.value = x.form.modem.sku; f.assigned_warehouse.value = x.form.modem.assigned_warehouse; }
      state.scenario = x.key; state.edited = false;
      state.extras = { fault_rules: x.form.fault_rules || [], plan_code_override: x.form.plan_code_override, stock_override: x.form.stock_override };
      var rules = state.extras.fault_rules;
      var t = rules.length ? rules.map(function (r) {
        return r.package.toLowerCase() + ' fails with ' + r.error_code + ' on attempt' + (r.attempts_failing.length > 1 ? 's ' : ' ') + r.attempts_failing.join(', ') + (r.fixable ? (Object.keys(r.fix_patch || {}).length ? ', then is fixed automatically' : ', the automatic fix finds nothing to change') : ', no automatic fix');
      }).join('; ') : 'none — every package is set to succeed';
      document.getElementById('extras-text').textContent = 'Simulated faults: ' + t + '. These are kept when you submit, so the order follows the path described.';
      document.getElementById('extras').hidden = false;
      Array.prototype.forEach.call(document.querySelectorAll('.sample'), function (b) { b.classList.toggle('active', b.getAttribute('data-k') === x.key); });
      syncHints();
      f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.getElementById('samples').addEventListener('click', function (e) {
      var b = e.target.closest('[data-k]'); if (!b) return;
      fill(cat.examples.find(function (x) { return x.key === b.getAttribute('data-k'); }));
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (b) {
      b.addEventListener('click', function () {
        state.mode = b.getAttribute('data-mode');
        Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        document.getElementById('form-mode').hidden = state.mode !== 'form';
        document.getElementById('json-mode').hidden = state.mode !== 'json';
        document.getElementById('preview').hidden = state.mode !== 'form';
      });
    });

    function formBody() {
      var c = {
        customer_id: f.customer_id.value.trim() || 'ORB-CUS-' + String(Date.now()).slice(-5),
        first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim(),
        email: f.email.value.trim(), mobile: f.mobile.value.trim(), date_of_birth: f.date_of_birth.value.trim(),
        service_address: f.service_address.value.trim().toUpperCase(),
        delivery_address: (f.delivery_address.value.trim() || f.service_address.value.trim()).toUpperCase(),
        preferred_channel: f.preferred_channel.value
      };
      var form = {
        customer: c,
        service: { loc_id: f.loc_id.value.trim().toUpperCase(), tech_type: f.tech_type.value, max_speed_tier: Number(f.max_speed_tier.value || 0), existing_active_service: f.existing_active_service.checked, serviceable: true },
        plan: f.plan.value, include_modem: f.include_modem.checked,
        modem: { sku: f.sku.value, assigned_warehouse: f.assigned_warehouse.value },
        payment_preference: f.payment_preference.value,
        fault_rules: state.extras.fault_rules || []
      };
      if (state.extras.plan_code_override) form.plan_code_override = state.extras.plan_code_override;
      if (state.extras.stock_override) form.stock_override = state.extras.stock_override;
      return { form: form, scenario: state.scenario, edited: state.edited };
    }
    function check() {
      var miss = [];
      if (!f.first_name.value.trim() || !f.last_name.value.trim()) miss.push('the customer name');
      if (!f.mobile.value.trim() && !f.email.value.trim()) miss.push('a mobile or email');
      if (!f.service_address.value.trim()) miss.push('the service address');
      if (!f.loc_id.value.trim()) miss.push('the LOC ID');
      return miss.length ? 'Add ' + miss.join(', ') + '.' : '';
    }

    document.getElementById('preview').addEventListener('click', function () {
      CA.api('POST', '/api/orders/preview', formBody()).then(function (d) {
        CA.modal('Order record that will be sent', (d.problems.length ? '<div class="alert warn" style="margin-bottom:12px">' + esc(d.problems.join(' ')) + '</div>' : '') +
          '<p class="muted small" style="margin-bottom:10px">This is the order_record input the workflow receives. The order number is assigned when you submit.</p><pre class="json">' + esc(JSON.stringify(d.record, null, 2)) + '</pre>',
          '<button class="btn" type="button" data-close>Close</button>');
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
    });

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      err.hidden = true;
      var body;
      if (state.mode === 'json') {
        if (!f.record.value.trim()) { err.textContent = 'Paste an order record first.'; err.hidden = false; return; }
        body = { recordText: f.record.value };
      } else {
        var m = check();
        if (m) { err.textContent = m; err.hidden = false; return; }
        body = formBody();
      }
      var go = document.getElementById('go');
      go.disabled = true; go.textContent = 'Submitting…';
      CA.api('POST', '/api/orders', body).then(function (d) {
        location.href = '/order.html?id=' + encodeURIComponent(d.order.id);
      }).catch(function (e2) {
        if (e2.data && e2.data.order) { location.href = '/order.html?id=' + encodeURIComponent(e2.data.order.id); return; }
        err.textContent = e2.message; err.hidden = false;
        go.disabled = false; go.innerHTML = icon('send') + 'Submit order';
      });
    });

    syncHints();
  }
})();
