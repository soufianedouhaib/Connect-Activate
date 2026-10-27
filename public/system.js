/* Admin-only deployment page. Not linked from the menu (reached from Settings).
   Identifiers arrive already masked from the server. */
(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;

  CA.boot({ roles: ['admin'] }).then(function () {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="page-head"><div><p class="crumb"><a href="/settings.html">Settings</a> / System</p><h1>System</h1><p>Deployment details for IT and support.</p></div></div>' +
      '<div class="stack"><section class="card" id="dep">Loading…</section>' +
      '<section class="card flush" id="webhook"><div class="card-head pad"><div><h2>Fallout Desk webhook</h2><p>Where the workflow\'s off-platform review step sends its tasks, and the last calls it made.</p></div></div><div id="wh" style="padding:0 18px 18px">Loading…</div></section>' +
      '<section class="card flush" id="runlogs"><div class="card-head pad"><div><h2>Run logs</h2><p>An engineering trace per order: submission, the Opus case, every status change, each step the workflow ran, and console actions. Kept for 60 days.</p></div><button class="btn small" type="button" id="rl-refresh">' + icon('refresh') + 'Refresh</button></div>' +
      '<div class="table-wrap"><table class="collapse"><thead><tr><th>Order</th><th>Status</th><th class="num">Events</th><th>Last event</th><th></th></tr></thead><tbody id="rl"></tbody></table></div><p class="small muted" id="rl-more" style="padding:10px 18px" hidden></p></section></div>';

    CA.api('GET', '/api/system').then(function (s) {
      document.getElementById('dep').innerHTML = '<h2 style="margin-bottom:12px">Deployment</h2><dl class="kv">' +
        '<dt>Workflow</dt><dd>' + esc(s.workflow.name) + ' · <span class="code-chip">' + esc(s.workflow.id) + '</span></dd>' +
        '<dt>Opus API</dt><dd>' + (s.apiBase ? '<span class="code-chip">' + esc(s.apiBase) + '</span>' : '<span class="muted">not set</span>') + '</dd>' +
        '<dt>Input</dt><dd><span class="code-chip">' + esc(s.variables.input) + '</span> · order record (JSON text)</dd>' +
        '<dt>Outputs</dt><dd><span class="code-chip">' + esc(s.variables.closedOutput) + '</span> closed orders · <span class="code-chip">' + esc(s.variables.heldOutput) + '</span> held orders</dd>' +
        '<dt>Connection</dt><dd>' + (s.opusConnected ? '<span class="pill ok">Connected</span>' : '<span class="pill warn">Missing: ' + esc(s.missing.join(', ')) + '</span>') + '</dd>' +
        '<dt>Storage</dt><dd>' + (s.storage === 'redis' ? 'Redis' : 'In memory (resets on restart)') + '</dd>' +
        '<dt>Review window</dt><dd>' + s.reviewWindowMinutes + ' minutes, the same as the time limit on the Fallout Desk Review step in the workflow</dd>' +
        '</dl><p class="small muted" style="margin-top:12px">Full identifiers are in the internal deployment notes and in each run log download, not on screen.</p>';
    }).catch(function (e) { document.getElementById('dep').innerHTML = '<div class="alert bad">' + esc(e.message) + '</div>'; });

    CA.api('GET', '/api/webhook-log').then(function (w) {
      var url = location.origin + w.path;
      var rows = w.calls.map(function (c) {
        return '<tr><td class="nowrap">' + esc(CA.shortDate(c.at)) + '</td><td>' + (c.accepted ? '<span class="pill ok">Accepted</span>' : '<span class="pill bad">Refused</span>') + '</td><td>' + esc(c.reason || '') + (c.execution ? '<span class="sub mono">' + esc(c.execution) + '</span>' : '') + '</td></tr>';
      }).join('');
      document.getElementById('wh').innerHTML = '<dl class="kv" style="margin-bottom:14px">' +
        '<dt>Webhook address</dt><dd><span class="code-chip" style="white-space:normal;overflow-wrap:anywhere">' + esc(url) + '/••••••</span>' +
        '<p class="small muted" style="margin-top:4px">The address ends with the webhook secret, which is kept out of this page. The full address is in the internal deployment notes.</p></dd>' +
        '<dt>Secret</dt><dd>' + (w.secretSet ? '<span class="pill ok">Set</span>' : '<span class="pill warn">Not set — calls are refused</span>') + '</dd>' +
        '<dt>Storage</dt><dd>' + (w.storage === 'redis' ? 'Redis' : '<span class="pill warn">In memory</span> tasks can land on a different server instance and be lost; connect Redis') + '</dd></dl>' +
        '<h3 class="section-title">Last calls from Opus</h3>' +
        (rows ? '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Result</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="small muted">No calls since the orders were last cleared.</p>');
    }).catch(function (e) { document.getElementById('wh').innerHTML = '<div class="alert bad">' + esc(e.message) + '</div>'; });

    var showDeleted = false;
    function loadRuns() {
      CA.api('GET', '/api/runlogs').then(function (d) {
        // Logs for cleared orders are kept, but hidden until asked for.
        var hidden = d.runs.filter(function (r) { return r.stage === 'deleted'; }).length;
        var runs = showDeleted ? d.runs : d.runs.filter(function (r) { return r.stage !== 'deleted'; });
        var more = document.getElementById('rl-more');
        more.hidden = !hidden;
        more.innerHTML = hidden ? (showDeleted ? 'Showing ' + hidden + ' log' + (hidden > 1 ? 's' : '') + ' for orders that were cleared. <a href="#" id="rl-toggle">Hide them</a>.' : (hidden > 1 ? hidden + ' logs for cleared orders are' : '1 log for a cleared order is') + ' kept but hidden. <a href="#" id="rl-toggle">Show them</a>.') : '';
        var tg = document.getElementById('rl-toggle'); if (tg) tg.addEventListener('click', function (e) { e.preventDefault(); showDeleted = !showDeleted; loadRuns(); });
        document.getElementById('rl').innerHTML = runs.length ? runs.map(function (r) {
          return '<tr><td data-h="Order"><strong>' + esc(r.orderId || r.id) + '</strong><span class="sub">' + esc(r.id) + '</span></td>' +
            '<td>' + (r.stage === 'deleted' ? '<span class="pill plain">Cleared</span>' : CA.pill({ stage: r.stage })) + '</td>' +
            '<td class="num" data-h="Events">' + r.count + (r.errors ? ' <span class="tag" style="color:var(--bad)">' + r.errors + ' error' + (r.errors > 1 ? 's' : '') + '</span>' : '') + '</td>' +
            '<td data-h="Last">' + esc(r.lastMessage || '') + '<span class="sub">' + esc(CA.fmtDate(r.last, true)) + '</span></td>' +
            '<td class="num"><button class="btn small" type="button" data-run="' + esc(r.id) + '">Open</button></td></tr>';
        }).join('') : '<tr><td colspan="5" class="empty"><strong>No run logs yet</strong>Each submitted order writes one.</td></tr>';
      }).catch(function (e) { document.getElementById('rl').innerHTML = '<tr><td colspan="5"><div class="alert bad">' + esc(e.message) + '</div></td></tr>'; });
    }
    document.getElementById('rl-refresh').addEventListener('click', loadRuns);
    document.getElementById('rl').addEventListener('click', function (e) { var b = e.target.closest('[data-run]'); if (b) openRun(b.getAttribute('data-run')); });

    function openRun(id) {
      CA.api('GET', '/api/runlogs/' + encodeURIComponent(id)).then(function (d) {
        var rows = d.events.map(function (ev) {
          return '<tr><td class="nowrap">' + esc(new Date(ev.at).toLocaleTimeString()) + '<span class="sub">' + esc(CA.fmtDate(ev.at)) + '</span></td><td><span class="tag">' + esc(ev.source) + '</span></td>' +
            '<td>' + (ev.level === 'error' ? '<span class="pill bad">' + esc(ev.message) + '</span>' : esc(ev.message)) + (ev.detail ? '<span class="sub mono">' + esc(JSON.stringify(ev.detail)) + '</span>' : '') + '</td></tr>';
        }).join('');
        var text = d.events.map(function (ev) { return ev.at + '  [' + ev.source + '] ' + ev.level.toUpperCase() + '  ' + ev.message + (ev.detail ? '  ' + JSON.stringify(ev.detail) : ''); }).join('\n');
        var m = CA.modal('Run log · ' + (d.orderId || d.id),
          '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Source</th><th>Event</th></tr></thead><tbody>' + (rows || '<tr><td colspan="3" class="empty">No events.</td></tr>') + '</tbody></table></div>',
          '<button class="btn" type="button" id="rl-copy">Copy as text</button><button class="btn" type="button" id="rl-dl">' + icon('download') + 'Download JSON</button><button class="btn primary" type="button" data-close>Close</button>');
        m.el.querySelector('#rl-copy').addEventListener('click', function () {
          (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { CA.toast('Copied.'); }, function () { CA.toast('Copy is blocked in this browser.', 'warn'); });
        });
        m.el.querySelector('#rl-dl').addEventListener('click', function () {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
          a.download = 'runlog-' + (d.orderId || d.id) + '.json'; a.click();
        });
      }).catch(function (e) { CA.toast(e.message, 'bad'); });
    }

    loadRuns();
    var run = new URLSearchParams(location.search).get('run');
    if (run) { setTimeout(function () { document.getElementById('runlogs').scrollIntoView(); }, 100); openRun(run); }
  });
})();
