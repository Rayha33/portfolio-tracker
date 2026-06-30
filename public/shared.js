/* shared.js — small API/UI helpers used by the pages.
   This is the single-user build: there are no sessions, so authFetch is just a
   thin fetch wrapper (it never redirects to a login page). */
(function () {
  'use strict';
  if (window.__flSharedLoaded) return;
  window.__flSharedLoaded = true;

  // ── Toast notifications ──────────────────────────────────────────
  window.showToast = function (msg, type) {
    type = type || 'success';
    var el =
      document.getElementById('toast-container') ||
      (function () {
        var c = document.createElement('div');
        c.id = 'toast-container';
        c.style.cssText =
          'position:fixed;bottom:24px;right:24px;display:flex;flex-direction:column;gap:8px;z-index:99999;pointer-events:none;align-items:flex-end';
        document.body.appendChild(c);
        return c;
      })();
    var t = document.createElement('div');
    var colors = { success: 'rgba(39,174,96,0.95)', error: 'rgba(231,76,60,0.95)', warn: 'rgba(243,156,18,0.95)' };
    t.style.cssText = [
      'padding:10px 18px;border-radius:8px;font-size:13px;font-weight:500;',
      'color:#fff;pointer-events:auto;animation:toastIn .25s ease;',
      'background:' + (colors[type] || colors.success) + ';',
      'box-shadow:0 4px 12px rgba(0,0,0,0.3);',
    ].join('');
    t.textContent = msg;
    el.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      t.style.transition = 'opacity .3s';
      setTimeout(function () {
        t.remove();
      }, 300);
    }, 3000);
  };

  // ── fetch wrapper (no auth, no redirect) ─────────────────────────
  window.authFetch = function (url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts);
  };

  // ── Cached GET (opt-in) ──────────────────────────────────────────
  window.cachedFetch = function (url, opts) {
    opts = opts || {};
    var ttl = opts.ttl != null ? opts.ttl : 60000;
    var key = 'flc:' + url;
    try {
      var raw = sessionStorage.getItem(key);
      if (raw) {
        var hit = JSON.parse(raw);
        if (hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.v);
      }
    } catch (e) {}
    return authFetch(url, opts)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (v) {
        try {
          sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v: v }));
        } catch (e) {}
        return v;
      });
  };
  window.clearFetchCache = function (prefix) {
    try {
      for (var i = sessionStorage.length - 1; i >= 0; i--) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf('flc:') === 0 && (!prefix || k.indexOf('flc:' + prefix) === 0)) sessionStorage.removeItem(k);
      }
    } catch (e) {}
  };

  // No login in this build — requireAuth resolves to the local user.
  window.FL_USER = { id: '1', name: 'Local', role: 'admin' };
  window.requireAuth = function () {
    return Promise.resolve({ user: window.FL_USER });
  };

  if (!document.getElementById('toast-anim-style')) {
    var style = document.createElement('style');
    style.id = 'toast-anim-style';
    style.textContent = '@keyframes toastIn{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}';
    document.head.appendChild(style);
  }
})();
