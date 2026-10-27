(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;

  CA.boot().then(function (me) {
    var app = document.getElementById('app');
    var first = me.user.name.split(' ')[0];
    var h = new Date().getHours();
    var greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    var canSubmit = me.user.role !== 'desk';
    var isDesk = me.user.role !== 'coordinator';

    app.innerHTML =
      '<div class="page-head"><div><p class="eyebrow">' + esc(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) + '</p>' +
      '<h1>' + greet + ', ' + esc(first) + '</h1><p>' + (isDesk ? 'Held orders that need a decision, and how activations are going this month.' : 'Your orders that need attention, and how they are going this month.') + '</p></div>' +
      (canSubmit ? '<a class="btn primary" href="/submit.html">' + icon('upload') + 'New order</a>' : '<a class="btn primary" href="/desk.html">' + icon('desk') + 'Open the Fallout desk</a>') + '</div>' +
      '<div class="kpis" id="kpis"></div>' +
      '<div class="grid-2"><section class="card flush"><div class="card-head pad"><div><h2>Needs attention</h2><p id="att-sub">Checking…</p></div></div><ul class="list" id="att"></ul></section>' +
      '<section class="card flush"><div class="card-head pad"><div><h2>Recent orders</h2><p id="recent-sub"></p></div><a class="btn small" href="/">All orders</a></div><div class="table-wrap"><table class="collapse"><thead><tr><th>Order</th><th>Plan</th><th>Status</th></tr></thead><tbody id="recent"></tbody></table></div></section></div>';

    Promise.all([CA.api('GET', '/api/orders'), CA.api('GET', '/api/report')]).then(function (r) {
      // Counts come from the report, so Overview, Orders and Reports agree. One order = one order number.
      var orders = r[0].orders.filter(function (o) { return o.latest !== false; }), rep = r[1], t = rep.totals;
      document.getElementById('kpis').innerHTML = [
        kpi('/', 'Orders this month', t.submitted, t.inFlight ? t.inFlight + ' still running' : 'none running', ''),
        kpi('/?f=activated', 'Activated', t.activated, t.autoFixed ? t.autoFixed + ' fixed automatically on the way' : (t.submitted ? Math.round(100 * t.activated / t.submitted) + '% of orders' : 'none yet'), 'ok'),
        kpi(isDesk ? '/desk.html' : '/?f=held', 'Held for the Fallout Desk', t.held, t.awaitingDecision ? t.awaitingDecision + ' waiting for a decision' : (t.held ? 'all decided' : 'nothing held'), t.awaitingDecision ? 'warn' : ''),
        kpi('/?f=problem', 'Did not finish', t.failed, t.failed ? 'failed, timed out or a validation gap' : 'none this month', t.failed ? 'bad' : '')
      ].join('');

      var att = [];
      orders.forEach(function (o) {
        if (o.stage === 'with_desk' && !o.resolution) att.push({ o: o, ico: 'pause', cls: 'warn', title: 'Ready for a Fallout Desk decision', text: esc(o.customer) + (o.errorCode ? ' · ' + esc(o.errorCode) : ''), href: '#decide' });
        else if (o.stage === 'held' && !o.resolution) att.push({ o: o, ico: 'alert', cls: 'warn', title: 'Held · no decision recorded', text: (o.errorCode ? esc(o.errorCode) + ' · ' : '') + esc(o.errorText || CA.REASONS[o.escalationReason] || ''), href: '#decide' });
        else if (['failed', 'timed_out'].indexOf(o.stage) >= 0) att.push({ o: o, ico: 'x', cls: 'bad', title: o.stage === 'timed_out' ? 'Run timed out' : 'Run did not finish', text: esc(o.failure || 'Open the order for details') });
        else if (o.stage === 'validation_gap') att.push({ o: o, ico: 'alert', cls: 'bad', title: 'Final checks did not pass', text: esc(o.customer) });
      });
      document.getElementById('att-sub').textContent = att.length ? att.length + ' order' + (att.length > 1 ? 's' : '') + ' to look at.' : 'You are up to date.';
      document.getElementById('att').innerHTML = att.length ? att.slice(0, 7).map(function (a) {
        return '<li>' + icon(a.ico, 'li-ico ' + a.cls) + '<div class="li-body"><b><a href="/order.html?id=' + encodeURIComponent(a.o.id) + (a.href && isDesk ? a.href : '') + '">' + esc(a.o.orderId) + '</a> · ' + a.title + '</b><span>' + a.text + ' · ' + esc(CA.ago(a.o.submittedAt)) + '</span></div></li>';
      }).join('') : '<li>' + icon('checkCircle', 'li-ico ok') + '<div class="li-body"><b>Nothing needs your attention</b><span>Held orders, stalled runs and failed checks show up here.</span></div></li>';

      var recent = orders.slice(0, 6);
      document.getElementById('recent-sub').textContent = orders.length ? 'The latest ' + recent.length + ' of ' + orders.length + '.' : '';
      document.getElementById('recent').innerHTML = recent.length ? recent.map(function (o) {
        return '<tr class="clickable" data-id="' + esc(o.id) + '"><td data-h="Order" class="id-cell"><strong>' + esc(o.orderId) + '</strong><span class="sub">' + esc(o.customer) + ' · ' + esc(CA.ago(o.submittedAt)) + '</span></td>' +
          '<td data-h="Plan">' + esc(o.planName) + '<span class="sub">' + esc(o.techType) + '</span></td><td>' + CA.pill(o) + '</td></tr>';
      }).join('') : '<tr><td colspan="3" class="empty"><strong>No orders yet</strong>' + (canSubmit ? '<a href="/submit.html">Submit the first one</a>.' : 'Orders appear here once coordinators submit them.') + '</td></tr>';
      document.getElementById('recent').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]'); if (tr) location.href = '/order.html?id=' + encodeURIComponent(tr.getAttribute('data-id'));
      });
    }).catch(function (e) { app.insertAdjacentHTML('afterbegin', '<div class="alert bad" style="margin-bottom:16px">' + esc(e.message) + '</div>'); });

    function kpi(href, label, value, sub, cls) {
      return '<a class="kpi ' + cls + '" href="' + href + '"><span class="kpi-label">' + esc(label) + '</span><span class="kpi-value">' + esc(value) + '</span><span class="kpi-sub">' + esc(sub) + '</span></a>';
    }
  });
})();
