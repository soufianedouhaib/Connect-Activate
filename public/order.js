(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;
  var id = new URLSearchParams(location.search).get('id');

  var PKG_LABEL = { BILLING: 'Billing', LOGISTICS: 'Logistics', PROVISIONING: 'Provisioning' };
  var PKG_NOTE = { BILLING: 'Billing account and plan', LOGISTICS: 'Modem shipment', PROVISIONING: 'Network activation' };
  var TYPES = ['BILLING', 'LOGISTICS', 'PROVISIONING'];

  CA.boot().then(function (me) {
    var app = document.getElementById('app');
    var isDesk = me.user.role === 'desk' || me.user.role === 'admin';
    var timer = null, tick = null, firstRender = true, decision = null, lastStage = null, catalogue = null;

    if (!id) { app.innerHTML = '<div class="alert bad">No order selected. <a href="/">Back to orders</a>.</div>'; return; }
    CA.api('GET', '/api/catalogue').then(function (c) { catalogue = c; }).catch(function () { /* modem names fall back to codes */ });

    var FORM_IDS = ['note', 'c-loc', 'c-addr', 'c-modem', 'c-exist'];
    function typingInForm() { return document.activeElement && FORM_IDS.indexOf(document.activeElement.id) >= 0; }

    function load(force) {
      CA.api('GET', '/api/orders/' + encodeURIComponent(id) + (force ? '?force=1' : '')).then(function (d) {
        // Don't redraw under someone filling in the decision unless the order actually moved on.
        if (!typingInForm() || d.order.stage !== lastStage) render(d.order);
        lastStage = d.order.stage;
        clearTimeout(timer);
        if (['starting', 'running', 'with_desk'].indexOf(d.order.stage) >= 0) timer = setTimeout(load, 4000);
      }).catch(function (e) {
        app.innerHTML = '<div class="page-head"><div><p class="crumb"><a href="/">Orders</a></p><h1>Order not found</h1></div></div><div class="alert bad">' + esc(e.message) + '</div>';
      });
    }

    function keepForm() {
      var k = {};
      FORM_IDS.forEach(function (f) { var el = document.getElementById(f); if (el) k[f] = el.type === 'checkbox' ? el.checked : el.value; });
      var det = document.getElementById('c-more'); if (det) k.open = det.open;
      return k;
    }
    function restoreForm(k) {
      FORM_IDS.forEach(function (f) { var el = document.getElementById(f); if (el && f in k) { if (el.type === 'checkbox') el.checked = k[f]; else el.value = k[f]; } });
      var det = document.getElementById('c-more'); if (det && k.open) det.open = true;
    }

    function render(o) {
      var rec = o.record || {}, res = o.result || (o.review && o.review.facts) || {};
      var cust = rec.customer || {}, svc = rec.service || {}, plan = rec.plan || {}, modem = rec.modem || {};
      var kept = keepForm();

      app.innerHTML =
        '<div class="page-head"><div><p class="crumb"><a href="/">Orders</a> / ' + esc(o.orderId) + '</p>' +
        '<h1>' + esc(o.orderId) + '</h1><p>' + esc(o.customer) + ' · ' + esc(plan.name || '') + ' · submitted by ' + esc(o.submittedBy) + ', ' + esc(CA.fmtDate(o.submittedAt, true)) + '</p></div>' +
        '<div class="toolbar">' + CA.pill(o) + (o.autoFixed ? '<span class="pill ok plain">Fixed automatically</span>' : '') +
        (me.user.role === 'admin' ? '<a class="btn small" href="/system.html?run=' + encodeURIComponent(o.id) + '#runlogs">' + icon('file') + 'Run log</a><button class="btn small danger" type="button" id="del">Delete</button>' : '') +
        '</div></div>' +
        links(o) +
        '<div class="layout-main-side"><div class="stack">' + resultCard(o, res, rec) + pipelineCard(o, res, rec) + detailsCard(o, rec, cust, svc, plan, modem) + '</div>' +
        '<div class="stack">' + deskCard(o, res, rec) + timelineCard(o) + '</div></div>';

      wire(o);
      restoreForm(kept);
      if (decision) { var r = document.querySelector('input[name="decision"][value="' + decision + '"]'); if (r) { r.checked = true; r.closest('.choice').classList.add('on'); } }
      startCountdown(o);
      if (firstRender) {
        firstRender = false;
        document.title = o.orderId + ' · Connect & Activate';
        if (location.hash === '#decide') { var dk = document.getElementById('desk'); if (dk) setTimeout(function () { dk.scrollIntoView({ block: 'start' }); }, 50); }
      }
    }

    function links(o) {
      var bits = [];
      if (o.reprocessOf) bits.push('This run reprocesses an earlier held run' + (o.corrections && o.corrections.length ? ', with these changes: ' + esc(o.corrections.join('; ')) : '') + '. <a href="/order.html?id=' + encodeURIComponent(o.reprocessOf) + '">Open the first run</a>.');
      if (o.reprocessedAs) bits.push('This order was sent again for processing. <a href="/order.html?id=' + encodeURIComponent(o.reprocessedAs) + '">Open the new run</a>.');
      if (o.duplicateOf && !o.reprocessOf) bits.push('The same order number was submitted before. <a href="/order.html?id=' + encodeURIComponent(o.duplicateOf) + '">Open the earlier one</a>; reports count the order once, by its newest run.');
      return bits.length ? '<div class="alert info" style="margin-bottom:16px">' + bits.join(' ') + '</div>' : '';
    }

    function pkgNames(list) { return (list || []).map(function (p) { return PKG_LABEL[p] || CA.words(p); }); }
    function joinNames(list) { var n = pkgNames(list); return n.length > 1 ? n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1] : (n[0] || ''); }
    function fixes(o) { return (o.trace && o.trace.fixes) || []; }

    /* ---------------------------------------------------------- result */
    function holdTiles(o, f) {
      return '<div class="tiles">' +
        tile('Error', f.primary_error_code ? '<span class="code-chip">' + esc(f.primary_error_code) + '</span>' : 'Not reported', true, o.errorText) +
        tile('Why it was held', CA.REASONS[f.escalation_reason] || CA.words(f.escalation_reason) || 'Not reported') +
        tile('Review queue', CA.QUEUES[f.review_queue] || CA.words(f.review_queue) || 'Not reported') +
        tile('Attempts made', f.attempts_made == null || f.attempts_made === '' ? 'Not reported' : String(f.attempts_made)) + '</div>';
    }

    function resultCard(o, res, rec) {
      var mode = (res.activation_mode || (String((rec.service || {}).tech_type).toUpperCase() === 'FTTP' ? 'TECHNICIAN' : 'REMOTE'));
      if (o.stage === 'starting' || o.stage === 'running') {
        return '<section class="card"><div class="result-hero run"><div class="mark">' + icon('refresh') + '</div><div><h2>Working through the packages</h2>' +
          '<p>Billing, logistics and provisioning are running, with up to three attempts each and automatic fixes where they are safe. This page updates on its own.</p>' +
          (o.pollError ? '<p class="small" style="color:var(--bad);margin-top:6px">Last status check failed: ' + esc(o.pollError) + '</p>' : '') + '</div></div></section>';
      }
      if (o.stage === 'with_desk') {
        var rv = o.review;
        var sent = rv && rv.status === 'sent';
        var hasFacts = res.primary_error_code || res.escalation_reason || res.review_queue || res.attempts_made;
        return '<section class="card"><div class="result-hero held"><div class="mark">' + icon('pause') + '</div><div><h2>Held · ' + (sent ? 'decision sent, finishing the run' : 'waiting on the Fallout Desk') + '</h2>' +
          '<p>' + (sent ? 'The decision was accepted by the workflow. The customer notice is being drafted and the result will appear here.'
            : (joinNames(res.held_packages) || 'A package') + ' could not be completed automatically. The order is on hold and the responsible team has been alerted. ' + (rv && rv.status === 'open' ? 'Decide it in the Fallout Desk panel on this page.' : 'The review task appears here within a few seconds.')) + '</p>' +
          (sent ? '' : '<p class="small muted" style="margin-top:8px">Time left to decide: <span class="countdown" id="cd">calculating</span>.</p>') + '</div></div>' +
          (hasFacts ? holdTiles(o, res) : '') + '</section>';
      }
      if (o.stage === 'activated' || o.stage === 'validation_gap') {
        var ok = o.stage === 'activated';
        var rec2 = fixes(o).filter(function (f) { return f.recovered; });
        var healed = rec2.length ? '<div class="alert ok" style="margin-top:16px"><strong>Recovered without a person</strong>' + rec2.map(function (f) {
          return esc(CA.nb(PKG_LABEL[f.package] + ' failed with ' + f.errorCode + ' on ' + (f.when || 'attempt ' + f.attempt) + '. ' + f.summary));
        }).join('<br>') + '</div>' : '';
        return '<section class="card"><div class="result-hero ' + (ok ? 'ok' : 'bad') + '"><div class="mark">' + icon(ok ? 'checkCircle' : 'alert') + '</div><div>' +
          '<h2>' + (ok ? 'Service activated' : 'Final checks did not pass') + '</h2><p>' + (ok ? (o.droppedPackage === 'LOGISTICS' ? 'Billing and network activation completed, final validation passed and the order is closed. The modem shipment was dropped at the Fallout Desk, so no modem is sent.' : rec2.length ? 'Every package completed, ' + joinNames(rec2.map(function (f) { return f.package; }).filter(function (p, i, a) { return a.indexOf(p) === i; })) + ' after an automatic fix, final validation passed and the order is closed.' : 'All three packages completed, final validation passed and the order is closed.') + ' The welcome message below is ready for the customer.' : 'The packages reported complete but final validation found a gap, so the order was not closed as active.') + '</p></div></div>' +
          '<div class="tiles">' +
          tile('Activation reference', res.activation_reference || 'Not returned') +
          tile('Plan', (res.plan_name || (rec.plan || {}).name || 'Not reported')) +
          tile('Speed', (res.speed_tier || (rec.plan || {}).speed_tier || 0) + ' Mbps') +
          tile('Activation', (res.tech_type || (rec.service || {}).tech_type || '') + ' · ' + (mode === 'TECHNICIAN' ? 'technician visit' : 'remote')) +
          '</div>' + healed + message(res.welcome_message, res.welcome_channel || (rec.customer || {}).preferred_channel, 'Welcome message', rec) + '</section>';
      }
      if (o.stage === 'held' && o.category === 'cancelled') {
        return '<section class="card"><div class="result-hero bad"><div class="mark">' + icon('x') + '</div><div>' +
          '<h2>Order cancelled</h2><p>' + esc(joinNames(res.held_packages) || 'A package') + ' could not be completed' + (res.primary_error_code ? ' (' + CA.nb(res.primary_error_code) + ')' : '') + ', and the Fallout Desk cancelled the order' + (o.resolution ? ' on ' + esc(CA.fmtDate(o.resolution.at, true)) : '') + '.</p></div></div>' +
          holdTiles(o, res) + cancelNoticeBlock(o.cancelNotice, o) +
          (res.customer_message ? '<details class="table-view" style="margin-top:14px"><summary>Notice the workflow drafted</summary>' +
            '<p class="small muted" style="margin:8px 0 0">The workflow drafts this delay notice whatever the desk decides, so it does not mention the cancellation. Send the cancellation notice above instead.</p>' +
            message(res.customer_message, res.customer_channel || (rec.customer || {}).preferred_channel, 'Delay notice from the workflow', rec) + '</details>' : '') + '</section>';
      }
      if (o.stage === 'held') {
        var reasonText = res.escalation_reason === 'RETRY_LIMIT' ? 'It failed all ' + (res.attempts_made || 3) + ' attempts, including the automatic fixes.' : res.escalation_reason === 'NO_SAFE_FIX' ? 'There is no safe automatic fix for this error, so it went straight to a person.' : '';
        return '<section class="card"><div class="result-hero held"><div class="mark">' + icon('alert') + '</div><div>' +
          '<h2>' + (o.reprocessedAs ? ((o.resolution || {}).decision === 'cancel_package' ? 'Held · sent on without the modem' : 'Held · sent again') : 'Order held') + '</h2><p>' + esc(joinNames(res.held_packages) || 'A package') + ' could not be completed. ' + esc(reasonText) + ' The workflow drafted a delay notice for the customer.' + (o.reprocessedAs ? ' The order was then sent again; the new run is linked above.' : '') + '</p></div></div>' +
          holdTiles(o, res) +
          ((res.escalated_fallout_ids || []).length ? '<p class="small muted" style="margin-top:12px">Fallout case' + (res.escalated_fallout_ids.length > 1 ? 's' : '') + ': ' + res.escalated_fallout_ids.map(function (f) { return '<span class="code-chip">' + esc(f) + '</span>'; }).join(' ') + '</p>' : '') +
          message(res.customer_message, res.customer_channel || (rec.customer || {}).preferred_channel, 'Customer delay notice', rec) + '</section>';
      }
      var title = o.stage === 'timed_out' ? 'The run timed out' : o.stage === 'cancelled' ? 'The run was cancelled' : 'The run did not finish';
      return '<section class="card"><div class="result-hero bad"><div class="mark">' + icon('x') + '</div><div><h2>' + title + '</h2>' +
        '<p>' + esc(o.failure || 'The workflow reported the run as ' + CA.words(o.opusStatus || 'failed').toLowerCase() + '.') + '</p>' +
        (o.stage === 'timed_out' && o.waitingSince ? '<p class="small muted" style="margin-top:6px">The order was waiting on the Fallout Desk. The review step closes after ' + o.reviewWindowMinutes + ' minutes without a decision.</p>' : '') +
        '</div></div></section>';
    }

    function tile(label, value, html, sub) {
      return '<div class="tile"><span class="t-label">' + esc(label) + '</span><span class="t-value">' + (html ? value : esc(value)) + '</span>' + (sub ? '<span class="small muted">' + esc(sub) + '</span>' : '') + '</div>';
    }

    function cancelNoticeBlock(n, o) {
      if (!n) return '';
      return '<div class="msg" style="margin-top:18px"><h3 class="section-title" style="margin:0">Cancellation notice</h3>' +
        '<div class="msg-meta"><span class="tag">' + (n.channel === 'EMAIL' ? 'Email' : 'SMS') + '</span>' + (n.to ? '<span>to ' + esc(n.to) + '</span>' : '') +
        '<button class="btn small" type="button" id="copy-cancel" style="margin-left:auto">' + icon('file') + 'Copy</button></div>' +
        '<div class="bubble' + (n.channel === 'EMAIL' ? ' email' : '') + '" id="cancel-text">' + esc(n.text).split(esc(o.orderId)).join('<span class="nowrap">' + esc(o.orderId) + '</span>') + '<span class="count">' + n.text.length + ' characters</span></div>' +
        '<p class="small muted" style="margin-top:6px">Written by the console from the error on this order. The workflow does not send it, so send it to the customer from your usual channel.</p></div>';
    }

    function message(text, channel, title, rec) {
      if (!text) return '<p class="small muted" style="margin-top:14px">' + esc(title) + ': not returned by the run.</p>';
      var c = String(channel || 'SMS').toUpperCase();
      var to = c === 'EMAIL' ? (rec.customer || {}).email : (rec.customer || {}).mobile;
      return '<div class="msg" style="margin-top:18px"><h3 class="section-title" style="margin:0">' + esc(title) + '</h3>' +
        '<div class="msg-meta"><span class="tag">' + (c === 'EMAIL' ? 'Email' : 'SMS') + '</span>' + (to ? '<span>to ' + esc(to) + '</span>' : '') + '</div>' +
        '<div class="bubble' + (c === 'EMAIL' ? ' email' : '') + '">' + esc(text) + '<span class="count">' + text.length + ' characters</span></div></div>';
    }

    /* ---------------------------------------------------------- packages */
    function attemptsText(p, max) {
      if (p.attempts == null || p.status === 'NOT_REQUIRED') return '';
      if (p.status === 'COMPLETED') return p.attempts > 1 ? 'Succeeded on attempt ' + p.attempts + ' of ' + max : 'First attempt';
      return 'Stopped after ' + p.attempts + ' attempt' + (p.attempts > 1 ? 's' : '');
    }

    /* What a package card shows. The Opus step log is the source when it was read;
       otherwise the held or closed output decides. */
    function pkgState(o, res, rec, type) {
      var running = o.stage === 'running' || o.stage === 'starting';
      var p = o.trace && o.trace.packages && o.trace.packages[type];
      var max = (rec.retry_policy && rec.retry_policy.max_attempts) || 3;
      if (type === 'LOGISTICS' && !rec.include_modem) return o.droppedPackage === 'LOGISTICS'
        ? { cls: 'ok', state: 'Dropped', note: 'Cancelled at the Fallout Desk; no modem is shipped' }
        : { cls: 'ok', state: 'Not required', note: 'Customer keeps their own modem' };
      if (running && !p) return { cls: '', state: 'In progress', note: PKG_NOTE[type] };
      if (p && p.status) {
        var lines = [];
        var at = attemptsText(p, max); if (at) lines.push(at);
        if (p.reference) lines.push('Ref ' + p.reference);
        var first = o.firstRunPackages && o.firstRunPackages[type];
        if (first && first.reference && first.reference === p.reference) lines.push('same as the first run');
        var f = p.fallout;
        // Each distinct fix once: a retry that tried the same thing again is not a second fix.
        var fix = f && f.fixes.length ? f.fixes.map(function (x) { return x.summary; }).filter(function (s, i, a) { return s && a.indexOf(s) === i; }).join(' ') : '';
        var tries = f ? f.fixes.length : 0;
        var sameEachTime = tries > 1 && fix && f.fixes.every(function (x) { return x.summary === f.fixes[0].summary; });
        if (p.status === 'COMPLETED') return { cls: 'ok', state: 'Completed', note: lines.join(' · ') || PKG_NOTE[type], fix: f && f.status === 'RESOLVED' ? (f.errorCode + ' fixed automatically. ' + fix) : '' };
        if (p.status === 'NOT_REQUIRED') return { cls: 'ok', state: 'Not required', note: PKG_NOTE[type] };
        var err = p.lastError || (f && f.errorCode) || '';
        return { cls: 'held', state: 'Escalated', note: [err ? err + (CA.ERRORS[err] ? ' · ' + CA.ERRORS[err] : '') : ''].concat(lines).filter(Boolean).join(' · '), fix: fix ? 'Tried' + (sameEachTime ? ' on attempts ' + f.fixes.map(function (x) { return x.attempt; }).join(' and ') : '') + ': ' + fix : '' };
      }
      if (o.stage === 'activated' || o.stage === 'validation_gap') return { cls: 'ok', state: 'Completed', note: PKG_NOTE[type] };
      if (o.stage === 'held' || o.stage === 'with_desk') {
        if ((res.held_packages || []).indexOf(type) >= 0) return { cls: 'held', state: 'Escalated', note: res.primary_error_code ? res.primary_error_code + ' · ' + (o.errorText || '') : 'Needs a decision' };
        if ((res.completed_packages || []).indexOf(type) >= 0) return { cls: 'ok', state: 'Completed', note: PKG_NOTE[type] };
        return { cls: '', state: o.stage === 'with_desk' ? 'Awaiting review' : 'Not reported', note: PKG_NOTE[type] };
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
      var pk = TYPES.map(function (t) {
        var s = pkgState(o, res, rec, t);
        return '<div class="pkg ' + s.cls + '"><div class="p-name">' + PKG_LABEL[t] + '</div><div class="p-state">' + esc(s.state) + '</div><div class="p-note">' + esc(CA.nb(s.note)) + '</div>' +
          (s.fix ? '<div class="p-fix">' + esc(CA.nb(s.fix)) + '</div>' : '') + '</div>';
      }).join('');
      var fx = fixes(o);
      var steps = [];
      steps.push(stage(failed && !o.caseRef ? 'bad' : 'done', 'check', 'Order received and standardised', 'Customer, service, plan and modem details put into one internal format.'));
      steps.push(stage(running ? 'now' : failed ? 'skip' : 'done', running ? 'split' : 'check', 'Split into work packages', 'Each package retries up to three times and applies safe automatic fixes.', '<div class="packages">' + pk + '</div>'));
      if (fx.length) {
        var recovered = fx.filter(function (f) { return f.recovered; });
        steps.push(stage(recovered.length === fx.length ? 'done' : 'held', 'refresh', recovered.length === fx.length ? 'Fixed automatically' : 'Automatic fixes tried',
          fx.map(function (f) {
            var when = f.when || ('attempt ' + f.attempt);
            return esc(CA.nb(PKG_LABEL[f.package] + ', ' + when + ': ' + f.summary + (f.repeated ? ' Same result each time.' : '') + (f.recovered ? ' The next attempt succeeded.' : '')));
          }).join('<br>')));
      }
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
        var names = joinNames(res.held_packages);
        var queue = CA.QUEUES[res.review_queue] || CA.words(res.review_queue);
        steps.push(stage('held', 'alert', 'Results combined · held', esc(names ? names + ' escalated.' : 'A package was escalated.')));
        steps.push(stage('held', 'send', 'Team alerted', esc((queue || 'The responsible queue') + ' was alerted by the workflow\'s Hold Order and Alert Team step.')));
        steps.push(stage(waiting ? 'now' : 'done', waiting ? 'pause' : 'check', 'Fallout Desk review', waiting ? (o.review && o.review.status === 'sent' ? 'Decision sent: ' + esc((o.resolution || {}).label || '') + '.' : 'Open: reprocess, cancel the package or cancel the order.') : (o.resolution ? 'Decided: ' + esc(o.resolution.label) + '.' : 'The review step closed without a decision from the console.')));
        var dec = o.resolution && o.resolution.decision;
        steps.push(stage(waiting ? 'skip' : 'done', waiting ? 'clock' : 'send', 'Customer notice', waiting ? '' : dec === 'cancel_order'
          ? 'The workflow drafted its usual delay notice; the console wrote the cancellation notice to send instead.'
          : 'Delay notice drafted for ' + esc(CA.channel(res.customer_channel)) + '.'));
        if (waiting) steps.push(stage('skip', 'clock', 'Hold recorded', ''));
        else if (dec === 'cancel_order') steps.push(stage('bad', 'x', 'Order cancelled', 'The workflow records the order as held; the Fallout Desk cancelled it.'));
        else if (dec === 'cancel_package') steps.push(o.reprocessedAs
          ? stage('done', 'refresh', 'Modem shipment dropped · sent on', 'The workflow records every decision as a hold, so the console started a new run without the modem. Billing and network activation finish there.')
          : stage('held', 'pause', 'Hold recorded · package cancelled', 'The workflow records every decision as a hold. Send the order again without the modem to activate the rest.'));
        else steps.push(stage('held', 'pause', 'Hold recorded', o.reprocessedAs ? 'The order was sent again for processing.' : 'The order stays on hold until it is sent again or cancelled.'));
      }
      return '<section class="card"><div class="card-head"><div><h2>How the order moved</h2><p>The workflow\'s steps for this order' + (o.trace ? ', from the step log of this run' : '') + '.</p></div></div><div class="pipeline">' + steps.join('') + '</div></section>';
    }

    /* ---------------------------------------------------------- details */
    function detailsCard(o, rec, cust, svc, plan, modem) {
      function kv(rows) { return '<dl class="kv">' + rows.filter(function (r) { return r[1] !== undefined && r[1] !== ''; }).map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + (r[2] ? r[1] : esc(r[1])) + '</dd>'; }).join('') + '</dl>'; }
      var billed = o.trace && o.trace.packages && o.trace.packages.BILLING && o.trace.packages.BILLING.payload && o.trace.packages.BILLING.payload.plan_code;
      var planCell = esc(plan.name || '') + (plan.plan_code ? ' <span class="nowrap">(' + esc(plan.plan_code) + ')</span>' : '');
      if (billed && plan.plan_code && billed !== plan.plan_code) planCell += '<span class="sub-line">Billed as ' + esc(CA.nb(billed)) + ' after the automatic fix</span>';
      return '<section class="card"><div class="card-head"><div><h2>Order details</h2><p>What was sent to the workflow.</p></div><div class="toolbar">' +
        '<button class="btn small" type="button" id="show-rec">' + icon('file') + 'Order record</button>' +
        (o.outputRaw ? '<button class="btn small" type="button" id="show-out">' + icon('file') + 'Workflow output</button>' : '') + '</div></div>' +
        '<div class="grid-2"><div><h3 class="section-title">Customer</h3>' + kv([
          ['Name', o.customer], ['Customer ID', cust.customer_id], ['Mobile', cust.mobile], ['Email', CA.email(cust.email), true],
          ['Prefers', CA.channel(cust.preferred_channel)], ['Service address', cust.service_address],
          ['Delivery address', cust.delivery_address && cust.delivery_address !== cust.service_address ? cust.delivery_address : 'Same as service address']
        ]) + '</div><div><h3 class="section-title">Service and plan</h3>' + kv([
          ['LOC ID', '<span class="code-chip">' + esc(svc.loc_id) + '</span>', true], ['Technology', svc.tech_type + (svc.max_speed_tier ? ' · up to ' + svc.max_speed_tier + ' Mbps' : '')],
          ['Active service there', svc.existing_active_service ? 'Yes' : 'No'],
          ['Plan', planCell, true], ['Price', plan.monthly_price_cents ? CA.money(plan.monthly_price_cents) + ' a month' : ''],
          ['Modem', rec.include_modem ? (modem.name || modem.sku) + ' · from ' + (modem.assigned_warehouse === 'WH-SOUTH' ? 'South' : 'North') + ' warehouse' : o.droppedPackage === 'LOGISTICS' ? 'None, dropped at the Fallout Desk' : 'Customer keeps their own'],
          ['Payment', CA.words(rec.payment_preference)]
        ]) + '</div></div>' +
        ((rec.fault_rules || []).length ? '<p class="small muted" style="margin-top:14px">This example carries ' + rec.fault_rules.length + ' simulated fault' + (rec.fault_rules.length > 1 ? 's' : '') + ' (' + rec.fault_rules.map(function (r) { return esc(r.error_code); }).join(', ') + ') to show how the workflow handles it.</p>' : '') +
        '</section>';
    }

    /* ---------------------------------------------------------- Fallout Desk */
    function correctionFields(o, rec) {
      var svc = rec.service || {}, cust = rec.customer || {}, modem = rec.modem || {};
      var modems = (catalogue && catalogue.modems) || { 'MDM-G3': 'Orbit Smart Modem Gen 3', 'MDM-G2': 'Orbit Smart Modem Gen 2' };
      return '<div class="form-grid one">' +
        '<label class="field"><span>LOC ID</span><input type="text" id="c-loc" value="' + esc(svc.loc_id || '') + '" spellcheck="false" autocomplete="off"></label>' +
        '<label class="field"><span>Delivery address</span><input type="text" id="c-addr" value="' + esc(cust.delivery_address || cust.service_address || '') + '" autocomplete="off"></label>' +
        (rec.include_modem ? '<label class="field"><span>Modem</span><select id="c-modem">' + Object.keys(modems).map(function (k) { return '<option value="' + esc(k) + '"' + (k === modem.sku ? ' selected' : '') + '>' + esc(modems[k]) + '</option>'; }).join('') + '</select></label>' : '') +
        '<label class="check"><input type="checkbox" id="c-exist"' + (svc.existing_active_service ? ' checked' : '') + '> There is still an active service at the address</label>' +
        '</div>';
    }
    function readCorrectionFields() {
      var c = {};
      var loc = document.getElementById('c-loc'), addr = document.getElementById('c-addr'), mdm = document.getElementById('c-modem'), ex = document.getElementById('c-exist');
      if (loc) c.loc_id = loc.value;
      if (addr) c.delivery_address = addr.value;
      if (mdm) c.modem_sku = mdm.value;
      if (ex) c.existing_active_service = ex.checked;
      return c;
    }
    function correctionsText(c) {
      if (!c) return '';
      var bits = [];
      if (c.loc_id) bits.push('LOC ID ' + c.loc_id);
      if (c.delivery_address) bits.push('delivery address ' + c.delivery_address);
      if (c.modem_sku) bits.push('modem ' + c.modem_sku);
      if (typeof c.existing_active_service === 'boolean') bits.push(c.existing_active_service ? 'active service at the address' : 'no active service at the address');
      return bits.join('; ');
    }

    function deskCard(o, res, rec) {
      if (o.stage !== 'held' && o.stage !== 'with_desk') return '';
      var queue = CA.QUEUES[res.review_queue] || CA.words(res.review_queue);
      var head = '<section class="card" id="desk"><div class="card-head"><div><h2>Fallout Desk</h2><p>' + esc(queue ? queue + ' decides how to resolve the hold.' : 'Decide how to resolve the hold.') + '</p></div></div>';
      var rv = o.review;
      if (rv && rv.status === 'open' && !o.resolution) {
        if (!isDesk) return head + '<p class="small">The desk is reviewing this order now.</p></section>';
        return head +
          '<div class="alert info" style="margin-bottom:14px"><strong>Decide here</strong>Your decision goes straight back to the workflow, which then drafts the customer notice and records the hold.</div>' +
          '<div class="choices" role="radiogroup" aria-label="Resolution">' +
          choices(o) +
          '<label class="field" style="margin-top:12px"><span>Reviewer note</span><textarea id="note" placeholder="What you found and why you chose this resolution."></textarea></label>' +
          '<details id="c-more" style="margin-top:10px"><summary class="small" style="cursor:pointer;color:var(--brand-ink)">Correct the order details (optional)</summary>' +
          '<p class="hint" style="margin:8px 0 10px">Change only what caused the hold. The corrections travel with the decision and are filled in when the order is sent again.</p>' + correctionFields(o, rec) + '</details>' +
          '<div id="d-err" class="alert bad" hidden style="margin-top:10px"></div>' +
          '<button class="btn primary block" type="button" id="send" style="margin-top:12px">' + icon('send') + 'Send decision</button></section>';
      }
      if (o.resolution) {
        var corr = correctionsText(o.resolutionCorrections);
        return head + '<dl class="kv"><dt>Resolution</dt><dd><strong>' + esc(o.resolution.label) + '</strong></dd><dt>Note</dt><dd>' + esc(o.resolution.note) + '</dd>' +
          (corr ? '<dt>Corrections</dt><dd>' + esc(corr) + '</dd>' : '') +
          '<dt>Decided by</dt><dd>' + esc(o.resolution.by) + ', ' + esc(CA.fmtDate(o.resolution.at, true)) + '</dd>' +
          (o.resolution.sentToOpus ? '<dt>Workflow</dt><dd><span class="pill ok">Accepted by the workflow</span></dd>' : '') + '</dl>' +
          (isDesk && o.stage === 'held' && !o.reprocessedAs && o.resolution.decision === 'cancel_package' && o.canDropPackage ? '<div class="toolbar" style="margin-top:14px"><button class="btn small primary" type="button" id="dropgo">' + icon('refresh') + 'Send on without the modem</button></div>' :
            isDesk && o.stage === 'held' && !o.reprocessedAs && o.resolution.decision !== 'cancel_order' ? '<div class="toolbar" style="margin-top:14px"><button class="btn small" type="button" id="reproc">' + icon('refresh') + 'Send again for processing</button></div>' : '') + '</section>';
      }
      if (!isDesk) return head + '<p class="small">' + (o.stage === 'with_desk' ? 'The desk is reviewing this order now.' : 'No decision has been recorded.') + '</p></section>';
      if (o.stage === 'with_desk') return head + '<p class="small">Waiting for the review task to arrive from the workflow. It usually comes within a few seconds of the hold; the decision panel appears here when it does.</p></section>';
      // Held, and the review step closed without a decision from the console.
      return head +
        '<div class="alert warn" style="margin-bottom:12px">' + esc((rv && rv.error) || 'The review step closed before a decision was sent.') + ' Record what was decided so the order history and reports are complete.</div>' +
        choices(o) +
        '<label class="field" style="margin-top:12px"><span>Reviewer note</span><textarea id="note" placeholder="What you found and why you chose this resolution."></textarea></label>' +
        '<div id="d-err" class="alert bad" hidden style="margin-top:10px"></div>' +
        '<button class="btn primary block" type="button" id="record" style="margin-top:12px">Record decision</button></section>';
    }
    function choices(o) {
      return '<div class="choices" role="radiogroup" aria-label="Resolution">' +
        choice('reprocess', 'Reprocess the order', 'Fix what is needed and run it again.') +
        (o.canDropPackage
          ? choice('cancel_package', 'Cancel the affected package', 'Drop the modem shipment and activate the rest. The console sends the order on without the modem.')
          : choice('cancel_package', 'Cancel the affected package', o.dropBlocked || 'Not available for this order.', true)) +
        choice('cancel_order', 'Cancel the entire order', 'Stop the order. The console writes the cancellation notice for the customer.') + '</div>';
    }
    function choice(v, t, s, off) {
      return '<label class="choice' + (off ? ' off' : '') + '"><input type="radio" name="decision" value="' + v + '"' + (off ? ' disabled' : '') + '><div><b>' + esc(t) + '</b><span>' + esc(s) + '</span></div></label>';
    }

    function timelineCard(o) {
      var rows = [['Submitted', CA.fmtDate(o.submittedAt, true) + ' by ' + o.submittedBy]];
      if (o.waitingSince) rows.push(['Held for review', CA.fmtDate(o.waitingSince, true)]);
      if (o.resolution) rows.push(['Decided', CA.fmtDate(o.resolution.at, true) + ' by ' + o.resolution.by]);
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
        var note = (o.path === 'held' ? 'Held-order state, from the Record Hold step.' : 'Order state, from the Close Order step.') +
          (o.filledFromRun && o.filledFromRun.length ? ' Some fields came back empty here; the page fills them from earlier in the same run (the hold step and the review task).' : '');
        CA.modal('Workflow output', '<p class="muted small" style="margin-bottom:10px">' + esc(note) + '</p><pre class="json">' + esc(JSON.stringify(o.outputRaw, null, 2)) + '</pre>', '<button class="btn" type="button" data-close>Close</button>');
      });
      Array.prototype.forEach.call(document.querySelectorAll('input[name="decision"]'), function (r) {
        r.addEventListener('change', function () {
          decision = r.value;
          Array.prototype.forEach.call(document.querySelectorAll('.choice'), function (c) { c.classList.toggle('on', c.contains(r)); });
          var more = document.getElementById('c-more'); if (more && r.value === 'reprocess') more.open = true;
        });
      });
      var deskEl = document.getElementById('desk');
      if (deskEl) deskEl.addEventListener('input', function () { var er = document.getElementById('d-err'); if (er) er.hidden = true; });
      if ((el = document.getElementById('record'))) el.addEventListener('click', function () {
        var err = document.getElementById('d-err'); err.hidden = true;
        var pick = document.querySelector('input[name="decision"]:checked');
        if (!pick) { err.textContent = 'Choose one resolution.'; err.hidden = false; return; }
        CA.api('POST', '/api/orders/' + encodeURIComponent(o.id) + '/resolution', { decision: pick.value, note: document.getElementById('note').value })
          .then(function (d) { decision = null; document.getElementById('note').value = ''; render(d.order); CA.toast('Decision recorded.'); })
          .catch(function (e) { err.textContent = e.message; err.hidden = false; });
      });
      if ((el = document.getElementById('send'))) el.addEventListener('click', function () {
        var err = document.getElementById('d-err'); err.hidden = true;
        var pick = document.querySelector('input[name="decision"]:checked');
        if (!pick) { err.textContent = 'Choose one resolution.'; err.hidden = false; return; }
        var btn = this; btn.disabled = true; btn.textContent = 'Sending…';
        var more = document.getElementById('c-more');
        var body = { decision: pick.value, note: document.getElementById('note').value, corrections: more && more.open ? readCorrectionFields() : {} };
        CA.api('POST', '/api/orders/' + encodeURIComponent(o.id) + '/decide', body)
          .then(function (d) { decision = null; render(d.order); CA.toast('Decision sent to the workflow.'); clearTimeout(timer); timer = setTimeout(load, 3000); })
          .catch(function (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.innerHTML = icon('send') + 'Send decision'; });
      });
      if ((el = document.getElementById('reproc'))) el.addEventListener('click', function () { reprocess(o); });
      if ((el = document.getElementById('dropgo'))) el.addEventListener('click', function () {
        var b = this; b.disabled = true;
        CA.api('POST', '/api/orders/' + encodeURIComponent(o.id) + '/resubmit', { dropModem: true })
          .then(function (d) { location.href = '/order.html?id=' + encodeURIComponent(d.order.id); })
          .catch(function (e) { b.disabled = false; CA.toast(e.message, 'bad'); });
      });
      if ((el = document.getElementById('copy-cancel'))) el.addEventListener('click', function () {
        var t = o.cancelNotice.text;
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { CA.toast('Cancellation notice copied.'); })
          .catch(function () { var r = document.createRange(); r.selectNodeContents(document.getElementById('cancel-text')); var s = getSelection(); s.removeAllRanges(); s.addRange(r); CA.toast('Text selected. Press Ctrl+C to copy.'); });
      });
      if ((el = document.getElementById('del'))) el.addEventListener('click', function () {
        var m = CA.modal('Delete this order?', '<p>' + esc(o.orderId) + ' will be removed from the console and from report totals. The run in the workflow is not affected, and its run log is kept.</p>',
          '<button class="btn" type="button" data-close>Keep it</button><button class="btn danger" type="button" id="del-yes">Delete</button>');
        m.el.querySelector('#del-yes').addEventListener('click', function () {
          CA.api('DELETE', '/api/orders/' + encodeURIComponent(o.id)).then(function () { location.href = '/'; }).catch(function (e) { CA.toast(e.message, 'bad'); });
        });
      });
    }

    function reprocess(o) {
      var rec = o.record || {};
      var res = o.result || {};
      var pre = Object.assign({}, o.resolutionCorrections || {});
      var temp = JSON.parse(JSON.stringify(rec));
      if (pre.loc_id) temp.service.loc_id = pre.loc_id;
      if (pre.delivery_address) temp.customer.delivery_address = pre.delivery_address;
      if (pre.modem_sku) temp.modem.sku = pre.modem_sku;
      if (typeof pre.existing_active_service === 'boolean') temp.service.existing_active_service = pre.existing_active_service;
      var faults = (rec.fault_rules || []).map(function (f) { return f.package; }).filter(function (p, i, a) { return a.indexOf(p) === i; });
      var heldPk = res.held_packages || [];
      var m = CA.modal('Send the order again',
        '<p style="margin-bottom:12px">A new run starts with these details. Correct what caused the hold' + (pre && Object.keys(pre).length ? ', and the corrections from the decision are already filled in' : '') + '.</p>' +
        correctionFields(o, temp) +
        (faults.length ? '<div style="margin-top:14px"><h3 class="section-title">Simulated faults in this example</h3>' + faults.map(function (p) {
          return '<label class="check" style="margin-bottom:6px"><input type="checkbox" class="rp-clear" value="' + esc(p) + '"' + (heldPk.indexOf(p) >= 0 ? ' checked' : '') + '> Clear the ' + esc(PKG_LABEL[p].toLowerCase()) + ' fault, as the correction fixes it</label>';
        }).join('') + '</div>' : '') +
        '<p class="hint" style="margin-top:10px">All three packages run again in the new run; packages that completed before get the same references, because references are built from the order number.</p>' +
        (me.user.role === 'admin' ? '<details style="margin-top:12px"><summary class="small" style="cursor:pointer;color:var(--brand-ink)">Edit the full order record instead (admin)</summary><textarea class="code" id="rp-text" spellcheck="false" style="margin-top:8px">' + esc(JSON.stringify(rec, null, 2)) + '</textarea></details>' : '') +
        '<div id="rp-err" class="alert bad" hidden style="margin-top:10px"></div>',
        '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="rp-go">' + icon('refresh') + 'Start new run</button>');
      m.el.querySelector('#rp-go').addEventListener('click', function () {
        var body = { corrections: readCorrectionFields(), clearFaults: Array.prototype.map.call(m.el.querySelectorAll('.rp-clear:checked'), function (c) { return c.value; }) };
        var txt = m.el.querySelector('#rp-text');
        if (txt && txt.closest('details').open && txt.value.trim() !== JSON.stringify(rec, null, 2).trim()) body = { recordText: txt.value };
        CA.api('POST', '/api/orders/' + encodeURIComponent(o.id) + '/resubmit', body)
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
        cd.textContent = left ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'closing, the workflow may time the run out';
      }
      upd(); tick = setInterval(upd, 1000);
    }

    load(true);
  });
})();
