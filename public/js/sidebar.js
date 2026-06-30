/**
 * sidebar.js — navigation chrome for the Portfolio Tracker.
 *
 * A small, single-app navigation sidebar: it renders the .sidebar / .topbar DOM
 * that layout.css + theme.css style, with the nav limited to the two pages —
 * Current Portfolio and Realized — and no accounts, billing, or command palette.
 */
(function () {
  // Load the shared API/UI helpers (showToast, authFetch, …) once.
  if (!window.__flSharedLoaded && !document.querySelector('script[src*="shared.js"]')) {
    var s = document.createElement('script');
    s.src = '/shared.js';
    (document.head || document.documentElement).appendChild(s);
  }

  var NAV = [
    {
      label: 'My Portfolio',
      id: 'portfolioGroup',
      icon: '<svg viewBox="0 0 24 24"><path d="M21 12V7H5a2 2 0 010-4h14v4"/><path d="M3 5v14a2 2 0 002 2h16v-5"/><path d="M18 12a2 2 0 00-2 2c0 1.1.9 2 2 2h4v-4h-4z"/></svg>',
      children: [
        {
          label: 'Current Portfolio',
          href: 'portfolio.html',
          icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2m-9-11h2m18 0h2m-3.3-6.7l-1.4 1.4M6.7 17.3l-1.4 1.4m0-13.4l1.4 1.4m10.6 10.6l1.4 1.4"/></svg>',
        },
        {
          label: 'Realized',
          href: 'track-record.html',
          icon: '<svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
        },
      ],
    },
  ];

  function currentPage() {
    return (window.location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  }
  function isActive(href, cur) {
    return String(href).replace(/\.html$/, '') === cur;
  }

  function buildSidebar(cur) {
    var html = '<aside class="sidebar">';
    html += '<div class="sidebar-logo">';
    html += '<a href="portfolio.html" style="color:inherit;text-decoration:none">';
    html += '<span class="sidebar-logo-text">Portfolio<span style="color:var(--accent)">Tracker</span></span>';
    html += '</a>';
    html += '<button class="sidebar-toggle" id="sidebarToggle" title="Collapse sidebar">';
    html += '<svg viewBox="0 0 24 24"><path d="M11 19l-7-7 7-7"/><path d="M18 19l-7-7 7-7" opacity="0.4"/></svg>';
    html += '</button>';
    html += '</div>';

    html += '<nav class="sidebar-nav">';
    NAV.forEach(function (item) {
      html += '<div class="sidebar-group open" id="' + item.id + '">';
      html += '<button class="sidebar-link sidebar-group-toggle"';
      html += " onclick=\"event.preventDefault();event.stopPropagation();toggleSidebarGroup('" + item.id + "')\">";
      html += '<svg class="sidebar-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
      html += item.icon + item.label + '</button>';
      html += '<div class="sidebar-sub-links">';
      item.children.forEach(function (child) {
        var active = isActive(child.href, cur) ? ' active' : '';
        html += '<a href="' + child.href + '" class="sidebar-link sidebar-sub-link' + active + '">' + child.icon + child.label + '</a>';
      });
      html += '</div></div>';
    });
    html += '</nav>';

    html += '<div class="sidebar-footer">';
    html += '<div class="sidebar-user" style="cursor:default">';
    html += '<div class="sidebar-avatar">★</div>';
    html += '<div class="sidebar-user-info"><div class="sidebar-user-name">Local portfolio</div></div>';
    html += '</div></div>';

    html += '</aside>';
    return html;
  }

  function buildMobileNav(cur) {
    var html = '<div class="mobile-nav-overlay" id="mobileNavOverlay">';
    NAV[0].children.forEach(function (child) {
      html += '<a href="' + child.href + '">' + child.icon + child.label + '</a>';
    });
    html += '</div>';
    return html;
  }

  var themeIcons = {
    dark: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
    light: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  };

  function buildTopbar() {
    var theme = localStorage.getItem('fl-theme') || 'dark';
    var html = '<div class="topbar">';
    html += '<button class="mobile-hamburger" id="mobileHamburger" aria-label="Toggle menu" onclick="toggleMobileNav()"><span></span><span></span><span></span></button>';
    html += '<div style="flex:1"></div>';
    html += '<div class="topbar-right">';
    html += '<button class="btn-customize" onclick="toggleTheme()" id="themeBtn" title="Toggle theme" style="display:inline-flex;align-items:center;justify-content:center;min-width:32px;padding:6px">' + (themeIcons[theme] || themeIcons.dark) + '</button>';
    html += '</div></div>';
    return html;
  }

  function render() {
    var cur = currentPage();
    var existing = document.querySelector('.sidebar');
    if (existing) existing.outerHTML = buildSidebar(cur);
    else {
      var anchor = document.querySelector('.main, .fl-main') || document.body.firstElementChild;
      if (anchor && anchor.parentNode) anchor.insertAdjacentHTML('beforebegin', buildSidebar(cur));
      else document.body.insertAdjacentHTML('afterbegin', buildSidebar(cur));
    }
    document.querySelectorAll('.mobile-nav-overlay').forEach(function (el) {
      el.remove();
    });
    document.body.insertAdjacentHTML('beforeend', buildMobileNav(cur));

    var main = document.querySelector('.main, .fl-main');
    if (main && !main.querySelector('.topbar')) {
      var wrap = document.createElement('div');
      wrap.innerHTML = buildTopbar();
      main.insertBefore(wrap.firstChild, main.firstChild);
    }
  }

  // ── Globals referenced by inline onclick handlers ──────────────────
  window.toggleSidebarGroup = function (id) {
    var g = document.getElementById(id);
    if (g) g.classList.toggle('open');
  };
  window.toggleMobileNav = function () {
    var o = document.getElementById('mobileNavOverlay');
    if (o) o.classList.toggle('open');
  };
  window.toggleTheme = function () {
    var html = document.documentElement;
    var next = (html.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('fl-theme', next);
    var btn = document.getElementById('themeBtn');
    if (btn) btn.innerHTML = themeIcons[next] || themeIcons.dark;
  };
  window.flLogout = function () {}; // no sessions in this build

  function initCollapse() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    if (localStorage.getItem('fl-sidebar-collapsed') === 'true') {
      sidebar.classList.add('collapsed');
      document.documentElement.classList.add('fl-sidebar-collapsed');
    }
    var btn = document.getElementById('sidebarToggle');
    if (btn)
      btn.addEventListener('click', function () {
        sidebar.classList.toggle('collapsed');
        var c = sidebar.classList.contains('collapsed');
        localStorage.setItem('fl-sidebar-collapsed', c);
        document.documentElement.classList.toggle('fl-sidebar-collapsed', c);
      });
  }

  // Apply saved theme before paint to avoid a flash.
  document.documentElement.setAttribute('data-theme', localStorage.getItem('fl-theme') || 'dark');

  function init() {
    render();
    initCollapse();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
