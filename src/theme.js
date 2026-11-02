// Runs before first paint so the window never flashes the wrong theme.
(function () {
  var pref = new URLSearchParams(location.search).get('theme') || 'system';
  var mq = window.matchMedia('(prefers-color-scheme: light)');
  function apply(p) {
    window.__themePref = p;
    document.documentElement.dataset.theme = p === 'system' ? (mq.matches ? 'light' : 'dark') : p;
  }
  apply(pref);
  mq.addEventListener('change', function () { if (window.__themePref === 'system') apply('system'); });
  window.__applyTheme = apply;
}());
