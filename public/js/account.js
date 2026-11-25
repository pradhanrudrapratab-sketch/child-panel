(function () {
  'use strict';
  var h = MK.h; var root; var tab = 'profile';
  var TABS = [['profile', 'Profile'], ['wallet', 'Wallet'], ['orders', 'Orders'], ['settings', 'Appearance']];

  function refreshMe() { return MK.get('/api/me').then(function (r) { MK.customer = r.customer; MK.applyTheme(); MK.renderHeader('account'); return r.customer; }); }
  function err(e) { MK.toast(e.message); }

  /* ---------- profile ---------- */
  function profile(c) {
    var d = h('div', { class: 'panel stack' }, h('h2', { text: 'Discord' }));
    if (c.discord) d.appendChild(h('div', { class: 'row' }, c.discord.avatar ? h('img', { class: 'avatar', alt: '', src: c.discord.avatar }) : h('div', { class: 'avatar' }), h('div', null, h('b', { text: c.discord.name || c.discord.username }), h('div', { class: 'muted small', text: '@' + c.discord.username + ' · ID ' + c.discord.id }))));
    else d.appendChild(h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'Link Discord so you can always get back into this account.' }),
      MK.store.discordLogin ? h('a', { class: 'btn sm', href: '/auth/discord?link=1', text: 'Link Discord' }) : h('div', { class: 'alert', text: 'Discord login is not enabled by the store owner.' })));
    var m = h('div', { class: 'panel stack' }, h('h2', { text: 'Minecraft' }));
    if (c.minecraft) {
      m.appendChild(h('div', { class: 'row' }, h('img', { class: 'head-mc', alt: '', src: MK.mcHead(c.minecraft.username) }), h('div', { class: 'grow' }, h('b', { text: c.minecraft.username }), h('div', { class: 'muted small', text: 'Verified in-game · linked ' + MK.date(c.minecraft.linkedAt) }))));
      m.appendChild(h('p', { class: 'muted small', text: 'Purchases are delivered to this account.' }));
      var b = h('button', { class: 'btn ghost sm', type: 'button', text: 'Disconnect Minecraft', onclick: function () {
        if (!c.discord) { MK.toast('Link Discord first - otherwise you could not log in again.'); return; }
        if (!confirm('Disconnect ' + c.minecraft.username + '? You can re-verify any time.')) return;
        MK.del('/api/me/minecraft').then(refreshMe).then(show).catch(err);
      } });
      m.appendChild(b);
    } else if (!MK.store.serverConnected) m.appendChild(h('div', { class: 'alert warn', text: 'The Minecraft server is not connected yet.' }));
    else { m.appendChild(h('p', { class: 'muted', text: 'Verify your in-game account to receive purchases.' })); MK.mcChallenge(m, function () { refreshMe().then(function () { MK.toast('Minecraft verified ✓'); show(); }); }); }
    return h('div', { class: 'grid2' }, d, m);
  }

  /* ---------- payment dialog ---------- */
  function openPayment(id, onChange) {
    var body = h('div', { class: 'stack' }); var timer = null, auto = null, modal;
    function stop() { clearInterval(timer); clearInterval(auto); }
    function qrNode(d) {
      var q = d.qrData || d.paymentLink; if (!q) return null;
      if (/^data:image\/(png|svg\+xml|jpeg);base64,/i.test(q)) return h('div', { class: 'qr' }, h('img', { src: q, width: 220, height: 220, alt: 'Payment QR' }));
      try { var w = h('div', { class: 'qr' }); w.appendChild(QR.toSvg(q, 220)); return w; } catch (e) { return null; }
    }
    function check(manual) {
      return MK.post('/api/me/deposits/' + id + '/check').then(function (r) {
        if (r.deposit.credited) { MK.customer.balancePaise = r.balancePaise; MK.renderHeader('account'); onChange(); }
        paint(r.deposit, manual); return r;
      }).catch(function (e) { if (manual) MK.toast(e.message); });
    }
    function paint(d, manual) {
      stop(); MK.clear(body);
      body.appendChild(h('div', { class: 'row' }, h('b', { text: 'Deposit ' + d.id }), MK.pill(d.expired && d.status === 'PENDING' ? 'EXPIRED' : d.status)));
      if (d.status === 'SUCCESS') { body.appendChild(h('div', { class: 'alert good', text: MK.money(d.amountPaise) + ' was added to your wallet ✓' })); return; }
      if (d.status === 'FAILED') { body.appendChild(h('div', { class: 'alert bad', text: d.error || 'This payment failed.' })); return; }
      if (d.status === 'EXPIRED') { body.appendChild(h('div', { class: 'alert warn', text: 'This payment request expired. If you already paid, press Check payment - otherwise start a new deposit.' })); body.appendChild(h('button', { class: 'btn ghost sm', type: 'button', text: 'Check payment', onclick: function () { check(true); } })); return; }
      if (d.canStart) {
        body.appendChild(h('p', { class: 'muted', text: 'You will have 10 minutes to pay after you start. The exact amount to pay will be shown on the next screen.' }));
        body.appendChild(h('button', { class: 'btn', type: 'button', text: 'Start payment', onclick: function (e) { e.target.disabled = true; MK.post('/api/me/deposits/' + id + '/start').then(function (r) { paint(r.deposit); }).catch(function (x) { MK.toast(x.message); e.target.disabled = false; }); } }));
        return;
      }
      body.appendChild(h('div', { class: 'checkout-total' }, h('span', { class: 'label', text: 'Pay exactly' }), h('b', { text: MK.money(d.payAmountPaise) }), h('span', { text: 'INR' })));
      if (d.payAmountPaise !== d.amountPaise) body.appendChild(h('p', { class: 'muted small', text: 'You will receive ' + MK.money(d.amountPaise) + ' in your wallet. The extra paise identify your payment.' }));
      if (d.expired) body.appendChild(h('div', { class: 'alert warn', text: 'The payment window has ended. Press Check payment if you already paid.' }));
      else { var q = qrNode(d); if (q) body.appendChild(q); }
      if (!d.expired) {
        if (d.upiId) body.appendChild(h('div', { class: 'cmd' }, h('code', { text: d.upiId }), h('button', { class: 'btn ghost sm', type: 'button', text: 'Copy UPI ID', onclick: function () { MK.copy(d.upiId, 'UPI ID copied'); } })));
        var href = MK.safeHref(d.paymentLink, 'upi|https'); if (href) body.appendChild(h('a', { class: 'btn', href: href, rel: 'noopener', text: 'Open in UPI app' }));
        var left = h('p', { class: 'muted small' }); body.appendChild(left);
        var tick = function () { var s = Math.max(0, Math.floor(((d.expiresAt || 0) - Date.now()) / 1000)); left.textContent = d.expiresAt ? 'Time left: ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : ''; if (d.expiresAt && !s) { stop(); check(false).then(function (r) { if (r && r.deposit.status === 'PENDING') paint(Object.assign({}, r.deposit, { expired: true })); }); } };
        tick(); timer = setInterval(tick, 1000);
        auto = setInterval(function () { check(false); }, 20000);
      }
      body.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: 'Check payment', onclick: function (e) { var b = e.target; b.disabled = true; check(true).then(function (r) { b.disabled = false; if (r && r.deposit.status === 'PENDING') MK.toast('Not received yet - it can take a minute after paying.'); }); } })));
      body.appendChild(h('p', { class: 'checkout-note', text: 'Closing this window is safe. Reopen it from Transaction history any time.' }));
    }
    modal = MK.modal('Wallet deposit', body, { onClose: stop });
    MK.get('/api/me/deposits/' + id).then(function (r) { paint(r.deposit); }).catch(function (e) { MK.clear(body).appendChild(h('div', { class: 'alert bad', text: e.message })); });
  }

  /* ---------- wallet ---------- */
  function wallet(c) {
    var amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Amount in ₹', maxlength: 9, autocomplete: 'off' });
    var go = h('button', { class: 'btn', type: 'button', text: 'Add funds' });
    var hist = h('div'); var s = MK.store;
    function credited() { refreshMe().then(show); }   // balance card + header update as soon as a deposit is credited
    function addFunds() {
      go.disabled = true;
      MK.post('/api/me/deposits', { amount: amount.value.trim() }).then(function (r) { amount.value = ''; openPayment(r.deposit.id, credited); loadHist(); }).catch(err).then(function () { go.disabled = false; });
    }
    go.addEventListener('click', addFunds); amount.addEventListener('keydown', function (e) { if (e.key === 'Enter') addFunds(); });
    var chips = h('div', { class: 'tag-row' }, [50, 100, 250, 500, 1000].map(function (v) { return h('button', { class: 'btn ghost sm', type: 'button', text: '₹' + v, onclick: function () { amount.value = String(v); } }); }));
    function loadHist() {
      MK.get('/api/me/transactions').then(function (r) {
        MK.clear(hist);
        if (!r.transactions.length) { hist.appendChild(h('div', { class: 'empty', text: 'No transactions yet.' })); return; }
        var rows = r.transactions.map(function (t) {
          var isDep = t.kind === 'deposit'; var open = isDep && t.status === 'PENDING';
          var tr = h('tr', { class: open ? 'click' : null },
            h('td', { text: MK.date(t.at) }),
            h('td', { text: isDep ? 'Deposit ' + t.id : (t.type === 'PURCHASE' ? 'Purchase' : 'Adjustment') + (t.note ? ' - ' + t.note : '') }),
            h('td', { class: 'num ' + (isDep || t.amountPaise > 0 ? 'pos' : 'neg'), text: (isDep ? '+' : t.amountPaise > 0 ? '+' : '') + MK.money(isDep ? t.amountPaise : t.amountPaise) }),
            h('td', null, isDep ? MK.pill(t.expired && t.status === 'PENDING' ? 'EXPIRED' : t.status) : MK.pill('DONE')),
            h('td', null, open ? h('button', { class: 'btn ghost sm', type: 'button', text: 'Open payment' }) : null));
          if (open) tr.addEventListener('click', function () { openPayment(t.id, credited); });
          return tr;
        });
        hist.appendChild(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Date', 'Details', 'Amount', 'Status', ''].map(function (x, i) { return h('th', { class: i === 2 ? 'num' : null, text: x }); }))), h('tbody', null, rows))));
      }).catch(err);
    }
    loadHist();
    return h('div', { class: 'stack' },
      h('div', { class: 'grid2' },
        h('div', { class: 'panel stack' }, h('span', { class: 'muted small', text: 'WALLET BALANCE' }), h('div', { class: 'balance', text: MK.money(c.balancePaise) }), h('p', { class: 'muted small', text: 'Spend it on anything in the store. Deposits are verified automatically.' })),
        h('div', { class: 'panel stack' }, h('h2', { text: 'Add funds' }), s.paymentsBlocked ? h('div', { class: 'alert warn', text: 'Payments are temporarily unavailable.' }) : null,
          h('div', { class: 'field' }, h('label', { text: 'Amount (₹' + (s.minDepositPaise / 100) + ' – ₹' + (s.maxDepositPaise / 100).toLocaleString('en-IN') + ')' }), amount), chips, go)),
      h('div', { class: 'panel stack' }, h('h2', { text: 'Transaction history' }), hist));
  }

  /* ---------- orders ---------- */
  function orders() {
    var host = h('div', { class: 'panel stack' }, h('h2', { text: 'Order history' }));
    MK.get('/api/me/orders').then(function (r) {
      if (!r.orders.length) { host.appendChild(h('div', { class: 'empty', text: 'No orders yet. Head to the store!' })); return; }
      host.appendChild(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Order', 'Item', 'Amount', 'Delivery', 'Date'].map(function (x, i) { return h('th', { class: i === 2 ? 'num' : null, text: x }); }))),
        h('tbody', null, r.orders.map(function (o) {
          var tr = h('tr', { class: 'click' }, h('td', { class: 'mono', text: o.id }), h('td', { text: o.product + (o.quantity > 1 ? ' ×' + o.quantity : '') }), h('td', { class: 'num', text: o.amountPaise ? MK.money(o.amountPaise) : 'Free' }),
            h('td', null, MK.pill(o.deliveryStatus), h('span', { class: 'muted small', text: ' ' + o.progress.delivered + '/' + o.progress.total })), h('td', { text: MK.date(o.createdAt) }));
          tr.addEventListener('click', function () { orderDetail(o.id); }); return tr;
        })))));
    }).catch(err);
    return host;
  }
  function orderDetail(id) {
    var body = h('div', { class: 'stack' });
    MK.get('/api/me/orders/' + id).then(function (r) {
      var o = r.order;
      body.appendChild(h('div', { class: 'row' }, h('b', { text: o.product }), MK.pill(o.deliveryStatus), h('span', { class: 'muted small', text: o.id })));
      body.appendChild(h('p', { class: 'muted small', text: 'Delivered to ' + o.minecraft + ' · ' + MK.date(o.createdAt) + ' · ' + (o.amountPaise ? MK.money(o.amountPaise) : 'free') }));
      body.appendChild(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Reward', 'Status', 'Updated'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, o.tasks.map(function (t) { return h('tr', null, h('td', { text: t.label }), h('td', null, MK.pill(t.status)), h('td', { text: MK.date(t.deliveredAt || t.receivedAt || t.fetchedAt) })); })))));
      body.appendChild(h('p', { class: 'checkout-note', text: 'Rewards are applied by the server. If you are offline they are delivered when the server next syncs.' }));
    }).catch(function (e) { body.appendChild(h('div', { class: 'alert bad', text: e.message })); });
    MK.modal('Order ' + id, body);
  }

  /* ---------- appearance ---------- */
  var PAL = { red: '#ff3b3b', orange: '#f97316', gold: '#eab308', lime: '#a3e635', green: '#22c55e', teal: '#14b8a6', cyan: '#22d3ee', blue: '#3b82ff', indigo: '#6366f1', purple: '#a855f7', magenta: '#d946ef', pink: '#ec4899', slate: '#94a3b8', white: '#f2f2f2' };
  function appearance(c) {
    var picker = h('input', { type: 'color', value: c.accent || MK.store.defaultColour.accent });
    function save(hex) {
      MK.put('/api/me/accent', { color: hex }).then(function () { MK.customer.accent = hex; MK.applyTheme(); MK.toast(hex ? 'Colour saved ✓' : 'Back to the store default'); show(); }).catch(err);
    }
    var sw = h('div', { class: 'swatches' }, Object.keys(PAL).map(function (k) { return h('button', { class: 'swatch', type: 'button', title: k, 'aria-label': k, 'aria-pressed': c.accent === PAL[k] ? 'true' : 'false', style: { background: PAL[k] }, onclick: function () { save(PAL[k]); } }); }));
    return h('div', { class: 'panel stack' }, h('h2', { text: 'Your accent colour' }), h('p', { class: 'sub', text: 'Pick the colour you want the store to use for you. It is saved to your profile and never changes what other players see.' }), sw,
      h('div', { class: 'row' }, h('div', { class: 'field grow', style: { 'margin-bottom': '0' } }, h('label', { text: 'Custom colour' }), picker), h('button', { class: 'btn', type: 'button', text: 'Save custom', onclick: function () { save(picker.value); } }), h('button', { class: 'btn ghost', type: 'button', text: 'Restore default', onclick: function () { save(null); } })));
  }

  function show() {
    var c = MK.customer; MK.clear(root);
    var who = c.minecraft ? c.minecraft.username : (c.discord && (c.discord.name || c.discord.username)) || 'Account';
    root.appendChild(h('div', { class: 'page-title' }, h('h1', { text: 'Hi, ' + who }), h('button', { class: 'btn ghost sm', type: 'button', text: 'Log out', onclick: function () { MK.post('/api/auth/logout').then(function () { location.href = '/'; }); } })));
    root.appendChild(h('div', { class: 'tabs' }, TABS.map(function (t) { return h('button', { type: 'button', 'aria-pressed': tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { tab = t[0]; history.replaceState(null, '', '#' + tab); show(); } }); })));
    root.appendChild(tab === 'wallet' ? wallet(c) : tab === 'orders' ? orders() : tab === 'settings' ? appearance(c) : profile(c));
  }

  MK.init('account', { title: 'My account' }).then(function (d) {
    if (!d) return;
    if (!MK.customer) { location.href = '/login'; return; }
    root = MK.$('accountRoot');
    var hsh = location.hash.replace('#', ''); if (TABS.some(function (t) { return t[0] === hsh; })) tab = hsh;
    show();
  });
})();
