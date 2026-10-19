// Runs before first paint (classic script in <head>) so the page never flashes the wrong theme.
(function () {
  var p = localStorage.getItem('saqme.theme') || 'auto';
  var dark = p === 'dark' || (p === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
