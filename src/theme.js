// Runs before first paint so the window never flashes the wrong theme.
(function () {
  var params = new URLSearchParams(location.search);
  var pref = params.get('theme') || 'system';
  document.documentElement.dataset.platform = params.get('platform') || 'win32';
  var mq = window.matchMedia('(prefers-color-scheme: light)');
  function apply(p) {
    window.__themePref = p;
    document.documentElement.dataset.theme = p === 'system' ? (mq.matches ? 'light' : 'dark') : p;
  }
  apply(pref);
  mq.addEventListener('change', function () { if (window.__themePref === 'system') apply('system'); });
  window.__applyTheme = apply;
}());
