(function () {
  'use strict';
  var esc = CA.esc;
  var next = new URLSearchParams(location.search).get('next') || '/overview.html';
  if (!/^\/[^/]/.test(next) && next !== '/') next = '/overview.html';

  document.getElementById('brand').innerHTML = CA.MARK.replace('width="30" height="30"', 'width="44" height="44"') +
    '<div><b>Connect &amp; Activate</b><small>Orbit Telecom · Order Operations</small></div>';

  var err = document.getElementById('err');
  function fail(e) { err.textContent = e.message; err.hidden = false; }
  function go() { location.href = next; }

  // Already signed in? Skip the page.
  fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { if (r.ok) go(); });

  CA.api('GET', '/api/accounts').then(function (d) {
    if (!d.demo || !d.accounts.length) return;
    var box = document.getElementById('accounts');
    box.innerHTML = '<p class="small" style="margin-bottom:10px">Choose your account.</p><div class="accounts">' + d.accounts.map(function (a) {
      return '<button class="account" type="button" data-id="' + esc(a.id) + '"><span class="av">' + esc(CA.initials(a.name)) + '</span>' +
        '<span class="who"><b>' + esc(a.name) + '</b><span>' + esc(a.email) + '</span></span><span class="pill plain">' + esc(a.roleLabel) + '</span></button>';
    }).join('') + '</div><div class="divider">or sign in with a password</div>';
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-id]');
      if (!b) return;
      CA.api('POST', '/api/login', { userId: b.getAttribute('data-id') }).then(go).catch(fail);
    });
  }).catch(function () { /* the password form still works */ });

  document.getElementById('pw').addEventListener('submit', function (e) {
    e.preventDefault();
    err.hidden = true;
    var f = e.target;
    CA.api('POST', '/api/login', { email: f.email.value, password: f.password.value }).then(go).catch(fail);
  });
})();
