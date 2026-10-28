(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;

  CA.boot({ roles: ['admin'] }).then(function () {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="page-head"><div><h1>Settings</h1><p>How the console is connected and how it behaves.</p></div><a class="btn" href="/system.html">' + icon('gear') + 'Deployment details</a></div><div id="body" class="stack"><div class="card">Loading…</div></div>';

    CA.api('GET', '/api/system').then(function (s) {
      function row(title, ok, text) {
        return '<li>' + icon(ok ? 'checkCircle' : 'alert', 'li-ico ' + (ok ? 'ok' : 'warn')) + '<div class="li-body"><b>' + esc(title) + '</b><span>' + text + '</span></div></li>';
      }
      document.getElementById('body').innerHTML =
        '<section class="card flush"><div class="card-head pad"><div><h2>Connection</h2><p>What the console needs to run orders.</p></div></div><ul class="list">' +
        row('Order workflow', s.opusConnected, s.opusConnected ? 'Connected to <strong>' + esc(s.workflow.name) + '</strong>. Orders run as soon as they are submitted.' : 'Not connected yet. Still needed: ' + esc(s.missing.join(' and ')) + '. IT adds these in the hosting settings and redeploys.') +
        row('Order history', s.storage === 'redis', s.storage === 'redis' ? 'Orders, resolutions, users and run logs are kept in the database.' : 'No database is connected, so orders are kept in memory and disappear when the app restarts. Connect a Redis store in the hosting settings.') +
        row('Sign-in sessions', s.sessionSecretSet, s.sessionSecretSet ? 'Sessions are signed with a fixed secret, so people stay signed in across restarts.' : 'Sessions use a temporary secret, so everyone is signed out whenever the app restarts. IT adds a fixed session secret in the hosting settings to fix this.') +
        row('Fallout Desk decisions', s.webhookSecretSet, s.webhookSecretSet ? 'Review tasks from the workflow arrive here and the desk decides them on the Fallout Desk. Recent calls are under Deployment details.' : 'Not set up yet. Review tasks cannot reach the console until IT adds the webhook secret in the hosting settings and points the review step in the workflow at this console.') +
        '</ul></section>' +
        '<section class="card"><h2 style="margin-bottom:12px">Behaviour</h2><dl class="kv">' +
        '<dt>Sign-in</dt><dd>' + (s.demoSignIn ? 'People pick an account from the list on the sign-in page; added users also sign in with a password.' : 'Email and password only. The built-in accounts are turned off.') + '</dd>' +
        '<dt>Fallout Desk window</dt><dd>' + s.reviewWindowMinutes + ' minutes. This matches the time limit on the Fallout Desk Review step in the workflow; if nobody decides in time, the run times out and the order is held without a decision.</dd>' +
        '<dt>Updates</dt><dd>Running orders refresh every few seconds while their page or the orders list is open.</dd>' +
        '</dl></section>' +
        '<section class="card"><div class="card-head"><div><h2>Clear orders</h2><p>Removes every order from the console and the reports, any review tasks still open, and the list of calls from Opus. Runs in the workflow are not affected; run logs are kept for engineering and hidden.</p></div><button class="btn danger" type="button" id="clear">Clear all orders</button></div></section>';

      document.getElementById('clear').addEventListener('click', function () {
        var m = CA.modal('Clear all orders?', '<p>Every order, decision, open review task and report figure in the console is removed, along with the list of calls from Opus. This cannot be undone.</p>',
          '<button class="btn" type="button" data-close>Keep them</button><button class="btn danger" type="button" id="yes">Clear all orders</button>');
        m.el.querySelector('#yes').addEventListener('click', function () {
          CA.api('POST', '/api/orders-clear').then(function (d) { m.close(); CA.toast(d.removed + ' orders removed.'); }).catch(function (e) { CA.toast(e.message, 'bad'); });
        });
      });
    }).catch(function (e) { document.getElementById('body').innerHTML = '<div class="alert bad">' + esc(e.message) + '</div>'; });
  });
})();
