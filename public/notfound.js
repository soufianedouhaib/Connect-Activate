/* Shown for any address the console does not have. Keeps the menu so people can carry on. */
(function () {
  'use strict';
  var esc = CA.esc, icon = CA.icon;
  CA.boot().then(function (me) {
    var path = location.pathname + location.search;
    var home = me.user.role === 'desk' ? '/desk.html' : '/overview.html';
    document.getElementById('app').innerHTML =
      '<div class="page-head"><div><h1>Page not found</h1><p>There is no page at <span class="code-chip">' + esc(path.length > 60 ? path.slice(0, 57) + '…' : path) + '</span>. It may have been moved, or the link was mistyped.</p></div></div>' +
      '<section class="card"><div class="toolbar">' +
      '<a class="btn primary" href="' + home + '">' + icon('home') + (me.user.role === 'desk' ? 'Go to the Fallout desk' : 'Go to the overview') + '</a>' +
      '<a class="btn" href="/">' + icon('list') + 'All orders</a>' +
      '</div><p class="small muted" style="margin-top:14px">Looking for an order? Search for its number on the Orders page.</p></section>';
    document.title = 'Page not found · Connect & Activate';
  });
})();
