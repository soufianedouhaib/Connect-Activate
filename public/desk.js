(function () {
  'use strict';
  var esc = CA.esc;
  var PKG = { BILLING: 'Billing', LOGISTICS: 'Logistics', PROVISIONING: 'Provisioning' };

  CA.boot({ roles: ['desk', 'admin'] }).then(function (me) {
    var app = document.getElementById('app');
    var state = { queue: 'all', orders: [] };
    app.innerHTML =
      '<div class="page-head"><div><h1>Fallout desk</h1><p>Orders the workflow could not complete on its own. Open each one and decide it here: reprocess, cancel the package or cancel the order. The decision goes straight back to the workflow.</p></div></div>' +
      '<div class="kpis" id="kpis"></div>' +
      '<section class="card flush" style="margin-bottom:16px"><div class="card-head pad"><div><h2>Waiting for a decision</h2><p id="w-sub"></p></div>' +
      '<div class="seg-choice" role="group" aria-label="Queue" id="queues"></div></div>' +
      '<div class="table-wrap"><table class="collapse"><thead><tr><th>Order</th><th>Held package</th><th>Error</th><th>Why</th><th class="num">Attempts</th><th>Status</th><th><span class="sr-only">Action</span></th></tr></thead><tbody id="open"></tbody></table></div></section>' +
      '<section class="card flush"><div class="card-head pad"><div><h2>Recently decided</h2><p>Decisions made on this desk.</p></div></div>' +
      '<div class="table-wrap"><table class="collapse"><thead><tr><th>Order</th><th>Error</th><th>Decision</th><th>Note</th><th>By</th></tr></thead><tbody id="done"></tbody></table></div></section>';

    document.getElementById('queues').addEventListener('click', function (e) {
      var b = e.target.closest('[data-q]'); if (!b) return; state.queue = b.getAttribute('data-q'); render();
    });
    ['open', 'done'].forEach(function (t) {
      document.getElementById(t).addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('a')) location.href = '/order.html?id=' + encodeURIComponent(tr.getAttribute('data-id'));
      });
    });

    function render() {
      // One row per order: its newest run.
      var held = state.orders.filter(function (o) { return o.latest !== false && o.category === 'held'; });
      var open = held.filter(function (o) { return !o.resolution; });
      // Every decision stays in the history, including runs that were sent again since.
      var done = state.orders.filter(function (o) { return o.resolution; }).sort(function (a, b) { return (b.resolution.at || '').localeCompare(a.resolution.at || ''); });
      var inReview = open.filter(function (o) { return o.stage === 'with_desk'; }).length;
      var month = new Date().toISOString().slice(0, 7);
      var doneMonth = done.filter(function (o) { return (o.resolution.at || '').slice(0, 7) === month; }).length;
      var codes = {};
      open.forEach(function (o) { if (o.errorCode) codes[o.errorCode] = (codes[o.errorCode] || 0) + 1; });
      var ranked = Object.keys(codes).sort(function (a, b) { return codes[b] - codes[a]; });
      var top = ranked.length && (ranked.length === 1 || codes[ranked[0]] > codes[ranked[1]]) ? ranked[0] : null;
      var tied = !top && ranked.length > 1;
      document.getElementById('kpis').innerHTML =
        kpi('Ready to decide now', inReview, inReview ? 'the workflow is waiting' : 'none waiting', inReview ? 'warn' : '') +
        kpi('Waiting for a decision', open.length, open.length ? 'held orders' : 'queue is clear', open.length ? 'warn' : 'ok') +
        kpi('Decided this month', doneMonth, 'on this desk', '') +
        kpi('Most common error', top || (tied ? 'No single one' : 'None'), top ? codes[top] + ' open · ' + (findText(top) || '') : tied ? ranked.length + ' codes, ' + codes[ranked[0]] + ' open each' : 'nothing open', '');

      var queues = ['all'].concat(Object.keys(CA.QUEUES));
      document.getElementById('queues').innerHTML = queues.map(function (q) {
        var n = q === 'all' ? open.length : open.filter(function (o) { return o.reviewQueue === q; }).length;
        return '<button type="button" data-q="' + q + '" aria-pressed="' + (state.queue === q) + '">' + (q === 'all' ? 'All' : esc(CA.QUEUES[q])) + ' · ' + n + '</button>';
      }).join('');

      var list = open.filter(function (o) { return state.queue === 'all' || o.reviewQueue === state.queue; });
      document.getElementById('w-sub').textContent = list.length ? 'Oldest first.' : '';
      list.sort(function (a, b) { return (a.submittedAt || '').localeCompare(b.submittedAt || ''); });
      document.getElementById('open').innerHTML = list.length ? list.map(function (o) {
        var waiting = o.stage === 'with_desk';
        return '<tr class="clickable" data-id="' + esc(o.id) + '"><td data-h="Order" class="id-cell"><a href="/order.html?id=' + encodeURIComponent(o.id) + '"><strong>' + esc(o.orderId) + '</strong></a><span class="sub">' + esc(o.customer) + ' · ' + esc(o.planName) + '</span></td>' +
          '<td data-h="Package">' + (waiting && !(o.heldPackages || []).length ? '<span class="muted">Not reported yet</span>' : esc((o.heldPackages || []).map(function (p) { return PKG[p] || p; }).join(', ') || 'Not reported')) + '<span class="sub">' + esc(CA.QUEUES[o.reviewQueue] || '') + '</span></td>' +
          '<td data-h="Error">' + (o.errorCode ? '<span class="code-chip">' + esc(o.errorCode) + '</span><span class="sub">' + esc(o.errorText) + '</span>' : 'Not reported') + '</td>' +
          '<td data-h="Why">' + esc(CA.REASONS[o.escalationReason] || (waiting ? 'Not reported' : CA.words(o.escalationReason) || 'Not reported')) + '</td>' +
          '<td class="num" data-h="Attempts">' + esc(String(attempts(o))) + '</td>' +
          '<td>' + (o.reviewOpen ? '<span class="pill info">Ready to decide</span>' : CA.pill(o)) + '<span class="sub">held ' + esc(CA.ago(o.waitingSince || o.finishedAt || o.submittedAt)) + '</span></td>' +
          '<td class="num"><a class="btn small' + (o.reviewOpen ? ' primary' : '') + '" href="/order.html?id=' + encodeURIComponent(o.id) + '#decide">' + (o.reviewOpen || o.stage === 'held' ? 'Decide' : 'Open') + '</a></td></tr>';
      }).join('') : '<tr><td colspan="7" class="empty"><strong>Nothing waiting</strong>Held orders appear here as soon as the workflow escalates them.</td></tr>';

      document.getElementById('done').innerHTML = done.length ? done.slice(0, 15).map(function (o) {
        return '<tr class="clickable" data-id="' + esc(o.id) + '"><td data-h="Order" class="id-cell"><a href="/order.html?id=' + encodeURIComponent(o.id) + '"><strong>' + esc(o.orderId) + '</strong></a><span class="sub">' + esc(o.customer) + '</span></td>' +
          '<td data-h="Error">' + (o.errorCode ? '<span class="code-chip">' + esc(o.errorCode) + '</span>' : 'None') + '</td>' +
          '<td data-h="Resolution"><strong>' + esc(o.resolution.label) + '</strong></td>' +
          '<td data-h="Note">' + esc(o.resolution.note.length > 90 ? o.resolution.note.slice(0, 88) + '…' : o.resolution.note) + '</td>' +
          '<td data-h="By"><span class="nm">' + esc(o.resolution.by) + '</span>' + '<span class="sub">' + esc(CA.ago(o.resolution.at)) + '</span></td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty"><strong>No decisions yet</strong>Decide a held order and it is listed here.</td></tr>';
    }
    function attempts(o) { return o.attemptsMade == null || !o.attemptsMade ? 'Not reported' : o.attemptsMade; }
    function findText(code) { var o = state.orders.find(function (x) { return x.errorCode === code; }); return o ? o.errorText : ''; }
    function kpi(label, value, sub, cls) {
      return '<div class="kpi ' + cls + '"><span class="kpi-label">' + esc(label) + '</span><span class="kpi-value">' + esc(value) + '</span><span class="kpi-sub">' + esc(sub) + '</span></div>';
    }

    var timer = null;
    function load() {
      CA.api('GET', '/api/orders').then(function (d) {
        state.orders = d.orders;
        render();
        clearTimeout(timer);
        if (d.orders.some(function (o) { return ['starting', 'running', 'with_desk'].indexOf(o.stage) >= 0; })) timer = setTimeout(load, 6000);
      }).catch(function (e) { document.getElementById('open').innerHTML = '<tr><td colspan="7"><div class="alert bad">' + esc(e.message) + '</div></td></tr>'; });
    }
    load();
  });
})();
