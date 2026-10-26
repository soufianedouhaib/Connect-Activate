/* Shared chrome and helpers. Every page calls CA.boot(...) first; nothing renders
   until /api/me answers, so a signed-out visitor never sees a screen they lose. */
(function () {
  'use strict';

  var ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    desk: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5.5 5h13L20 13v6H4v-6z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-6 6.5-6s5.9 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .7 3.3 2.9 3.5 6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.5" r=".6"/>',
    out: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
    chevron: '<path d="M15 6l-6 6 6 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6"/>',
    x: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.7-4.4L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14.7 4.4L20 16"/><path d="M20 20v-4h-4"/>',
    split: '<path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6"/><path d="M6 21v-6"/><circle cx="6" cy="3" r="1"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
    signal: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>',
    send: '<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
    file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5"/>'
  };
  function icon(name, cls) {
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  var MARK = '<svg class="product-mark" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--brand)"/><circle cx="16" cy="16" r="7.2" fill="none" stroke="var(--on-brand)" stroke-width="2.4"/><circle cx="23.6" cy="9.4" r="2.6" fill="var(--on-brand)"/><path d="M13.2 16.2l2 2 3.8-4.2" fill="none" stroke="var(--on-brand)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  // Read as text first, then parse: a platform error page is HTML, not JSON.
  function api(method, url, body) {
    var opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : {}; } catch (e) { data = null; }
        if (r.status === 401 && !/\/api\/login$/.test(url)) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Please sign in.'); }
        if (!r.ok) {
          var msg = data && data.error ? data.error : 'The server answered ' + r.status + (data ? '' : ' (not JSON — the deployment may be missing the API files).');
          var err = new Error(msg); err.status = r.status; err.data = data; throw err;
        }
        if (data === null) throw new Error('The server answered with something that is not JSON.');
        return data;
      });
    });
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '—';
    var d = new Date(iso);
    var opts = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return d.toLocaleString(undefined, opts);
  }
  function ago(iso) {
    if (!iso) return '';
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function shortDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    var sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString(undefined, sameYear ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function channel(c) { c = String(c || 'SMS').toUpperCase(); return c === 'EMAIL' ? 'Email' : c === 'SMS' ? 'SMS' : words(c); }
  // Let long emails break only after the @, never in the middle of a word.
  function email(s) { return esc(s).replace('@', '@<wbr>'); }
  function money(cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); }
  function words(code) { return String(code || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }); }

  var REASONS = {
    RETRY_LIMIT: 'Retry limit reached',
    NO_SAFE_FIX: 'No safe automatic fix'
  };
  var QUEUES = {
    DISPATCH_SUPPORT: 'Dispatch Support',
    BILLING_OPS: 'Billing Ops',
    NETWORK_COORDINATION: 'Network Coordination'
  };
  var DECISIONS = {
    reprocess: 'Reprocess',
    cancel_package: 'Cancel package',
    cancel_order: 'Cancel order',
    awaiting: 'Awaiting decision'
  };

  /* One status pill for every list and the detail page, so screens agree. */
  function pill(row) {
    switch (row.stage) {
      case 'starting':
      case 'running': return '<span class="pill info live">Running</span>';
      case 'with_desk': return '<span class="pill warn live">With Fallout Desk</span>';
      case 'activated': return '<span class="pill ok">Activated</span>';
      case 'validation_gap': return '<span class="pill bad">Validation gap</span>';
      case 'held':
        if (row.resolution) {
          var d = row.resolution.decision;
          if (d === 'cancel_order') return '<span class="pill plain">Order cancelled</span>';
          if (d === 'reprocess' && row.reprocessedAs) return '<span class="pill info">Reprocessed</span>';
          if (d === 'cancel_package') return '<span class="pill warn">Held · package cancelled</span>';
          return '<span class="pill warn">Held · to reprocess</span>';
        }
        return '<span class="pill warn">Held</span>';
      case 'timed_out': return '<span class="pill bad">Timed out</span>';
      case 'cancelled': return '<span class="pill plain">Cancelled</span>';
      default: return '<span class="pill bad">Run failed</span>';
    }
  }
  function outcomeLine(row) {
    if (row.stage === 'activated') return row.activationReference ? 'Activation ' + esc(row.activationReference) : 'Service active';
    if (row.stage === 'held') return (row.errorCode ? '<span class="code-chip">' + esc(row.errorCode) + '</span> ' : '') + esc(row.errorText || REASONS[row.escalationReason] || 'Held for review');
    if (row.stage === 'with_desk') return 'Waiting on a Fallout Desk decision';
    if (row.stage === 'running' || row.stage === 'starting') return 'Packages in progress';
    if (row.stage === 'validation_gap') return 'Final checks did not pass';
    return esc(row.failure || 'See the order for details');
  }

  function navItems(role) {
    var groups = [
      { title: 'Workspace', items: [
        { href: '/overview.html', label: 'Overview', icon: 'home' },
        { href: '/', label: 'Orders', icon: 'list', match: ['/', '/index.html', '/order.html'] },
        { href: '/submit.html', label: 'New order', icon: 'plus', roles: ['coordinator', 'admin'] },
        { href: '/desk.html', label: 'Fallout desk', icon: 'desk', roles: ['desk', 'admin'], badge: true }
      ] },
      { title: 'Insight', items: [{ href: '/report.html', label: 'Reports', icon: 'chart' }] },
      { title: 'Administration', roles: ['admin'], items: [
        { href: '/users.html', label: 'Users', icon: 'users' },
        { href: '/settings.html', label: 'Settings', icon: 'gear' }
      ] }
    ];
    return groups.filter(function (g) { return !g.roles || g.roles.indexOf(role) >= 0; }).map(function (g) {
      return { title: g.title, items: g.items.filter(function (i) { return !i.roles || i.roles.indexOf(role) >= 0; }) };
    });
  }

  function initials(name) { return String(name || '?').split(/\s+/).map(function (p) { return p[0]; }).slice(0, 2).join('').toUpperCase(); }

  function applyTheme() {
    var t = null;
    try { t = localStorage.getItem('ca-theme'); } catch (e) { t = null; }
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var dark = cur ? cur === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ca-theme', next); } catch (e) { /* storage may be blocked */ }
  }
  applyTheme();

  function renderChrome(me) {
    var path = location.pathname;
    var nav = navItems(me.user.role).map(function (g) {
      return '<div class="nav-group"><div class="nav-title">' + esc(g.title) + '</div>' + g.items.map(function (i) {
        var cur = (i.match || [i.href]).indexOf(path) >= 0 ? ' aria-current="page"' : '';
        var badge = i.badge && me.deskCount ? '<span class="badge-count" title="Held orders waiting">' + me.deskCount + '</span>' : '';
        return '<a href="' + i.href + '"' + cur + ' title="' + esc(i.label) + '">' + icon(i.icon) + '<span class="label">' + esc(i.label) + '</span>' + badge + '</a>';
      }).join('') + '</div>';
    }).join('');

    var side = document.createElement('aside');
    side.className = 'sidebar';
    side.innerHTML =
      '<div class="side-head"><a class="brand-lockup" href="/overview.html">' + MARK + '<span class="label">Connect &amp; Activate<small>Orbit Telecom · Order Operations</small></span></a>' +
      '<button class="side-toggle" type="button" aria-label="Collapse menu">' + icon('chevron') + '</button>' +
      '<button class="icon-btn side-close" type="button" aria-label="Close menu">' + icon('close') + '</button></div>' +
      '<nav class="side-nav" aria-label="Main">' + nav + '</nav>' +
      '<div class="side-foot">' +
      '<button class="side-link" type="button" data-act="theme" title="Light or dark">' + icon('moon') + '<span class="label">Light or dark</span></button>' +
      '<button class="side-link" type="button" data-act="help" title="Get help">' + icon('help') + '<span class="label">Get help</span></button>' +
      '<div class="side-account" title="' + esc(me.user.name) + '"><span class="avatar">' + esc(initials(me.user.name)) + '</span><span class="label"><span class="account-name">' + esc(me.user.name) + '</span><span class="account-role">' + esc(me.user.roleLabel) + '</span></span></div>' +
      '<button class="side-out" type="button" data-act="out" title="Sign out">' + icon('out') + '<span class="label">Sign out</span></button>' +
      '</div>';
    document.body.insertBefore(side, document.body.firstChild);

    var scrim = document.createElement('div'); scrim.className = 'side-scrim';
    document.body.insertBefore(scrim, side.nextSibling);
    var top = document.createElement('header'); top.className = 'topbar';
    top.innerHTML = '<button class="icon-btn" type="button" aria-label="Open menu" data-act="open">' + icon('menu') + '</button><a class="topbar-brand" href="/overview.html">' + MARK + '<span>Connect &amp; Activate</span></a>';
    document.body.insertBefore(top, scrim.nextSibling);

    if (!me.opusConnected) {
      var b = document.createElement('div'); b.className = 'setup-banner';
      b.innerHTML = '<div class="inner"><b>Not connected to Opus yet.</b> Orders can be prepared, but they will not run until an admin finishes the connection' + (me.user.role === 'admin' ? ' — see <a href="/settings.html">Settings</a>.' : '.') + '</div>';
      document.body.insertBefore(b, top.nextSibling);
    }

    document.body.classList.add('has-sidebar');
    try { if (localStorage.getItem('ca-side') === 'folded') document.body.classList.add('side-collapsed'); } catch (e) { /* ignore */ }
    side.querySelector('.side-toggle').addEventListener('click', function () {
      document.body.classList.toggle('side-collapsed');
      try { localStorage.setItem('ca-side', document.body.classList.contains('side-collapsed') ? 'folded' : 'open'); } catch (e) { /* ignore */ }
    });
    function closeNav() { document.body.classList.remove('nav-open'); }
    side.querySelector('.side-close').addEventListener('click', closeNav);
    scrim.addEventListener('click', closeNav);
    top.querySelector('[data-act="open"]').addEventListener('click', function () { document.body.classList.add('nav-open'); });
    side.querySelector('[data-act="theme"]').addEventListener('click', toggleTheme);
    side.querySelector('[data-act="help"]').addEventListener('click', function () { helpDialog(me); });
    side.querySelector('[data-act="out"]').addEventListener('click', function () {
      api('POST', '/api/logout').then(function () { location.href = '/login.html'; });
    });

    var foot = document.createElement('footer'); foot.className = 'footer';
    foot.innerHTML = '<span><b>Connect &amp; Activate</b> · Orbit Telecom Order Operations</span><span>Orders run through the order-to-activation workflow; held orders go to the Fallout Desk.</span>';
    document.body.appendChild(foot);
  }

  function modal(title, bodyHtml, footHtml) {
    var back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="modal-head"><h2>' + esc(title) + '</h2><button class="icon-btn" type="button" aria-label="Close" data-close>' + icon('close') + '</button></div><div class="modal-body">' + bodyHtml + '</div>' + (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '') + '</div>';
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    back.addEventListener('click', function (e) { if (e.target === back || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    return { el: back, close: close };
  }

  function helpDialog(me) {
    var subject = encodeURIComponent('Connect & Activate console — help');
    var body = encodeURIComponent('Hello,\n\nI need help with:\n\n\nSigned in as: ' + me.user.name + ' (' + me.user.roleLabel + ')\nPage: ' + location.pathname + location.search + '\nTime: ' + new Date().toISOString());
    modal('Get help',
      '<div class="stack"><p>Write to the Order Operations support team. The email opens with the page you are on and your account filled in, so they can find the order quickly.</p>' +
      '<p class="muted small">For a held order, include the order number shown on the page (for example ORB-2026-000419).</p></div>',
      '<button class="btn" type="button" data-close>Close</button><a class="btn primary" href="mailto:order-ops-support@orbittelecom.example?subject=' + subject + '&body=' + body + '">' + icon('send') + 'Write to support</a>');
  }

  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'alert ' + (kind || 'ok');
    t.setAttribute('role', 'status');
    t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:60;max-width:420px;box-shadow:var(--shadow)';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4200);
  }

  function boot(opts) {
    opts = opts || {};
    document.body.classList.add('booting');
    return api('GET', '/api/me').then(function (me) {
      if (opts.roles && opts.roles.indexOf(me.user.role) < 0) { location.replace('/overview.html'); return new Promise(function () {}); }
      renderChrome(me);
      document.body.classList.remove('booting');
      return me;
    });
  }

  window.CA = {
    api: api, boot: boot, esc: esc, icon: icon, fmtDate: fmtDate, shortDate: shortDate, channel: channel, email: email, ago: ago, money: money, words: words,
    pill: pill, outcomeLine: outcomeLine, modal: modal, toast: toast, initials: initials, MARK: MARK,
    REASONS: REASONS, QUEUES: QUEUES, DECISIONS: DECISIONS
  };
})();
