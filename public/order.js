(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;
  var id = new URLSearchParams(location.search).get('id');

  var PKG_LABEL = { BILLING: 'Billing', LOGISTICS: 'Logistics', PROVISIONING: 'Provisioning' };
  var PKG_NOTE = {
    BILLING: 'Billing account and plan',
    LOGISTICS: 'Modem shipment',
    PROVISIONING: 'Network activation'
  };

  CA.boot().then(function (me) {
    var app = document.getElementById('app');
    var isDesk = me.user.role === 'desk' || me.user.role === 'admin';
    var timer = null, tick = null, firstRender = true, decision = null, lastStage = null;

    if (!id) { app.innerHTML = '<div class="alert bad">No order selected. <a href="/">Back to orders</a>.</div>'; return; }

    function load(force) {
      CA.api('GET', '/api/orders/' + encodeURIComponent(id) + (force ? '?force=1' : '')).then(function (d) {
        // Don't redraw under someone typing a note unless the order actually moved on.
        var typing = document.activeElement && (document.activeElement.id === 'note' || document.activeElement.id === 'corr');
        if (!typing || d.order.stage !== lastStage) render(d.order);
        lastStage = d.order.stage;
        clearTimeout(timer);
        if (['starting', 'running', 'with_desk'].indexOf(d.order.stage) >= 0) timer = setTimeout(load, 4000);
      }).catch(function (e) {
        app.innerHTML = '<div class="page-head"><div><p class="crumb"><a href="/">Orders</a></p><h1>Order not found</h1></div></div><div class="alert bad">' + esc(e.message) + '</div>';
      });
    }

    function render(o) {
      var rec = o.record || {}, res = o.result || (o.review && o.review.facts) || {};
      var keepCorr = document.getElementById('corr') ? document.getElementById('corr').value : '';
      var cust = rec.customer || {}, svc = rec.service || {}, plan = rec.plan || {}, modem = rec.modem || {};
      // Keep what the reviewer is typing across auto-refreshes.
      var keepNote = document.getElementById('note') ? document.getElementById('note').value : '';

      app.innerHTML =
        '<div class="page-head"><div><p class="crumb"><a href="/">Orders</a> / ' + esc(o.orderId) + '</p>' +
        '<h1>' + esc(o.orderId) + '</h1><p>' + esc(o.customer) + ' · ' + esc(plan.name || '') + ' · submitted by ' + esc(o.submittedBy) + ', ' + esc(CA.fmtDate(o.submittedAt, true)) + '</p></div>' +
        '<div class="toolbar">' + CA.pill(o) +
        (me.user.role === 'admin' ? '<a class="btn small" href="/system.html?run=' + encodeURIComponent(o.id) + '#runlogs">' + icon('file') + 'Run log</a><button class="btn small danger" type="button" id="del">Delete</button>' : '') +
        '</div></div>' +
        links(o) +
        '<div class="layout-main-side"><div class="stack">' + resultCard(o, res, rec) + pipelineCard(o, res, rec) + detailsCard(o, rec, cust, svc, plan, modem) + '</div>' +
        '<div class="stack">' + deskCard(o, res) + timelineCard(o, res) + '</div></div>';

      wire(o);
      if (document.getElementById('note') && keepNote) document.getElementById('note').value = keepNote;
      if (document.getElementById('corr') && keepCorr) document.getElementById('corr').value = keepCorr;
      if (decision) { var r = document.querySelector('input[name="decision"][value="' + decision + '"]'); if (r) { r.checked = true; r.closest('.choice').classList.add('on'); } }
      startCountdown(o);
      if (firstRender) { firstRender = false; document.title = o.orderId + ' · Connect & Activate'; }
    }

    function links(o) {
      var bits = [];
      if (o.reprocessOf) bits.push('This run reprocesses an earlier held run. <a href="/order.html?id=' + encodeURIComponent(o.reprocessOf) + '">Open the original</a>.');
      if (o.reprocessedAs) bits.push('This order was sent again for reprocessing. <a href="/order.html?id=' + encodeURIComponent(o.reprocessedAs) + '">Open the new run</a>.');
      if (o.duplicateOf && !o.reprocessOf) bits.push('An order with the same order number was submitted before. <a href="/order.html?id=' + encodeURIComponent(o.duplicateOf) + '">Open the earlier one</a>; this repeat is left out of report totals.');
      return bits.length ? '<div class="alert info" style="margin-bottom:16px">' + bits.join(' ') + '</div>' : '';
    }

    /* ---------------------------------------------------------- result */
    function resultCard(o, res, rec) {
      var mode = (res.activation_mode || (String((rec.service || {}).tech_type).toUpperCase() === 'FTTP' ? 'TECHNICIAN' : 'REMOTE'));
      if (o.stage === 'starting' || o.stage === 'running') {
        return '<section class="card"><div class="result-hero run"><div class="mark">' + icon('refresh') + '</div><div><h2>Working through the packages</h2>' +
          '<p>Billing, logistics and provisioning are running, with up to three attempts each and automatic fixes where they are safe. This page updates on its own.</p>' +
          (o.pollError ? '<p class="small" style="color:var(--bad);margin-top:6px">Last status check failed: ' + esc(o.pollError) + '</p>' : '') + '</div></div></section>';
      }
      if (o.stage === 'with_desk') {
        var rv = o.review, f = (rv && rv.facts) || {};
        var inConsole = rv && rv.status === 'open';
        var sent = rv && rv.status === 'sent';
        var facts = f.primary_error_code || f.escalation_reason || f.review_queue || f.attempts_made != null
          ? '<div class="tiles">' +
            tile('Error', f.primary_error_code ? '<span class="code-chip">' + esc(f.primary_error_code) + '</span>' : '—', true, o.errorText) +
            tile('Why it was held', CA.REASONS[f.escalation_reason] || CA.words(f.escalation_reason) || '—') +
            tile('Review queue', CA.QUEUES[f.review_queue] || CA.words(f.review_queue) || '—') +
            tile('Attempts made', f.attempts_made == null ? '—' : String(f.attempts_made)) + '</div>'
          : (rv ? '<p class="small muted" style="margin-top:12px">The review task arrived with only the order number; error details appear once the run finishes.</p>' : '');
        return '<section class="card"><div class="result-hero held"><div class="mark">' + icon('pause') + '</div><div><h2>Held · ' + (sent ? 'decision sent, finishing the run' : 'waiting on the Fallout Desk') + '</h2>' +
          '<p>' + (sent ? 'The desk\'s decision was accepted by the workflow. The customer delay notice is being drafted and the result will appear here.'
            : 'At least one package could not be completed automatically. The order is on hold and the responsible team has been alerted. ' + (inConsole ? 'The review task is here in the console — decide it in the Fallout Desk panel.' : 'Waiting for the review task to reach the console.')) + '</p>' +
          (sent ? '' : '<p class="small muted" style="margin-top:8px">Time left in the review window: <span class="countdown" id="cd">—</span>.</p>') + '</div></div>' + facts + '</section>';
      }
      if (o.stage === 'activated' || o.stage === 'validation_gap') {
        var ok = o.stage === 'activated';
        return '<section class="card"><div class="result-hero ' + (ok ? 'ok' : 'bad') + '"><div class="mark">' + icon(ok ? 'checkCircle' : 'alert') + '</div><div>' +
          '<h2>' + (ok ? 'Service activated' : 'Final checks did not pass') + '</h2><p>' + (ok ? 'All three packages completed, final validation passed and the order is closed. The welcome message below is ready for the customer.' : 'The packages reported complete but final validation found a gap, so the order was not closed as active.') + '</p></div></div>' +
          '<div class="tiles">' +
          tile('Activation reference', res.activation_reference || 'Not returned') +
          tile('Plan', (res.plan_name || (rec.plan || {}).name || '—')) +
          tile('Speed', (res.speed_tier || (rec.plan || {}).speed_tier || 0) + ' Mbps') +
          tile('Activation', (res.tech_type || (rec.service || {}).tech_type || '') + ' · ' + (mode === 'TECHNICIAN' ? 'technician visit' : 'remote')) +
          '</div>' + message(res.welcome_message, res.welcome_channel || (rec.customer || {}).preferred_channel, 'Welcome message', rec) + '</section>';
      }
      if (o.stage === 'held') {
        var held = res.held_packages || [];
        var reasonText = res.escalation_reason === 'RETRY_LIMIT' ? 'The package kept failing after ' + (res.attempts_made || 3) + ' attempts, including automatic fixes.' : res.escalation_reason === 'NO_SAFE_FIX' ? 'There is no safe automatic fix for this error, so it went straight to a person.' : '';
        return '<section class="card"><div class="result-hero held"><div class="mark">' + icon('alert') + '</div><div>' +
          '<h2>Order held</h2><p>' + esc(held.map(function (p) { return PKG_LABEL[p] || p; }).join(' and ') || 'A package') + ' could not be completed. ' + esc(reasonText) + ' The customer has been sent a delay notice.</p></div></div>' +
          '<div class="tiles">' +
          tile('Error', res.primary_error_code ? '<span class="code-chip">' + esc(res.primary_error_code) + '</span>' : '—', true, o.errorText) +
          tile('Why it was held', CA.REASONS[res.escalation_reason] || CA.words(res.escalation_reason) || '—') +
          tile('Review queue', CA.QUEUES[res.review_queue] || CA.words(res.review_queue) || '—') +
          tile('Attempts made', String(res.attempts_made == null ? '—' : res.attempts_made)) +
          '</div>' +
          ((res.escalated_fallout_ids || []).length ? '<p class="small muted" style="margin-top:12px">Fallout case' + (res.escalated_fallout_ids.length > 1 ? 's' : '') + ': ' + res.escalated_fallout_ids.map(function (f) { return '<span class="code-chip">' + esc(f) + '</span>'; }).join(' ') + '</p>' : '') +
          message(res.customer_message, res.customer_channel || (rec.customer || {}).preferred_channel, 'Customer delay notice', rec) + '</section>';
      }
      var title = o.stage === 'timed_out' ? 'The run timed out' : o.stage === 'cancelled' ? 'The run was cancelled' : 'The run did not finish';
      return '<section class="card"><div class="result-hero bad"><div class="mark">' + icon('x') + '</div><div><h2>' + title + '</h2>' +
        '<p>' + esc(o.failure || 'Opus reported the run as ' + (o.opusStatus || 'failed') + '.') + '</p>' +
        (o.stage === 'timed_out' && o.waitingSince ? '<p class="small muted" style="margin-top:6px">The order was waiting on the Fallout Desk. The review step closes after ' + o.reviewWindowMinutes + ' minutes without a decision.</p>' : '') +
        '</div></div></section>';
    }

    function tile(label, value, html, sub) {
      return '<div class="tile"><span class="t-label">' + esc(label) + '</span><span class="t-value">' + (html ? value : esc(value)) + '</span>' + (sub ? '<span class="small muted">' + esc(sub) + '</span>' : '') + '</div>';
    }

    function message(text, channel, title, rec) {
      if (!text) return '<p class="small muted" style="margin-top:14px">' + esc(title) + ': not returned by the run.</p>';
      var c = String(channel || 'SMS').toUpperCase();
      var to = c === 'EMAIL' ? (rec.customer || {}).email : (rec.customer || {}).mobile;
      return '<div class="msg" style="margin-top:18px"><h3 class="section-title" style="margin:0">' + esc(title) + '</h3>' +
        '<div class="msg-meta"><span class="tag">' + (c === 'EMAIL' ? 'Email' : 'SMS') + '</span>' + (to ? '<span>to ' + esc(to) + '</span>' : '') + '</div>' +
        '<div class="bubble' + (c === 'EMAIL' ? ' email' : '') + '">' + esc(text) + '<span class="count">' + text.length + ' characters</span></div></div>';
    }

    /* ---------------------------------------------------------- pipeline */
    function pkgState(o, res, rec, type) {
      var running = o.stage === 'running' || o.stage === 'starting';
      if (type === 'LOGISTICS' && !rec.include_modem) return { cls: 'ok', state: 'Not required', note: 'Customer keeps their own modem' };
      if (running) return { cls: '', state: 'In progress', note: PKG_NOTE[type] };
      if (o.stage === 'activated' || o.stage === 'validation_gap') return { cls: 'ok', state: 'Completed', note: PKG_NOTE[type] };
      if (o.stage === 'held') {
        if ((res.held_packages || []).indexOf(type) >= 0) return { cls: 'held', state: 'Escalated', note: res.primary_error_code ? res.primary_error_code + ' · ' + (o.errorText || '') : 'Needs a decision' };
        if ((res.completed_packages || []).indexOf(type) >= 0) return { cls: 'ok', state: 'Completed', note: PKG_NOTE[type] };
        return { cls: '', state: 'Not reported', note: PKG_NOTE[type] };
      }
      if (o.stage === 'with_desk') {
        if ((res.held_packages || []).indexOf(type) >= 0) return { cls: 'held', state: 'Escalated', note: res.primary_error_code ? res.primary_error_code + ' · ' + (o.errorText || '') : 'Needs a decision' };
        if ((res.completed_packages || []).indexOf(type) >= 0) return { cls: 'ok', state: 'Completed', note: PKG_NOTE[type] };
        return { cls: '', state: 'Awaiting review', note: 'Reported after the review' };
      }
      return { cls: '', state: 'Not reported', note: 'The run stopped before reporting packages' };
    }

    function stage(cls, ico, title, text, extra) {
      return '<div class="stage ' + cls + '"><span class="dot">' + icon(ico) + '</span><div class="s-body"><div class="s-title">' + title + '</div>' + (text ? '<div class="s-text">' + text + '</div>' : '') + (extra || '') + '</div></div>';
    }

    function pipelineCard(o, res, rec) {
      var running = o.stage === 'running' || o.stage === 'starting';
      var failed = ['failed', 'timed_out', 'cancelled'].indexOf(o.stage) >= 0;
      var closed = o.stage === 'activated' || o.stage === 'validation_gap';
      var held = o.stage === 'held' || o.stage === 'with_desk';
      var pk = ['BILLING', 'LOGISTICS', 'PROVISIONING'].map(function (t) {
        var s = pkgState(o, res, rec, t);
        return '<div class="pkg ' + s.cls + '"><div class="p-name">' + PKG_LABEL[t] + '</div><div class="p-state">' + esc(s.state) + '</div><div class="p-note">' + esc(s.note) + '</div></div>';
      }).join('');
      var steps = [];
      steps.push(stage(failed && !o.caseRef ? 'bad' : 'done', 'check', 'Order received and standardised', 'Customer, service, plan and modem details put into one internal format.'));
      steps.push(stage(running ? 'now' : failed ? 'skip' : 'done', running ? 'split' : 'check', 'Split into work packages', 'Each package retries up to three times and applies safe automatic fixes.', '<div class="packages">' + pk + '</div>'));
      if (running || failed) {
        steps.push(stage('skip', 'clock', 'Results combined', ''));
        steps.push(stage(failed ? 'bad' : 'skip', failed ? 'x' : 'clock', failed ? 'Stopped' : 'Close or hold', failed ? esc(o.failure || '') : ''));
      } else if (closed) {
        steps.push(stage('done', 'check', 'Results combined', 'Every package completed or was not required.'));
        steps.push(stage(o.stage === 'activated' ? 'done' : 'bad', o.stage === 'activated' ? 'check' : 'x', 'Final validation', o.stage === 'activated' ? 'Billing account active, shipment dispatched or not needed, network activation active.' : 'One or more final checks failed.'));
        steps.push(stage('done', 'send', 'Welcome message drafted', esc(CA.channel(res.welcome_channel)) + ' to the customer.'));
        steps.push(stage(o.stage === 'activated' ? 'done' : 'bad', o.stage === 'activated' ? 'checkCircle' : 'alert', o.stage === 'activated' ? 'Order closed · active' : 'Order closed with a validation gap', res.activation_reference ? 'Activation reference ' + esc(res.activation_reference) + '.' : ''));
      } else if (held) {
        var waiting = o.stage === 'with_desk';
        steps.push(stage('held', 'alert', 'Results combined · held', waiting ? 'At least one package was escalated.' : esc((res.held_packages || []).map(function (p) { return PKG_LABEL[p] || p; }).join(', ')) + ' escalated.'));
        steps.push(stage('held', 'send', 'Team alerted', waiting ? 'The responsible queue was messaged in team chat.' : esc(CA.QUEUES[res.review_queue] || res.review_queue || 'The responsible queue') + ' was messaged in team chat.'));
        steps.push(stage(waiting ? 'now' : 'done', waiting ? 'pause' : 'check', 'Fallout Desk review', waiting ? (o.review && o.review.status === 'sent' ? 'Decision sent: ' + esc((o.resolution || {}).label || '') + '.' : 'Open — reprocess, cancel the package or cancel the order.') : (o.resolution ? (o.resolution.sentToOpus ? 'Decided in the console: ' : 'Recorded here: ') + esc(o.resolution.label) + '.' : 'Decided in Opus; no resolution recorded here yet.')));
        steps.push(stage(waiting ? 'skip' : 'done', waiting ? 'clock' : 'send', 'Customer delay notice', waiting ? '' : 'Sent by ' + esc(CA.channel(res.customer_channel)) + '.'));
        steps.push(stage(waiting ? 'skip' : 'held', waiting ? 'clock' : 'pause', 'Hold recorded', waiting ? '' : 'The order stays on hold until it is reprocessed or cancelled.'));
      }
      return '<section class="card"><div class="card-head"><div><h2>How the order moved</h2><p>The workflow\'s steps for this order.</p></div></div><div class="pipeline">' + steps.join('') + '</div></section>';
    }

    /* ---------------------------------------------------------- details */
    function detailsCard(o, rec, cust, svc, plan, modem) {
      function kv(rows) { return '<dl class="kv">' + rows.filter(function (r) { return r[1] !== undefined && r[1] !== ''; }).map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + (r[2] ? r[1] : esc(r[1])) + '</dd>'; }).join('') + '</dl>'; }
      return '<section class="card"><div class="card-head"><div><h2>Order details</h2><p>What was sent to the workflow.</p></div><div class="toolbar">' +
        '<button class="btn small" type="button" id="show-rec">' + icon('file') + 'Order record</button>' +
        (o.result && isDesk ? '<button class="btn small" type="button" id="show-out">' + icon('file') + 'Workflow output</button>' : '') + '</div></div>' +
        '<div class="grid-2"><div><h3 class="section-title">Customer</h3>' + kv([
          ['Name', o.customer], ['Customer ID', cust.customer_id], ['Mobile', cust.mobile], ['Email', CA.email(cust.email), true],
          ['Prefers', CA.channel(cust.preferred_channel)], ['Service address', cust.service_address],
          ['Delivery address', cust.delivery_address && cust.delivery_address !== cust.service_address ? cust.delivery_address : 'Same as service address']
        ]) + '</div><div><h3 class="section-title">Service and plan</h3>' + kv([
          ['LOC ID', '<span class="code-chip">' + esc(svc.loc_id) + '</span>', true], ['Technology', svc.tech_type + (svc.max_speed_tier ? ' · up to ' + svc.max_speed_tier + ' Mbps' : '')],
          ['Active service there', svc.existing_active_service ? 'Yes' : 'No'],
          ['Plan', esc(plan.name || '') + (plan.plan_code ? ' <span class="nowrap">(' + esc(plan.plan_code) + ')</span>' : ''), true], ['Price', plan.monthly_price_cents ? CA.money(plan.monthly_price_cents) + ' a month' : ''],
          ['Modem', rec.include_modem ? (modem.name || modem.sku) + ' · from ' + (modem.assigned_warehouse === 'WH-SOUTH' ? 'South' : 'North') + ' warehouse' : 'Customer keeps their own'],
          ['Payment', CA.words(rec.payment_preference)]
        ]) + '</div></div>' +
        ((rec.fault_rules || []).length ? '<p class="small muted" style="margin-top:14px">This order carries ' + rec.fault_rules.length + ' simulated fault rule' + (rec.fault_rules.length > 1 ? 's' : '') + ' (' + rec.fault_rules.map(function (r) { return esc(r.error_code); }).join(', ') + ') used to demonstrate fallout handling.</p>' : '') +
        '</section>';
    }

    /* ---------------------------------------------------------- side */
    function deskCard(o, res) {
      if (o.stage !== 'held' && o.stage !== 'with_desk') return '';
      var head = '<section class="card"><div class="card-head"><div><h2>Fallout Desk</h2><p>' + esc(CA.QUEUES[res.review_queue] || 'Dispatch Support') + ' decides how to resolve the hold.</p></div></div>';
      var opusLink = '<a class="btn small" href="' + esc(me.opusReviewUrl) + '" target="_blank" rel="noopener">' + icon('external') + 'Open Opus reviews</a>';
      var rv = o.review;
      if (rv && rv.status === 'open' && !o.resolution) {
        if (!isDesk) return head + '<p class="small">The desk is reviewing this order now.</p></section>';
        return head +
          '<div class="alert info" style="margin-bottom:14px"><strong>Decide here</strong>Your decision goes straight back to the workflow, which then drafts the customer notice and records the hold.</div>' +
          '<div class="choices" role="radiogroup" aria-label="Resolution">' +
          choice('reprocess', 'Reprocess the order', 'Fix what is needed and run it again.') +
          choice('cancel_package', 'Cancel the affected package', 'Keep the rest of the order, drop the failing part.') +
          choice('cancel_order', 'Cancel the entire order', 'Stop the order and tell the customer.') + '</div>' +
          '<label class="field" style="margin-top:12px"><span>Reviewer note</span><textarea id="note" placeholder="What you found and why you chose this resolution."></textarea></label>' +
          (rv.outputs.indexOf('corrected_payload') >= 0 || !rv.outputs.length ? '<details style="margin-top:10px"><summary class="small" style="cursor:pointer;color:var(--brand-ink)">Add corrected details (optional)</summary>' +
            '<textarea class="code" id="corr" spellcheck="false" style="min-height:140px;margin-top:8px" placeholder="{ &quot;order_id&quot;: &quot;' + esc(o.orderId) + '&quot;, … }"></textarea><p class="hint">Only when reprocessing needs changed details. Must be a JSON object.</p></details>' : '') +
          '<div id="d-err" class="alert bad" hidden style="margin-top:10px"></div>' +
          '<button class="btn primary block" type="button" id="send" style="margin-top:12px">' + icon('send') + 'Send decision</button></section>';
      }
      if (rv && rv.status === 'closed' && !o.resolution && isDesk) {
        head += '<div class="alert warn" style="margin-bottom:12px">' + esc(rv.error || 'This review task is closed in Opus.') + '</div>';
      }
      if (o.resolution) {
        return head + '<dl class="kv"><dt>Resolution</dt><dd><strong>' + esc(o.resolution.label) + '</strong></dd><dt>Note</dt><dd>' + esc(o.resolution.note) + '</dd><dt>' + (o.resolution.sentToOpus ? 'Decided by' : 'Recorded by') + '</dt><dd>' + esc(o.resolution.by) + ', ' + esc(CA.fmtDate(o.resolution.at, true)) + '</dd>' +
          (o.resolution.sentToOpus ? '<dt>Workflow</dt><dd><span class="pill ok">Accepted by Opus</span></dd>' : '') + '</dl>' +
          (isDesk && o.stage === 'held' && !o.reprocessedAs ? '<div class="toolbar" style="margin-top:14px"><button class="btn small" type="button" id="reproc">' + icon('refresh') + 'Send again for processing</button></div>' : '') + '</section>';
      }
      if (!isDesk) {
        return head + '<p class="small">' + (o.stage === 'with_desk' ? 'The desk is reviewing this order now.' : 'No resolution has been recorded yet.') + '</p></section>';
      }
      if (o.stage === 'with_desk' && me.webhookMode && !(rv && rv.status === 'closed')) {
        return head + '<p class="small">Waiting for the review task to arrive from the workflow. It usually comes within a few seconds of the hold; the decision panel appears here when it does.</p></section>';
      }
      var intro = o.stage === 'with_desk'
        ? '<div class="alert warn" style="margin-bottom:14px"><strong>Decide in Opus first</strong>The review step is a task in Opus. Choose the resolution there; you can note it here at the same time.</div>'
        : '<p class="small muted" style="margin-bottom:12px">The workflow does not return the reviewer\'s choice, so record it here to keep the order history and reports complete.</p>';
      return head + intro +
        '<div class="toolbar" style="margin-bottom:14px">' + opusLink + '</div>' +
        '<div class="choices" role="radiogroup" aria-label="Resolution">' +
        choice('reprocess', 'Reprocess the order', 'Fix what is needed and run it again.') +
        choice('cancel_package', 'Cancel the affected package', 'Keep the rest of the order, drop the failing part.') +
        choice('cancel_order', 'Cancel the entire order', 'Stop the order and tell the customer.') + '</div>' +
        '<label class="field" style="margin-top:12px"><span>Reviewer note</span><textarea id="note" placeholder="What you found and why you chose this resolution."></textarea></label>' +
        '<div id="d-err" class="alert bad" hidden style="margin-top:10px"></div>' +
        '<button class="btn primary block" type="button" id="record" style="margin-top:12px">Record resolution</button></section>';
    }
    function choice(v, t, s) {
      return '<label class="choice"><input type="radio" name="decision" value="' + v + '"><div><b>' + esc(t) + '</b><span>' + esc(s) + '</span></div></label>';
    }

    function timelineCard(o, res) {
      var rows = [['Submitted', CA.fmtDate(o.submittedAt, true) + ' by ' + o.submittedBy]];
      if (o.waitingSince) rows.push(['Held for review', CA.fmtDate(o.waitingSince, true)]);
      if (o.finishedAt) rows.push(['Finished', CA.fmtDate(o.finishedAt, true)]);
      if (o.finishedAt && o.submittedAt) {
        var s = Math.round((Date.parse(o.finishedAt) - Date.parse(o.submittedAt)) / 1000);
        rows.push(['Run time', s < 90 ? s + ' s' : Math.round(s / 60) + ' min']);
      }
      if (o.scenario && o.scenario !== 'CONSOLE') rows.push(['Example', ((o.record || {}).scenario_name) || o.scenario]);
      return '<section class="card"><h2 style="margin-bottom:12px">Timeline</h2><dl class="kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl></section>';
    }

    /* ---------------------------------------------------------- behaviour */
    function wire(o) {
      var el;
      if ((el = document.getElementById('show-rec'))) el.addEventListener('click', function () {
        CA.modal('Order record', '<pre class="json">' + esc(JSON.stringify(o.record, null, 2)) + '</pre>', '<button class="btn" type="button" data-close>Close</button>');
      });
      if ((el = document.getElementById('show-out'))) el.addEventListener('click', function () {
        CA.modal('Workflow output', '<p class="muted small" style="margin-bottom:10px">' + (o.path === 'held' ? 'Held-order state, from the Record Hold step.' : 'Order state, from the Close Order step.') + '</p><pre class="json">' + esc(JSON.stringify(o.result, null, 2)) + '</pre>', '<button class="btn" type="button" data-close>Close</button>');
      });
      Array.prototype.forEach.call(document.querySelectorAll('input[name="decision"]'), function (r) {
        r.addEventListener('change', function () {
          decision = r.value;
          Array.prototype.forEach.call(document.querySelectorAll('.choice'), function (c) { c.classList.toggle('on', c.contains(r)); });
        });
      });
      if ((el = document.getElementById('record'))) el.addEventListener('click', function () {
        var err = document.getElementById('d-err'); err.hidden = true;
        var pick = document.querySelector('input[name="decision"]:checked');
        if (!pick) { err.textContent = 'Choose one resolution.'; err.hidden = false; return; }
        CA.api('POST', '/api/orders/' + encodeURIComponent(o.id) + '/resolution', { decision: pick.value, note: document.getElementById('note').value })
          .then(function (d) { decision = null; document.getElementById('note').value = ''; render(d.order); CA.toast('Resolution recorded.'); })
          .catch(function (e) { err.textContent = e.message; err.hidden = false; });
      });
      if ((el = document.getElementById('send'))) el.addEventListener('click', function () {
        var err = document.getElementById('d-err'); err.hidden = true;
        var pick = document.querySelector('input[name="decision"]:checked');
        if (!pick) { err.textContent = 'Choose one resolution.'; err.hidden = false; return; }
        var btn = this; btn.disabled = true; btn.textContent = 'Sending…';
        var corr = document.getElementById('corr');
        CA.api('POST', '/api/orders/' + encodeURIComponent(o.id) + '/decide', { decision: pick.value, note: document.getElementById('note').value, correctedText: corr ? corr.value : '' })
          .then(function (d) { decision = null; render(d.order); CA.toast('Decision sent to the workflow.'); clearTimeout(timer); timer = setTimeout(load, 3000); })
          .catch(function (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.innerHTML = icon('send') + 'Send decision'; });
      });
      if ((el = document.getElementById('reproc'))) el.addEventListener('click', function () { reprocess(o); });
      if ((el = document.getElementById('del'))) el.addEventListener('click', function () {
        var m = CA.modal('Delete this order?', '<p>' + esc(o.orderId) + ' will be removed from the console and from report totals. The run in Opus is not affected, and its run log is kept.</p>',
          '<button class="btn" type="button" data-close>Keep it</button><button class="btn danger" type="button" id="del-yes">Delete</button>');
        m.el.querySelector('#del-yes').addEventListener('click', function () {
          CA.api('DELETE', '/api/orders/' + encodeURIComponent(o.id)).then(function () { location.href = '/'; }).catch(function (e) { CA.toast(e.message, 'bad'); });
        });
      });
    }

    function reprocess(o) {
      var m = CA.modal('Send the order again',
        '<p style="margin-bottom:10px">A new run starts with the order record below. Correct anything that caused the hold first — for example a delivery address or LOC ID. Simulated fault rules stay as they are unless you change them.</p>' +
        '<textarea class="code" id="rp-text" spellcheck="false">' + esc(JSON.stringify(o.record, null, 2)) + '</textarea><div id="rp-err" class="alert bad" hidden style="margin-top:10px"></div>',
        '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="rp-go">' + icon('refresh') + 'Start new run</button>');
      m.el.querySelector('#rp-go').addEventListener('click', function () {
        var txt = m.el.querySelector('#rp-text').value;
        var changed = txt.trim() !== JSON.stringify(o.record, null, 2).trim();
        CA.api('POST', '/api/orders/' + encodeURIComponent(o.id) + '/resubmit', changed ? { recordText: txt } : {})
          .then(function (d) { location.href = '/order.html?id=' + encodeURIComponent(d.order.id); })
          .catch(function (e) { var er = m.el.querySelector('#rp-err'); er.textContent = e.message; er.hidden = false; });
      });
    }

    function startCountdown(o) {
      clearInterval(tick);
      var cd = document.getElementById('cd');
      if (!cd || !o.waitingSince) return;
      var end = Date.parse(o.waitingSince) + o.reviewWindowMinutes * 60000;
      function upd() {
        var left = Math.max(0, Math.round((end - Date.now()) / 1000));
        cd.textContent = left ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'closing — Opus may time the run out';
      }
      upd(); tick = setInterval(upd, 1000);
    }

    load(true);
  });
})();
