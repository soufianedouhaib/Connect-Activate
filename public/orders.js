(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;

  var FILTERS = [
    { key: 'all', label: 'All', test: function () { return true; } },
    { key: 'running', label: 'Running', test: function (o) { return o.stage === 'running' || o.stage === 'starting'; } },
    { key: 'held', label: 'Held', test: function (o) { return o.stage === 'held' || o.stage === 'with_desk'; } },
    { key: 'activated', label: 'Activated', test: function (o) { return o.stage === 'activated'; } },
    { key: 'problem', label: 'Did not finish', test: function (o) { return ['failed', 'timed_out', 'cancelled', 'validation_gap'].indexOf(o.stage) >= 0; } },
    { key: 'resubmitted', label: 'Reprocessed', test: function (o) { return !!o.reprocessOf; } }
  ];

  CA.boot().then(function (me) {
    var app = document.getElementById('app');
    var params = new URLSearchParams(location.search);
    var state = { f: params.get('f') || 'all', q: '', orders: [] };
    var mine = me.user.role === 'coordinator';

    app.innerHTML =
      '<div class="page-head"><div><h1>Orders</h1><p>' + (mine ? 'Every order you have submitted, from submission to activation or hold.' : 'Every broadband connection order sent through the workflow, from submission to activation or hold.') + '</p></div>' +
      '<div class="toolbar"><a class="btn" href="/api/export.csv">' + icon('download') + 'Export CSV</a>' +
      (me.user.role !== 'desk' ? '<a class="btn primary" href="/submit.html">' + icon('upload') + 'New order</a>' : '') + '</div></div>' +
      '<div class="stats" id="stats" role="tablist" aria-label="Filter orders"></div>' +
      '<section class="card flush"><div class="card-head pad"><div class="toolbar" style="width:100%"><input type="search" id="q" placeholder="Search order number, customer, plan or error code" aria-label="Search orders"><span class="spacer"></span><span class="muted small" id="count"></span></div></div>' +
      '<div class="table-wrap"><table class="collapse"><thead><tr><th>Order</th><th>Customer</th><th>Plan</th><th>Status</th><th>Outcome</th><th>Submitted by</th></tr></thead><tbody id="rows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div></section>';

    document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value.trim().toLowerCase(); render(); });
    document.getElementById('stats').addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]'); if (!b) return;
      state.f = b.getAttribute('data-f');
      history.replaceState(null, '', state.f === 'all' ? '/' : '/?f=' + state.f);
      render();
    });
    document.getElementById('rows').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('a')) location.href = '/order.html?id=' + encodeURIComponent(tr.getAttribute('data-id'));
    });

    function render() {
      document.getElementById('stats').innerHTML = FILTERS.map(function (f) {
        var n = state.orders.filter(f.test).length;
        return '<button class="stat' + (state.f === f.key ? ' active' : '') + '" type="button" role="tab" aria-selected="' + (state.f === f.key) + '" data-f="' + f.key + '"><span class="label">' + esc(f.label) + '</span><span class="value">' + n + '</span></button>';
      }).join('');
      var flt = FILTERS.find(function (f) { return f.key === state.f; }) || FILTERS[0];
      var list = state.orders.filter(flt.test).filter(function (o) {
        if (!state.q) return true;
        return [o.orderId, o.customer, o.customerId, o.planName, o.errorCode, o.activationReference, o.submittedBy].join(' ').toLowerCase().indexOf(state.q) >= 0;
      });
      document.getElementById('count').textContent = list.length + ' of ' + state.orders.length;
      document.getElementById('rows').innerHTML = list.length ? list.map(function (o) {
        var tags = (o.reprocessOf ? ' <span class="tag">Reprocessed</span>' : '') + (o.duplicateOf ? ' <span class="tag">Repeat</span>' : '');
        return '<tr class="clickable" data-id="' + esc(o.id) + '">' +
          '<td data-h="Order" class="id-cell"><a href="/order.html?id=' + encodeURIComponent(o.id) + '"><strong>' + esc(o.orderId) + '</strong></a>' + tags + '<span class="sub">' + esc(CA.shortDate(o.submittedAt)) + '</span></td>' +
          '<td data-h="Customer"><span class="nm">' + esc(o.customer) + '</span>' + '<span class="sub">' + esc(o.customerId) + '</span></td>' +
          '<td data-h="Plan">' + esc(o.planName) + '<span class="sub">' + esc(o.techType) + (o.includeModem ? ' · modem' : ' · own modem') + '</span></td>' +
          '<td>' + CA.pill(o) + '</td>' +
          '<td data-h="Outcome">' + CA.outcomeLine(o) + (o.reviewQueue ? '<span class="sub">' + esc(CA.QUEUES[o.reviewQueue] || o.reviewQueue) + '</span>' : '') + '</td>' +
          '<td data-h="By">' + esc(o.submittedBy) + '<span class="sub">' + esc(CA.ago(o.submittedAt)) + '</span></td></tr>';
      }).join('') : '<tr><td colspan="6" class="empty"><strong>' + (state.orders.length ? 'No orders match' : 'No orders yet') + '</strong>' + (state.orders.length ? 'Try another filter or search.' : 'Submitted orders appear here and update on their own while they run.') + '</td></tr>';
    }

    var timer = null;
    function load() {
      CA.api('GET', '/api/orders').then(function (d) {
        state.orders = d.orders; render();
        var active = d.orders.some(function (o) { return ['starting', 'running', 'with_desk'].indexOf(o.stage) >= 0; });
        clearTimeout(timer);
        if (active) timer = setTimeout(load, 5000);
      }).catch(function (e) { document.getElementById('rows').innerHTML = '<tr><td colspan="6"><div class="alert bad">' + esc(e.message) + '</div></td></tr>'; });
    }
    load();
  });
})();
