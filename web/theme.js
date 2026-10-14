// Applies the saved theme before the page draws, so it never flashes in the wrong colors.
// 'auto' (default) follows the device. The choice is saved per device.
// Also sets the browser and iPhone status bar color to match.
(function () {
  var BAR = { light: '#EEF1EE', dark: '#0E1311' };
  window.applyTheme = function (t) {
    var root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var forMedia = metas[i].getAttribute('data-scheme');
      metas[i].setAttribute('content', BAR[t === 'light' || t === 'dark' ? t : forMedia]);
    }
  };
  var t = 'auto';
  try { t = localStorage.getItem('hd-theme') || 'auto'; } catch (e) { /* storage blocked */ }
  window.applyTheme(t);
})();
