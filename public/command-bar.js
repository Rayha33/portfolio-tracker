/* command-bar.js — no-op stub.
   This build has just two pages, so an optional command palette is omitted.
   The file exists only so the <script src="/command-bar.js"> tags on the pages
   resolve without a 404. */
(function () {
  if (window.__cmdBarStub) return;
  window.__cmdBarStub = true;
  window.openCommandBar = function () {};
  document.addEventListener('open-command-bar', function () {});
})();
