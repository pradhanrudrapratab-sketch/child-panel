/* Shared browser helpers: DOM builder, API client, theming (default + per-customer accent), header, footer, Minecraft login widget. */
(function () {
  'use strict';
  var IG_URL = 'https://www.instagram.com/mrkrishna.in/';
  var PARENT_FALLBACK = 'https://mkweb-panel.onrender.com';
  var MK = (window.MK = { csrf: null, adminCsrf: null, customer: null, store: null });

  /* ---------- DOM ---------- */
  MK.$ = function (id) { return document.getElementById(id); };
  MK.h = function (tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (p) { n.style.setProperty(p, v[p]); });
      else if (k === 'value') n.value = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) MK.add(n, arguments[i]);
    return n;
  };
  MK.add = function (n, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { MK.add(n, x); });
    else n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  };
  MK.clear = function (n) { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  MK.safeHref = function (u, schemes) { return new RegExp('^(' + (schemes || 'https') + '):', 'i').test(String(u || '')) ? u : null; };

  /* ---------- API ---------- */
  MK.api = function (method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var tok = opts.admin ? MK.adminCsrf : MK.csrf;
    if (method !== 'GET' && tok) headers['X-CSRF-Token'] = tok;
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j.error && j.error.message) || 'Request failed (' + r.status + ')'); e.status = r.status; e.code = j.error && j.error.code; throw e; }
        return j;
      });
    });
  };
  MK.get = function (p, o) { return MK.api('GET', p, undefined, o); };
  MK.post = function (p, b, o) { return MK.api('POST', p, b === undefined ? {} : b, o); };
  MK.put = function (p, b, o) { return MK.api('PUT', p, b, o); };
  MK.del = function (p, o) { return MK.api('DELETE', p, undefined, o); };

  /* ---------- formatting ---------- */
  MK.money = function (p) { var n = Math.abs(p); return (p < 0 ? '-' : '') + '₹' + Math.floor(n / 100).toLocaleString('en-IN') + '.' + String(n % 100).padStart(2, '0'); };
  MK.date = function (ms) { return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '-'; };
  MK.ago = function (ms) {
    if (!ms) return 'never'; var s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
  };
  var GOOD = { DELIVERED: 1, SUCCESS: 1, PAID: 1, ACTIVE: 1, OK: 1 }; var BAD = { FAILED: 1, CANCELLED: 1, EXPIRED: 1, REVOKED: 1, SUSPENDED: 1, AUTH_ERROR: 1 }; var WARN = { PENDING: 1, SCHEDULED: 1, CREATED: 1, NOT_APPLICABLE: 0 };
  MK.pill = function (s) {
    var k = String(s || '').toUpperCase(); var c = GOOD[k] ? 'good' : BAD[k] ? 'bad' : WARN[k] ? 'warn' : 'info';
    return MK.h('span', { class: 'pill ' + c, text: k.replace(/_/g, ' ') });
  };
  MK.toast = function (msg) {
    var t = MK.$('toast'); if (!t) { t = MK.h('div', { class: 'toast', id: 'toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show'); clearTimeout(MK._tt); MK._tt = setTimeout(function () { t.classList.remove('show'); }, 3200);
  };
  MK.copy = function (text, label) {
    var done = function () { MK.toast((label || 'Copied') + ' ✓'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { MK.toast('Copy failed'); }); else MK.toast('Copy not supported');
  };
  MK.mcHead = function (name) {
    var n = /^[A-Za-z0-9_]{3,16}$/.test(name || '') ? name : 'Steve';
    return 'https://mc-heads.net/avatar/' + encodeURIComponent(n) + '/64';   // built from a validated username only
  };

  /* ---------- theme ---------- */
  MK.onColour = function (hex) {
    var h = String(hex || '').replace('#', ''); var n = parseInt(h, 16); if (!isFinite(n)) return '#0a0a0c';
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#0a0a0c' : '#ffffff';
  };
  MK.shift = function (hex) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2, hh = 0, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d) { hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
    hh = (hh + 30) % 360; var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = l - c / 2, t;
    t = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    return '#' + t.map(function (v) { return Math.round((v + m) * 255).toString(16).padStart(2, '0'); }).join('');
  };
  MK.applyAccent = function (accent, accent2) {
    var r = document.documentElement.style; accent2 = accent2 || MK.shift(accent);
    r.setProperty('--accent', accent); r.setProperty('--accent2', accent2); r.setProperty('--on-accent', MK.onColour(accent));
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', accent);
  };
  MK.applyTheme = function () {
    var c = MK.customer && MK.customer.accent;
    if (c) MK.applyAccent(c);                                  // customer's own preference
    else if (MK.store) MK.applyAccent(MK.store.defaultColour.accent, MK.store.defaultColour.accent2);   // owner's store default
  };
  MK.setFavicon = function (url) {
    var l = document.querySelector('link[rel="icon"]'); if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); }
    l.href = url || '/img/favicon.svg';
  };

  /* ---------- shell: header / footer ---------- */
  function brandNode(store) {
    var a = MK.h('a', { class: 'brand', href: '/', 'aria-label': 'Home' });
    var src = store.logo || store.icon;
    if (src) { var img = MK.h('img', { class: 'logo', alt: '', src: src }); img.addEventListener('error', function () { img.remove(); }); a.appendChild(img); }
    else a.appendChild(MK.h('span', { class: 'logo-fallback', text: (store.name || 'S').charAt(0).toUpperCase() }));
    a.appendChild(MK.h('span', { text: store.name }));
    return a;
  }
  MK.renderHeader = function (active) {
    var s = MK.store, c = MK.customer, host = MK.$('app-header'); if (!host) return;
    var nav = MK.h('nav', { 'aria-label': 'Main' },
      MK.h('a', { href: '/', 'aria-current': active === 'store' ? 'page' : null, text: 'Store' }),
      c ? MK.h('a', { href: '/account', 'aria-current': active === 'account' ? 'page' : null, text: 'Account' }) : null);
    var tools = MK.h('div', { class: 'top-tools' });
    if (s.mcHost) {
      var ip = s.mcHost + (s.mcPort && s.mcPort !== 25565 ? ':' + s.mcPort : '');
      tools.appendChild(MK.h('button', { class: 'mini-copy', type: 'button', onclick: function () { MK.copy(ip, 'Server IP copied'); } }, MK.h('span', { text: ip }), MK.h('b', { text: 'Copy' })));
    }
    if (c) {
      tools.appendChild(MK.h('a', { class: 'wallet-chip', href: '/account#wallet', title: 'Wallet balance', text: MK.money(c.balancePaise) }));
      var name = c.minecraft ? c.minecraft.username : (c.discord && (c.discord.name || c.discord.username)) || 'Account';
      var head = c.minecraft ? MK.h('img', { class: 'user-head', alt: '', src: MK.mcHead(c.minecraft.username) }) : (c.discord && c.discord.avatar ? MK.h('img', { class: 'user-head', alt: '', src: c.discord.avatar }) : null);
      tools.appendChild(MK.h('a', { class: 'user-chip', href: '/account', style: { 'text-decoration': 'none' }, 'aria-label': 'My account' }, head, MK.h('span', { text: name })));
    } else tools.appendChild(MK.h('a', { class: 'user-chip', href: '/login', style: { 'text-decoration': 'none' } }, MK.h('span', { text: 'Sign in' })));
    var header = MK.h('header', { class: 'top' }, brandNode(s), nav, tools);
    MK.clear(host).appendChild(header);
  };
  MK.renderFooter = function () {
    var s = MK.store, host = MK.$('app-footer'); if (!host) return;
    var parent = MK.safeHref(s && s.mainUrl) || PARENT_FALLBACK;
    var links = MK.h('nav', { class: 'footer-links', 'aria-label': 'Footer' },
      s && s.discordInvite ? MK.h('a', { href: s.discordInvite, target: '_blank', rel: 'noopener noreferrer', text: 'Discord' }) : null,
      s && s.website ? MK.h('a', { href: s.website, target: '_blank', rel: 'noopener noreferrer', text: 'Website' }) : null,
      MK.h('a', { href: '/', text: 'Store' }), MK.h('a', { href: '/account', text: 'Account' }));
    var footer = MK.h('footer', { class: 'site-footer' }, MK.h('div', { class: 'footer-inner' },
      MK.h('div', { class: 'footer-brand' }, MK.h('p', { class: 'footer-kicker', text: 'Minecraft server' }), MK.h('h2', { class: 'footer-name', text: (s && s.name) || '' }), MK.h('p', { class: 'footer-note', text: (s && s.description) || '' })),
      MK.h('div', { class: 'footer-meta' }, links,
        MK.h('div', { class: 'foot-cta' },
          MK.h('a', { class: 'btn sm', id: 'createStoreBtn', href: parent, target: '_blank', rel: 'noopener noreferrer', text: 'Create your own webstore' })),
        MK.h('p', { class: 'footer-copy' }, MK.h('a', { id: 'copyrightLink', href: IG_URL, target: '_blank', rel: 'noopener noreferrer', text: '© All rights reserved by @mrkrishna.in' })))));
    MK.clear(host).appendChild(footer);
  };

  /* ---------- modal (uses the reference checkout dialog styles) ---------- */
  MK.modal = function (title, body, opts) {
    opts = opts || {};
    var close = function () { ov.remove(); document.removeEventListener('keydown', esc); if (opts.onClose) opts.onClose(); };
    var esc = function (e) { if (e.key === 'Escape') close(); };
    var ov = MK.h('div', { class: 'checkout' }, MK.h('div', { class: 'checkout-panel' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      MK.h('div', { class: 'checkout-head' }, MK.h('h2', { text: title }), MK.h('button', { class: 'checkout-close', type: 'button', 'aria-label': 'Close', onclick: close, text: '✕' })), body));
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', esc); document.body.appendChild(ov);
    return { close: close, el: ov };
  };

  /* ---------- Minecraft login / link widget ---------- */
  MK.mcChallenge = function (host, onDone) {
    var input = MK.h('input', { type: 'text', maxlength: 16, placeholder: 'Your Minecraft username', autocomplete: 'off', spellcheck: 'false' });
    var out = MK.h('div'); var timer = null, poll = null;
    var go = MK.h('button', { class: 'btn', type: 'button', text: 'Get login command' });
    function stop() { clearInterval(timer); clearInterval(poll); }
    function start() {
      var u = input.value.trim(); go.disabled = true; MK.clear(out);
      MK.post('/api/auth/minecraft/start', { username: u }).then(function (ch) {
        var left = MK.h('span', { class: 'muted small' });
        var tick = function () { var s = Math.max(0, Math.floor((ch.expiresAt - Date.now()) / 1000)); left.textContent = 'Expires in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); if (!s) { stop(); MK.clear(out).appendChild(MK.h('div', { class: 'alert warn', text: 'The command expired. Request a new one.' })); } };
        tick(); timer = setInterval(tick, 1000);
        MK.clear(out).appendChild(MK.h('div', { class: 'stack' },
          MK.h('p', { class: 'muted', text: 'Join the Minecraft server and run this command in chat:' }),
          MK.h('div', { class: 'cmd' }, MK.h('code', { text: ch.command }), MK.h('button', { class: 'btn ghost sm', type: 'button', text: 'Copy', onclick: function () { MK.copy(ch.command, 'Command copied'); } })),
          MK.h('p', { class: 'small muted', text: 'Waiting for the server to confirm… this page continues automatically.' }), left));
        poll = setInterval(function () {
          MK.get('/api/auth/minecraft/status?id=' + ch.id).then(function (s) {
            if (s.csrf) MK.csrf = s.csrf;
            if (s.status === 'COMPLETED') { stop(); MK.clear(out).appendChild(MK.h('div', { class: 'alert good', text: 'Verified! ✓' })); onDone(); }
            else if (s.status === 'FAILED' || s.status === 'EXPIRED') { stop(); MK.clear(out).appendChild(MK.h('div', { class: 'alert bad', text: s.reason === 'claimed' ? 'That Minecraft account belongs to another customer.' : 'This login request is no longer valid. Try again.' })); }
          }).catch(function () { /* keep polling */ });
        }, 2500);
      }).catch(function (e) { MK.clear(out).appendChild(MK.h('div', { class: 'alert bad', text: e.message })); }).then(function () { go.disabled = false; });
    }
    go.addEventListener('click', function () { stop(); start(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { stop(); start(); } });
    MK.add(host, MK.h('div', { class: 'stack' }, MK.h('div', { class: 'field' }, MK.h('label', { text: 'Minecraft username' }), input), go, out));
  };

  /* ---------- boot ---------- */
  MK.init = function (active, opts) {
    opts = opts || {};
    return MK.get('/api/session').then(function (s) {
      MK.csrf = s.csrf; MK.customer = s.customer;
      return MK.get('/api/store');
    }).then(function (d) {
      MK.store = d.store; MK.catalog = d;
      document.title = (opts.title ? opts.title + ' – ' : '') + d.store.name;
      MK.setFavicon(d.store.favicon || d.store.icon);
      MK.applyTheme(); MK.renderHeader(active); MK.renderFooter();
      return d;
    }).catch(function (e) {
      if (e.status === 503 && e.code === 'not_configured') { location.href = '/setup'; return; }
      var m = MK.$('main'); if (m) MK.add(MK.clear(m), MK.h('div', { class: 'wrap' }, MK.h('div', { class: 'alert bad', text: 'Could not load the store: ' + e.message })));
    });
  };
})();
