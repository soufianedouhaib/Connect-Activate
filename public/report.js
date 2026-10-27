(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;
  var SERIES = [
    { key: 'activated', label: 'Activated', color: 'var(--series-a)' },
    { key: 'held', label: 'Held', color: 'var(--series-b)' },
    { key: 'other', label: 'Cancelled, running or did not finish', color: 'var(--series-c)' }
  ];

  CA.boot().then(function (me) {
    var app = document.getElementById('app');
    var month = new URLSearchParams(location.search).get('month') || '';
    app.innerHTML = '<div class="page-head"><div><h1>Reports</h1><p id="scope"></p></div><div class="toolbar"><select id="month" aria-label="Month"></select><a class="btn" href="/api/export.csv">' + icon('download') + 'Export CSV</a></div></div><div id="body" class="stack"><div class="card">Loading…</div></div>';
    document.getElementById('month').addEventListener('change', function (e) {
      month = e.target.value; history.replaceState(null, '', '/report.html?month=' + month); load();
    });

    function load() {
      CA.api('GET', '/api/report' + (month ? '?month=' + month : '')).then(render).catch(function (e) {
        document.getElementById('body').innerHTML = '<div class="alert bad">' + esc(e.message) + '</div>';
      });
    }

    function monthName(m) { var p = m.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }); }

    function render(r) {
      month = r.month;
      document.getElementById('month').innerHTML = r.months.map(function (m) { return '<option value="' + m + '"' + (m === r.month ? ' selected' : '') + '>' + esc(monthName(m)) + '</option>'; }).join('');
      document.getElementById('scope').textContent = (r.scope === 'mine' ? 'Your orders' : 'All orders') + ' in ' + monthName(r.month) + '. Each order counts once, by its newest run, so an order sent again is not counted twice.';
      var t = r.totals;
      var other = t.submitted - t.activated - t.held;
      var body = document.getElementById('body');
      if (!t.submitted) {
        body.innerHTML = '<div class="card empty"><strong>No orders in ' + esc(monthName(r.month)) + '</strong>Reports fill in as orders are submitted and finish.</div>';
        return;
      }
      var pct = function (n, d) { return d ? Math.round(100 * n / d) + '%' : '—'; };
      body.innerHTML =
        '<div class="kpis" style="margin-bottom:0">' +
        kpi('Orders submitted', t.submitted, [t.inFlight ? t.inFlight + ' running' : '', t.failed ? t.failed + ' did not finish' : ''].filter(Boolean).join(' · ') || 'all reached an outcome', '') +
        kpi('Activated', pct(t.activated, t.submitted), t.activated + ' of ' + t.submitted + ' submitted', 'ok') +
        kpi('Held now', t.held, (t.heldAtSomePoint ? t.heldAtSomePoint + ' held at some point this month' : 'none held') + (t.awaitingDecision ? ' · ' + t.awaitingDecision + ' waiting' : ''), t.held ? 'warn' : '') +
        kpi('Attempts before a hold', t.heldAtSomePoint ? t.avgAttemptsHeld : '—', t.heldAtSomePoint ? 'average over the ' + t.heldAtSomePoint + ' held this month' : 'nothing held this month', '') + '</div>' +

        '<section class="card"><div class="card-head"><div><h2>Outcomes</h2><p>Where this month\'s orders ended up.</p></div></div>' +
        legend() +
        '<div class="split" role="img" aria-label="' + esc(SERIES.map(function (s, i) { return s.label + ' ' + [t.activated, t.held, other][i]; }).join(', ')) + '">' +
        [t.activated, t.held, other].map(function (n, i) { return n ? '<span style="flex:' + n + ';background:' + SERIES[i].color + '" title="' + esc(SERIES[i].label + ': ' + n) + '"></span>' : ''; }).join('') + '</div>' +
        '<p class="small" style="margin-top:8px">' + SERIES.map(function (s, i) { var n = [t.activated, t.held, other][i]; return '<b>' + n + '</b> ' + esc(s.label.toLowerCase()) + ' (' + pct(n, t.submitted) + ')'; }).join(' · ') + '</p>' +
        (t.autoFixed ? '<p class="small" style="margin-top:6px"><b>' + t.autoFixed + '</b> of the ' + t.activated + ' activated order' + (t.activated > 1 ? 's' : '') + ' recovered from a failure automatically, with no person involved.</p>' : '') +
        tableView(['Outcome', 'Orders', 'Share'], [['Activated', t.activated, pct(t.activated, t.submitted)], ['  of which fixed automatically', t.autoFixed, pct(t.autoFixed, t.submitted)], ['Held', t.held, pct(t.held, t.submitted)], ['Cancelled at the Fallout Desk', t.cancelled, pct(t.cancelled, t.submitted)], ['Running', t.inFlight, pct(t.inFlight, t.submitted)], ['Did not finish', t.failed, pct(t.failed, t.submitted)]]) + '</section>' +

        '<section class="card"><div class="card-head"><div><h2>By day</h2><p>Orders submitted each day, by outcome. Hover a column for the figures.</p></div></div>' + legend() + daily(r.daily) +
        tableView(['Day', 'Activated', 'Held', 'Other'], r.daily.filter(function (d) { return d.activated + d.held + d.other; }).map(function (d) { return [CA.fmtDate(d.day), d.activated, d.held, d.other]; })) + '</section>' +

        '<p class="small muted" style="margin:4px 2px 0">The next four charts cover every order held at some point this month (' + t.heldAtSomePoint + '), including orders sent again since.</p>' +
        '<div class="grid-2">' +
                barsCard('Why orders were held', 'Error code on the first escalated package.', r.byErrorCode.map(function (x) { return { label: x.key, sub: x.text, n: x.count }; }), true, ['Error', 'Description', 'Held']) +
        barsCard('Review queue', 'Which team the hold was routed to.', r.byQueue.map(function (x) { return { label: CA.QUEUES[x.key] || x.key, n: x.count }; }), true, ['Queue', 'Held']) +
        barsCard('Escalation reason', 'Ran out of retries, or no safe automatic fix.', r.byReason.map(function (x) { return { label: CA.REASONS[x.key] || x.key, n: x.count }; }), true, ['Reason', 'Held']) +
        barsCard('Fallout Desk decisions', 'One per held order.', r.byResolution.map(function (x) { return { label: CA.DECISIONS[x.key] || x.key, n: x.count }; }), true, ['Resolution', 'Held']) +
        '</div>' +
        barsCard('Activated orders by plan', 'Adds up to the ' + t.activated + ' activated above.', r.byPlan.map(function (x) { return { label: x.key, n: x.count }; }), false, ['Plan', 'Orders']);
    }

    function kpi(label, value, sub, cls) {
      return '<div class="kpi ' + cls + '"><span class="kpi-label">' + esc(label) + '</span><span class="kpi-value">' + esc(value) + '</span><span class="kpi-sub">' + esc(sub) + '</span></div>';
    }
    function legend() {
      return '<div class="legend">' + SERIES.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.label) + '</span>'; }).join('') + '</div>';
    }
    function daily(days) {
      var max = Math.max.apply(null, days.map(function (d) { return d.activated + d.held + d.other; }).concat([1]));
      return '<div class="cols">' + days.map(function (d) {
        var tip = CA.fmtDate(d.day) + ' — activated ' + d.activated + ', held ' + d.held + ', other ' + d.other;
        return '<div class="col" title="' + esc(tip) + '" aria-label="' + esc(tip) + '" role="img">' +
          ['activated', 'held', 'other'].map(function (k, i) { return d[k] ? '<span style="height:' + (100 * d[k] / max) + '%;background:' + SERIES[i].color + '"></span>' : ''; }).join('') + '</div>';
      }).join('') + '</div><div class="col-labels">' + days.map(function (d, i) {
        var n = +d.day.slice(8);
        var lastOne = i === days.length - 1 && n % 5 > 1;
        return '<span>' + (n === 1 || n % 5 === 0 || lastOne ? n : '') + '</span>';
      }).join('') + '</div>';
    }
    function barsCard(title, sub, rows, held, heads) {
      var max = Math.max.apply(null, rows.map(function (x) { return x.n; }).concat([1]));
      var inner = rows.length ? '<div class="bars">' + rows.map(function (x) {
        return '<div class="bar-row" title="' + esc(x.label + (x.sub ? ' — ' + x.sub : '') + ': ' + x.n) + '"><span class="b-label">' + esc(x.label) + (x.sub ? '<small>' + esc(x.sub) + '</small>' : '') + '</span>' +
          '<span class="b-track"><span class="b-fill' + (held ? ' held' : '') + '" style="width:' + (100 * x.n / max) + '%;display:block"></span></span><span class="b-num">' + x.n + '</span></div>';
      }).join('') + '</div>' + tableView(heads, rows.map(function (x) { return x.sub !== undefined ? [x.label, x.sub, x.n] : [x.label, x.n]; })) : '<p class="muted small">Nothing to show for this month.</p>';
      return '<section class="card"><div class="card-head"><div><h2>' + esc(title) + '</h2>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div></div>' + inner + '</section>';
    }
    function tableView(heads, rows) {
      return '<details class="table-view"><summary>Show as a table</summary><div class="table-wrap"><table><thead><tr>' + heads.map(function (h, i) { return '<th' + (i ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i && typeof c === 'number' ? ' class="num"' : '') + '>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div></details>';
    }

    load();
  });
})();
