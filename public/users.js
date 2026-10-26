(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;

  CA.boot({ roles: ['admin'] }).then(function () {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="page-head"><div><h1>Users</h1><p>Who can use the console and what they can do. Order Coordinators submit orders and see their own; the Fallout Desk works held orders; Admins do everything.</p></div>' +
      '<button class="btn primary" type="button" id="add">' + icon('plus') + 'Add user</button></div>' +
      '<section class="card flush"><div class="table-wrap"><table class="collapse"><thead><tr><th>Name</th><th>Role</th><th>Sign-in</th><th></th></tr></thead><tbody id="rows"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody></table></div></section>';

    var roles = {};
    function load() {
      CA.api('GET', '/api/users').then(function (d) {
        roles = d.roles;
        document.getElementById('rows').innerHTML = d.users.map(function (u) {
          return '<tr><td data-h="Name"><strong>' + esc(u.name) + '</strong><span class="sub">' + esc(u.email) + '</span></td>' +
            '<td data-h="Role"><span class="pill plain">' + esc(u.roleLabel) + '</span></td>' +
            '<td data-h="Sign-in">' + (u.demo ? 'Picked from the list on the sign-in page' : 'Email and password') + (u.createdAt ? '<span class="sub">Added ' + esc(CA.fmtDate(u.createdAt)) + '</span>' : '') + '</td>' +
            '<td class="num">' + (u.demo ? '<span class="muted small">Built in</span>' : '<button class="btn small danger" type="button" data-del="' + esc(u.id) + '" data-name="' + esc(u.name) + '">Remove</button>') + '</td></tr>';
        }).join('');
      }).catch(function (e) { document.getElementById('rows').innerHTML = '<tr><td colspan="4"><div class="alert bad">' + esc(e.message) + '</div></td></tr>'; });
    }

    document.getElementById('rows').addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]'); if (!b) return;
      var m = CA.modal('Remove ' + b.getAttribute('data-name') + '?', '<p>They will not be able to sign in. Orders they submitted stay in the console.</p>',
        '<button class="btn" type="button" data-close>Keep</button><button class="btn danger" type="button" id="yes">Remove</button>');
      m.el.querySelector('#yes').addEventListener('click', function () {
        CA.api('DELETE', '/api/users/' + encodeURIComponent(b.getAttribute('data-del'))).then(function () { m.close(); load(); CA.toast('User removed.'); }).catch(function (er) { CA.toast(er.message, 'bad'); });
      });
    });

    document.getElementById('add').addEventListener('click', function () {
      var opts = Object.keys(roles).map(function (k) { return '<option value="' + k + '">' + esc(roles[k]) + '</option>'; }).join('');
      var m = CA.modal('Add user',
        '<form id="uf" class="stack"><label class="field"><span>Name</span><input type="text" name="name" required></label>' +
        '<label class="field"><span>Work email</span><input type="email" name="email" required></label>' +
        '<label class="field"><span>Role</span><select name="role">' + opts + '</select></label>' +
        '<label class="field"><span>Temporary password</span><input type="password" name="password" minlength="10" autocomplete="new-password" required></label>' +
        '<p class="hint">At least 10 characters. Share it with the person directly; they sign in with their email and this password.</p>' +
        '<div id="uerr" class="alert bad" hidden></div></form>',
        '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="usave">Add user</button>');
      m.el.querySelector('#usave').addEventListener('click', function () {
        var f = m.el.querySelector('#uf');
        CA.api('POST', '/api/users', { name: f.name.value, email: f.email.value, role: f.role.value, password: f.password.value })
          .then(function () { m.close(); load(); CA.toast('User added.'); })
          .catch(function (er) { var x = m.el.querySelector('#uerr'); x.textContent = er.message; x.hidden = false; });
      });
    });
    load();
  });
})();
