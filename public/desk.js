(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;
  var PKG = { BILLING: 'Billing', LOGISTICS: 'Logistics', PROVISIONING: 'Provisioning' };

  CA.boot({ roles: ['desk', 'admin'] }).then(function (me) {
    var app = document.getElementById('app');
    var state = { queue: 'all', orders: [] };
    app.innerHTML =
      '<div class="page-head"><div><h1>Fallout desk</h1><p>Orders the workflow could not complete on its own. Decide each one in the Opus review step — reprocess, cancel the package or cancel the order — and record the resolution here.</p></div>' +
      '<a class="btn" href="' + esc(me.opusReviewUrl) + '" target="_blank" rel="noopener">' + icon('external') + 'Open Opus reviews</a></div>' +
      '<div class="kpis" id="kpis"></div>' +
      '<section class="card flush" style="margin-bottom:16px"><div class="card-head pad"><div><h2>Waiting for a decision</h2><p id="w-sub"></p></div>' +
      '<div class="seg-choice" role="group" aria-label="Queue" id="queues"></div></div>' +
      '<div class="table-wrap"><table class="collapse"><thead><tr><th>Order</th><th>Held package</th><th>Error</th><th>Why</th><th class="num">Attempts</th><th>Status</th></tr></thead><tbody id="open"></tbody></table></div></section>' +
      '<section class="card flush"><div class="card-head pad"><div><h2>Recently resolved</h2><p>Resolutions recorded in the console.</p></div></div>' +
      '<div class="table-wrap"><table class="collapse"><thead><tr><th>Order</th><th>Error</th><th>Resolution</th><th>Note</th><th>By</th></tr></thead><tbody id="done"></tbody></table></div></section>';

    document.getElementById('queues').addEventListener('click', function (e) {
      var b = e.target.closest('[data-q]'); if (!b) return; state.queue = b.getAttribute('data-q'); render();
    });
    ['open', 'done'].forEach(function (t) {
      document.getElementById(t).addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('a')) location.href = '/order.html?id=' + encodeURIComponent(tr.getAttribute('data-id'));
      });
    });

    function render() {
      var held = state.orders.filter(function (o) { return o.stage === 'with_desk' || o.stage === 'held'; });
      var open = held.filter(function (o) { return !o.resolution; });
      var done = held.filter(function (o) { return o.resolution; }).sort(function (a, b) { return (b.resolution.at || '').localeCompare(a.resolution.at || ''); });
      var inReview = open.filter(function (o) { return o.stage === 'with_desk'; }).length;
      var month = new Date().toISOString().slice(0, 7);
      var doneMonth = done.filter(function (o) { return (o.resolution.at || '').slice(0, 7) === month; }).length;
      var codes = {};
      open.forEach(function (o) { if (o.errorCode) codes[o.errorCode] = (codes[o.errorCode] || 0) + 1; });
      var ranked = Object.keys(codes).sort(function (a, b) { return codes[b] - codes[a]; });
      var top = ranked.length && (ranked.length === 1 || codes[ranked[0]] > codes[ranked[1]]) ? ranked[0] : null;
      var tied = !top && ranked.length > 1;
      document.getElementById('kpis').innerHTML =
        kpi('In review now', inReview, inReview ? 'review step open in Opus' : 'none open', inReview ? 'warn' : '') +
        kpi('Waiting for a resolution', open.length, open.length ? 'held orders' : 'queue is clear', open.length ? 'warn' : 'ok') +
        kpi('Resolved this month', doneMonth, 'recorded here', '') +
        kpi('Most common error', top || (tied ? 'No single one' : '—'), top ? codes[top] + ' open · ' + (findText(top) || '') : tied ? ranked.length + ' codes, ' + codes[ranked[0]] + ' open each' : 'nothing open', '');

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
          '<td data-h="Package">' + (waiting ? '<span class="muted">Shown after review</span>' : esc((o.heldPackages || []).map(function (p) { return PKG[p] || p; }).join(', ') || '—')) + '<span class="sub">' + esc(CA.QUEUES[o.reviewQueue] || '') + '</span></td>' +
          '<td data-h="Error">' + (o.errorCode ? '<span class="code-chip">' + esc(o.errorCode) + '</span><span class="sub">' + esc(o.errorText) + '</span>' : '—') + '</td>' +
          '<td data-h="Why">' + esc(CA.REASONS[o.escalationReason] || (waiting ? '—' : CA.words(o.escalationReason) || '—')) + '</td>' +
          '<td class="num" data-h="Attempts">' + (o.stage === 'held' ? esc(String(attempts(o))) : '—') + '</td>' +
          '<td>' + CA.pill(o) + '<span class="sub">held ' + esc(CA.ago(o.waitingSince || o.finishedAt || o.submittedAt)) + '</span></td></tr>';
      }).join('') : '<tr><td colspan="6" class="empty"><strong>Nothing waiting</strong>Held orders appear here as soon as the workflow escalates them.</td></tr>';

      document.getElementById('done').innerHTML = done.length ? done.slice(0, 15).map(function (o) {
        return '<tr class="clickable" data-id="' + esc(o.id) + '"><td data-h="Order" class="id-cell"><a href="/order.html?id=' + encodeURIComponent(o.id) + '"><strong>' + esc(o.orderId) + '</strong></a><span class="sub">' + esc(o.customer) + '</span></td>' +
          '<td data-h="Error">' + (o.errorCode ? '<span class="code-chip">' + esc(o.errorCode) + '</span>' : '—') + '</td>' +
          '<td data-h="Resolution"><strong>' + esc(o.resolution.label) + '</strong></td>' +
          '<td data-h="Note">' + esc(o.resolution.note.length > 90 ? o.resolution.note.slice(0, 88) + '…' : o.resolution.note) + '</td>' +
          '<td data-h="By"><span class="nm">' + esc(o.resolution.by) + '</span>' + '<span class="sub">' + esc(CA.ago(o.resolution.at)) + '</span></td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty"><strong>No resolutions yet</strong>Record a resolution on a held order and it is listed here.</td></tr>';
    }
    function attempts(o) { return o.attemptsMade == null ? '—' : o.attemptsMade; }
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
      }).catch(function (e) { document.getElementById('open').innerHTML = '<tr><td colspan="6"><div class="alert bad">' + esc(e.message) + '</div></td></tr>'; });
    }
    load();
  });
})();
